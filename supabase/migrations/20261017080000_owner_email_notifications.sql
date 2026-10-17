-- Owner email alerts are queued in the same transaction as booking changes.
-- No HTTP request or provider dependency is part of a customer booking write.

create table public.owner_email_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  emails text[] not null default '{}',
  enabled boolean not null default false,
  notify_new boolean not null default true,
  notify_pending boolean not null default true,
  last_test_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint owner_email_preferences_email_count check (cardinality(emails) <= 3),
  constraint owner_email_preferences_enabled_recipient check (not enabled or cardinality(emails) > 0)
);

create or replace function public.validate_owner_email_preferences()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  address text;
begin
  if new.emails is null or coalesce(array_ndims(new.emails), 1) > 1 then
    raise exception 'Provide a one-dimensional list of email addresses.' using errcode = '23514';
  end if;
  select coalesce(array_agg(lower(btrim(value)) order by ordinal), '{}'::text[])
    into new.emails
    from unnest(new.emails) with ordinality as addresses(value, ordinal);
  foreach address in array new.emails loop
    if address is null or length(address) > 254
      or address !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+[.][^[:space:]@,;<>]+$' then
      raise exception 'Provide valid email addresses.' using errcode = '23514';
    end if;
  end loop;
  if cardinality(new.emails) <> (select count(distinct value) from unnest(new.emails) as addresses(value)) then
    raise exception 'Email addresses must be unique.' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger validate_owner_email_preferences
before insert or update on public.owner_email_preferences
for each row execute function public.validate_owner_email_preferences();

alter table public.owner_email_preferences enable row level security;
revoke all on public.owner_email_preferences from public, anon, authenticated;
grant select on public.owner_email_preferences to authenticated;
grant insert (user_id, emails, enabled, notify_new, notify_pending)
  on public.owner_email_preferences to authenticated;
-- PostgREST upsert updates every supplied column, including the unchanged key.
-- USING/WITH CHECK still prevents changing ownership to another account.
grant update (user_id, emails, enabled, notify_new, notify_pending)
  on public.owner_email_preferences to authenticated;
grant all on public.owner_email_preferences to service_role;

create policy owner_email_preferences_read_self
  on public.owner_email_preferences for select to authenticated
  using (user_id = (select auth.uid()) and public.has_account_role(array['owner', 'court_owner']));
create policy owner_email_preferences_insert_self
  on public.owner_email_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and public.has_account_role(array['owner', 'court_owner']));
create policy owner_email_preferences_update_self
  on public.owner_email_preferences for update to authenticated
  using (user_id = (select auth.uid()) and public.has_account_role(array['owner', 'court_owner']))
  with check (user_id = (select auth.uid()) and public.has_account_role(array['owner', 'court_owner']));

-- Hash only for the deduplication index: PostgreSQL B-tree tuples cannot hold
-- arbitrary-length group references. Keep the exact text for worker lookups.
-- Explicit UTF8 encoding makes the built-in SHA-256 calculation deterministic;
-- no pgcrypto extension or server encoding-dependent bytea cast is required.
create or replace function public.owner_email_entity_hash(p_key text)
returns bytea
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$ select sha256(convert_to(p_key, 'UTF8')); $$;

create table public.owner_email_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('booking', 'open_play')),
  -- Match the existing booking reference text domain. Alert validation must not
  -- make otherwise valid booking writes fail (including legacy empty refs).
  entity_key text not null,
  entity_key_hash bytea generated always as (public.owner_email_entity_hash(entity_key)) stored,
  event text not null check (event in ('new_booking', 'pending')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default (now() + interval '15 seconds'),
  locked_until timestamptz,
  lease_token uuid,
  first_attempt_at timestamptz,
  -- Frozen by the worker before the first provider request, then reused unchanged.
  payload jsonb,
  idempotency_key text not null unique default ('owner-email/' || gen_random_uuid()::text),
  provider_id text,
  last_error text check (last_error is null or length(last_error) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint owner_email_notifications_event_unique unique (user_id, entity_type, entity_key_hash, event)
);

create index owner_email_notifications_queue_idx
  on public.owner_email_notifications (available_at, created_at)
  where status in ('queued', 'sending');
create index owner_email_notifications_user_log_idx
  on public.owner_email_notifications (user_id, created_at desc);

alter table public.owner_email_notifications enable row level security;
-- Payloads and recipients never have client SELECT privileges. Use the log RPC.
revoke all on public.owner_email_notifications from public, anon, authenticated;
grant all on public.owner_email_notifications to service_role;

create or replace function public.enqueue_owner_email_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_data jsonb := to_jsonb(new);
  old_data jsonb;
  entity_kind text;
  entity_id text;
  new_real boolean;
  old_real boolean := false;
  new_pending boolean;
  old_pending boolean := false;
  new_review boolean;
  old_review boolean := false;
  booking_state text;
  payment_state text;
  initial_booking boolean;
begin
  entity_kind := case when tg_table_name = 'bookings' then 'booking' else 'open_play' end;
  entity_id := case when entity_kind = 'booking'
    then coalesce(nullif(btrim(new_data->>'booking_group_ref'), ''), new_data->>'ref')
    else new_data->>'id' end;
  new_real := nullif(btrim(new_data->>'full_name'), '') is not null
    and lower(btrim(new_data->>'full_name')) not like 'reserving%'
    and lower(btrim(coalesce(new_data->>'email', ''))) <> 'reserve@hold.internal';
  if not new_real or entity_id is null then return new; end if;

  booking_state := lower(coalesce(new_data->>'status', ''));
  payment_state := lower(coalesce(new_data->>'payment_status', 'pending'));
  -- Never emit owner confirmation/cancellation emails or abandoned-hold alerts.
  if booking_state in ('cancelled', 'canceled')
    or payment_state in ('failed', 'rejected', 'cancelled', 'canceled', 'expired') then
    return new;
  end if;
  new_pending := not (booking_state in ('confirmed', 'completed') or payment_state in ('paid', 'downpayment_paid'))
    and (entity_kind = 'open_play' or booking_state in ('pending', 'verifying'));
  new_review := new_pending and (payment_state = 'for_verification'
    or lower(coalesce(new_data->>'receipt_status', '')) = 'manual_review');

  if tg_op = 'UPDATE' then
    old_data := to_jsonb(old);
    old_real := nullif(btrim(old_data->>'full_name'), '') is not null
      and lower(btrim(old_data->>'full_name')) not like 'reserving%'
      and lower(btrim(coalesce(old_data->>'email', ''))) <> 'reserve@hold.internal';
    booking_state := lower(coalesce(old_data->>'status', ''));
    payment_state := lower(coalesce(old_data->>'payment_status', 'pending'));
    old_pending := not (booking_state in ('cancelled', 'canceled', 'confirmed', 'completed')
      or payment_state in ('failed', 'rejected', 'cancelled', 'canceled', 'expired', 'paid', 'downpayment_paid'))
      and (entity_kind = 'open_play' or booking_state in ('pending', 'verifying'));
    old_review := old_pending and (payment_state = 'for_verification'
      or lower(coalesce(old_data->>'receipt_status', '')) = 'manual_review');
  end if;

  initial_booking := tg_op = 'INSERT' or not old_real;
  -- Group row writes and OCR's separate status/metadata writes settle together.
  -- This updates an existing alert only; unrelated edits never backfill old rows.
  update public.owner_email_notifications
    set available_at = now() + interval '15 seconds'
    where entity_type = entity_kind and entity_key = entity_id
      and status = 'queued' and first_attempt_at is null and payload is null;

  if initial_booking then
    insert into public.owner_email_notifications (user_id, entity_type, entity_key, event, available_at)
    select p.user_id, entity_kind, entity_id,
      case when p.notify_new then 'new_booking' else 'pending' end,
      now() + interval '15 seconds'
      from public.owner_email_preferences p
      join public.accounts a on a.id = p.user_id and a.role in ('owner', 'court_owner')
      where p.enabled and cardinality(p.emails) > 0
        and (p.notify_new or (new_pending and p.notify_pending))
    on conflict on constraint owner_email_notifications_event_unique do update
      set available_at = excluded.available_at
      where owner_email_notifications.status = 'queued'
        and owner_email_notifications.first_attempt_at is null
        and owner_email_notifications.payload is null;
  elsif new_pending and (not old_pending or (new_review and not old_review)) then
    -- A later needs-review transition gets one pending alert. An unsent initial
    -- new-booking alert already contains the latest state, so do not send both.
    insert into public.owner_email_notifications (user_id, entity_type, entity_key, event, available_at)
    select p.user_id, entity_kind, entity_id, 'pending', now() + interval '15 seconds'
      from public.owner_email_preferences p
      join public.accounts a on a.id = p.user_id and a.role in ('owner', 'court_owner')
      where p.enabled and p.notify_pending and cardinality(p.emails) > 0
        and not exists (
          select 1 from public.owner_email_notifications n
          where n.user_id = p.user_id and n.entity_type = entity_kind and n.entity_key = entity_id
            and n.event = 'new_booking' and p.notify_new
            and n.status = 'queued' and n.first_attempt_at is null and n.payload is null
        )
    on conflict on constraint owner_email_notifications_event_unique do update
      set available_at = excluded.available_at
      where owner_email_notifications.status = 'queued'
        and owner_email_notifications.first_attempt_at is null
        and owner_email_notifications.payload is null;
  end if;
  return new;
end;
$$;

create trigger queue_owner_email_booking
after insert or update on public.bookings
for each row execute function public.enqueue_owner_email_notification();
create trigger queue_owner_email_open_play
after insert or update on public.open_play_registrations
for each row execute function public.enqueue_owner_email_notification();

create or replace function public.claim_owner_email_notifications(p_limit integer default 10)
returns setof public.owner_email_notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Recover expired leases, but never automatically resend outside the provider's
  -- 24-hour idempotency window. Five attempts and 23 hours are hard upper bounds.
  update public.owner_email_notifications
    set status = 'failed', locked_until = null, lease_token = null,
        last_error = 'Automatic delivery attempts exhausted. Review before retrying.'
    where (status = 'queued' or (status = 'sending' and locked_until <= now()))
      and (attempts >= 5 or first_attempt_at <= now() - interval '23 hours');

  return query
  with candidates as (
    select n.id from public.owner_email_notifications n
    where ((n.status = 'queued' and n.available_at <= now())
      or (n.status = 'sending' and n.locked_until <= now()))
      and n.attempts < 5
      and (n.first_attempt_at is null or n.first_attempt_at > now() - interval '23 hours')
    order by n.available_at, n.created_at, n.id
    limit greatest(1, least(coalesce(p_limit, 10), 10))
    for update skip locked
  )
  update public.owner_email_notifications n
    set status = 'sending', attempts = n.attempts + 1,
        first_attempt_at = coalesce(n.first_attempt_at, now()),
        locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid()
    from candidates c where n.id = c.id
    returning n.*;
end;
$$;

create or replace function public.reserve_owner_email_test(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.owner_email_preferences p
    set last_test_at = now()
    where p.user_id = p_user_id and cardinality(p.emails) > 0
      and exists (select 1 from public.accounts a where a.id = p.user_id and a.role in ('owner', 'court_owner'))
      and (p.last_test_at is null or p.last_test_at <= now() - interval '60 seconds');
  return found;
end;
$$;

create or replace function public.get_owner_email_notification_log()
returns table (
  id uuid, event text, status text, attempts integer,
  last_error text, sent_at timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_account_role(array['owner', 'court_owner']) then
    raise exception 'Owner access required.' using errcode = '42501';
  end if;
  return query
    select n.id, n.event, n.status, n.attempts,
      -- Worker errors may contain provider details. Expose only a safe summary.
      case when n.last_error is null then null
        when n.status = 'skipped' then 'Alert skipped because settings or booking state changed.'
        when n.status = 'failed' then 'Delivery failed. Check the recipient and email service configuration.'
        else 'Delivery was delayed; an automatic retry is scheduled.' end,
      n.sent_at, n.created_at
    from public.owner_email_notifications n
    where n.user_id = (select auth.uid())
    order by n.created_at desc, n.id desc limit 25;
end;
$$;

revoke all on function public.validate_owner_email_preferences() from public, anon, authenticated;
revoke all on function public.owner_email_entity_hash(text) from public, anon, authenticated;
revoke all on function public.enqueue_owner_email_notification() from public, anon, authenticated;
revoke all on function public.claim_owner_email_notifications(integer) from public, anon, authenticated;
revoke all on function public.reserve_owner_email_test(uuid) from public, anon, authenticated;
revoke all on function public.get_owner_email_notification_log() from public, anon, authenticated;
grant execute on function public.claim_owner_email_notifications(integer) to service_role;
grant execute on function public.owner_email_entity_hash(text) to service_role;
grant execute on function public.reserve_owner_email_test(uuid) to service_role;
grant execute on function public.get_owner_email_notification_log() to authenticated;

comment on table public.owner_email_notifications is
  'Private durable owner alerts. Worker updates must match id, lease_token and status=sending.';
comment on column public.owner_email_notifications.payload is
  'Immutable provider request snapshot after first attempt; preserve identical bytes and idempotency_key across retries.';
notify pgrst, 'reload schema';
