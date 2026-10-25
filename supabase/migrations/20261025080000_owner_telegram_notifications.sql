-- Owner alerts switch to Telegram; player confirmation emails are unaffected.
-- Retire the email endpoint and allow in-flight invocations to drain before applying.
drop trigger if exists queue_owner_email_booking on public.bookings;
drop trigger if exists queue_owner_email_open_play on public.open_play_registrations;
update public.owner_email_preferences set enabled=false where enabled;
update public.owner_email_notifications set status='skipped',lease_token=null,locked_until=null,
 last_error='Owner alerts moved to Telegram.' where status in ('queued','sending');
revoke insert,update on public.owner_email_preferences from authenticated;
revoke insert(user_id,emails,enabled,notify_new,notify_pending),
 update(user_id,emails,enabled,notify_new,notify_pending) on public.owner_email_preferences from authenticated;
alter table public.bookings add column if not exists automatic_confirmation_source text;
alter table public.open_play_registrations add column if not exists automatic_confirmation_source text;
-- Only trusted payment functions may attach a PayMongo confirmation marker.
create or replace function public.guard_automatic_confirmation_source()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if current_user in ('anon','authenticated') then
   if tg_op='INSERT' then new.automatic_confirmation_source:=null;
   else new.automatic_confirmation_source:=old.automatic_confirmation_source; end if;
 end if;
 return new;
end;
$$;
revoke all on function public.guard_automatic_confirmation_source() from public,anon,authenticated;
create trigger guard_automatic_confirmation_source before insert or update on public.bookings
 for each row execute function public.guard_automatic_confirmation_source();
create trigger guard_automatic_confirmation_source before insert or update on public.open_play_registrations
 for each row execute function public.guard_automatic_confirmation_source();
create table public.owner_telegram_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 chat_id text not null default '' check (chat_id='' or chat_id ~ '^-?[1-9][0-9]{0,19}$'),
 enabled boolean not null default false,
 notify_auto_confirmed boolean not null default true,
 notify_pending boolean not null default true,
 last_test_at timestamptz,
 updated_at timestamptz not null default now(),
 check (not enabled or (chat_id<>'' and (notify_auto_confirmed or notify_pending)))
);
create unique index owner_telegram_enabled_chat on public.owner_telegram_preferences(chat_id) where enabled;
alter table public.owner_telegram_preferences enable row level security;
revoke all on public.owner_telegram_preferences from public,anon,authenticated;
grant select on public.owner_telegram_preferences to authenticated;
grant insert(user_id,chat_id,enabled,notify_auto_confirmed,notify_pending),
 update(user_id,chat_id,enabled,notify_auto_confirmed,notify_pending)
 on public.owner_telegram_preferences to authenticated;
grant all on public.owner_telegram_preferences to service_role;
create policy owner_telegram_self on public.owner_telegram_preferences for all to authenticated
 using (user_id=(select auth.uid()) and public.has_account_role(array['owner','court_owner']))
 with check (user_id=(select auth.uid()) and public.has_account_role(array['owner','court_owner']));
create or replace function public.owner_telegram_state(r jsonb,kind text)
returns text language sql immutable set search_path=pg_catalog as $$
 select case
 when lower(coalesce(r->>'status','')) in ('cancelled','canceled','completed')
   or lower(coalesce(r->>'payment_status','')) in ('failed','rejected','cancelled','canceled','expired') then 'ignore'
 when (lower(coalesce(r->>'status',''))='confirmed' or kind='open_play')
   and lower(coalesce(r->>'payment_status','')) in ('paid','downpayment_paid')
   and (r->>'receipt_status'='auto_approved' or r->>'automatic_confirmation_source'='paymongo') then 'auto_confirmed'
 when lower(coalesce(r->>'status',''))='confirmed' or lower(coalesce(r->>'payment_status','')) in ('paid','downpayment_paid') then 'ignore'
 when lower(coalesce(r->>'status',''))='verifying'
   or lower(coalesce(r->>'receipt_status','')) in ('processing','verifying') then 'ignore'
 when kind='open_play' or lower(coalesce(r->>'status',''))='pending' then 'pending'
 else 'ignore' end;
$$;
-- Hash only for the deduplication index: PostgreSQL B-tree tuples cannot hold
-- arbitrary-length group references. Keep the exact text for worker lookups.
-- Explicit UTF8 encoding makes the built-in SHA-256 calculation deterministic;
-- no pgcrypto extension or server encoding-dependent bytea cast is required.
create or replace function public.owner_telegram_entity_hash(p_key text)
returns bytea
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$ select sha256(convert_to(p_key, 'UTF8')); $$;

create table public.owner_telegram_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('booking', 'open_play')),
  -- Match the existing booking reference text domain. Alert validation must not
  -- make otherwise valid booking writes fail (including legacy empty refs).
  entity_key text not null,
  entity_key_hash bytea generated always as (public.owner_telegram_entity_hash(entity_key)) stored,
  event text not null check (event in ('auto_confirmed', 'pending')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default (now() + interval '15 seconds'),
  locked_until timestamptz,
  lease_token uuid,
  first_attempt_at timestamptz,
  -- Frozen by the worker before the first provider request, then reused unchanged.
  payload jsonb,
  idempotency_key text not null unique default ('owner-telegram/' || gen_random_uuid()::text),
  provider_id text,
  last_error text check (last_error is null or length(last_error) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint owner_telegram_notifications_event_unique unique (user_id, entity_type, entity_key_hash, event)
);

create index owner_telegram_notifications_queue_idx
  on public.owner_telegram_notifications (available_at, created_at)
  where status in ('queued', 'sending');
create index owner_telegram_notifications_user_log_idx
  on public.owner_telegram_notifications (user_id, created_at desc);

alter table public.owner_telegram_notifications enable row level security;
-- Payloads and recipients never have client SELECT privileges. Use the log RPC.
revoke all on public.owner_telegram_notifications from public, anon, authenticated;
grant all on public.owner_telegram_notifications to service_role;


create or replace function public.enqueue_owner_telegram_notification()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
 r jsonb:=to_jsonb(new); previous jsonb; kind text; entity text; event_name text; old_event text:='ignore';
 old_real boolean:=false;
begin
 kind:=case when tg_table_name='bookings' then 'booking' else 'open_play' end;
 entity:=case when kind='booking' then coalesce(nullif(btrim(r->>'booking_group_ref'),''),r->>'ref') else r->>'id' end;
 if entity is null or nullif(btrim(r->>'full_name'),'') is null
   or lower(btrim(r->>'full_name')) like 'reserving%'
   or lower(btrim(coalesce(r->>'email','')))='reserve@hold.internal' then return new; end if;
 event_name:=public.owner_telegram_state(r,kind);
 if tg_op='UPDATE' then
   previous:=to_jsonb(old);
   old_real:=nullif(btrim(previous->>'full_name'),'') is not null
     and lower(btrim(previous->>'full_name')) not like 'reserving%'
     and lower(btrim(coalesce(previous->>'email',''))) <> 'reserve@hold.internal';
   if old_real then old_event:=public.owner_telegram_state(previous,kind); end if;
 end if;
 -- Do not backfill historical reservations on unrelated edits.
 if event_name='ignore' or (tg_op='UPDATE' and old_real and old_event=event_name) then return new; end if;
 insert into public.owner_telegram_notifications(user_id,entity_type,entity_key,event,available_at)
 select p.user_id,kind,entity,event_name,now()+interval '60 seconds'
 from public.owner_telegram_preferences p join public.accounts a on a.id=p.user_id
 where p.enabled and a.role in ('owner','court_owner')
   and ((event_name='pending' and p.notify_pending) or (event_name='auto_confirmed' and p.notify_auto_confirmed))
 on conflict on constraint owner_telegram_notifications_event_unique do nothing;
 return new;
end;
$$;
create trigger queue_owner_telegram_booking after insert or update on public.bookings
 for each row execute function public.enqueue_owner_telegram_notification();
create trigger queue_owner_telegram_open_play after insert or update on public.open_play_registrations
 for each row execute function public.enqueue_owner_telegram_notification();
create or replace function public.claim_owner_telegram_notifications(p_limit integer default 10)
returns setof public.owner_telegram_notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Telegram has no idempotency key: an interrupted dispatch is never automatically resent.
  -- Recover only jobs known not to have reached the provider; bound retries.
  update public.owner_telegram_notifications
    set status = 'failed', locked_until = null, lease_token = null,
        last_error = 'Delivery not confirmed. Check Telegram before retrying.'
    where (status = 'queued' or (status = 'sending' and locked_until <= now()))
      and (attempts >= 5 or first_attempt_at <= now() - interval '23 hours' or payload->>'dispatch' = 'started');

  return query
  with candidates as (
    select n.id from public.owner_telegram_notifications n
    where ((n.status = 'queued' and n.available_at <= now())
      or (n.status = 'sending' and n.locked_until <= now()))
      and n.attempts < 5
      and (n.first_attempt_at is null or n.first_attempt_at > now() - interval '23 hours')
    order by n.available_at, n.created_at, n.id
    limit greatest(1, least(coalesce(p_limit, 10), 10))
    for update skip locked
  )
  update public.owner_telegram_notifications n
    set status = 'sending', attempts = n.attempts + 1,
        first_attempt_at = coalesce(n.first_attempt_at, now()),
        locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid()
    from candidates c where n.id = c.id
    returning n.*;
end;
$$;


create or replace function public.reserve_owner_telegram_test(p_user_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.owner_telegram_preferences set last_test_at=now()
 where user_id=p_user_id and chat_id<>''
 and exists(select 1 from public.accounts where id=p_user_id and role in ('owner','court_owner'))
 and (last_test_at is null or last_test_at<=now()-interval '60 seconds');
 return found;
end;
$$;
create or replace function public.get_owner_telegram_notification_log()
returns table(id uuid,event text,status text,attempts integer,last_error text,sent_at timestamptz,created_at timestamptz)
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.has_account_role(array['owner','court_owner']) then raise exception 'Owner access required.' using errcode='42501'; end if;
 return query select n.id,n.event,n.status,n.attempts,
 case when n.last_error is null then null else 'Check Telegram and saved settings before retrying.' end,n.sent_at,n.created_at
 from public.owner_telegram_notifications n where n.user_id=(select auth.uid()) order by n.created_at desc,n.id desc limit 25;
end;
$$;
revoke all on function public.owner_telegram_entity_hash(text),public.owner_telegram_state(jsonb,text),
 public.enqueue_owner_telegram_notification(),public.claim_owner_telegram_notifications(integer),
 public.reserve_owner_telegram_test(uuid),public.get_owner_telegram_notification_log() from public,anon,authenticated;
grant execute on function public.owner_telegram_entity_hash(text),public.claim_owner_telegram_notifications(integer),
 public.reserve_owner_telegram_test(uuid) to service_role;
grant execute on function public.get_owner_telegram_notification_log() to authenticated;
notify pgrst,'reload schema';
