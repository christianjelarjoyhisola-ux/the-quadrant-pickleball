-- Snapshot the declared headcount and its once-per-booking surcharge before
-- payment. Existing bookings remain legacy rows with null snapshots and no
-- surcharge. New quotes are written only by quote_booking_player_count().

alter table public.bookings
  add column if not exists player_count integer,
  add column if not exists included_players integer,
  add column if not exists extra_player_rate numeric,
  add column if not exists extra_player_fee numeric;

alter table public.bookings drop constraint if exists bookings_player_count_check;
alter table public.bookings add constraint bookings_player_count_check
  check (player_count is null or player_count >= 1);
alter table public.bookings drop constraint if exists bookings_included_players_check;
alter table public.bookings add constraint bookings_included_players_check
  check (included_players is null or included_players >= 1);
alter table public.bookings drop constraint if exists bookings_extra_player_rate_check;
alter table public.bookings add constraint bookings_extra_player_rate_check
  check (extra_player_rate is null or extra_player_rate >= 0);
alter table public.bookings drop constraint if exists bookings_extra_player_fee_check;
alter table public.bookings add constraint bookings_extra_player_fee_check
  check (extra_player_fee is null or extra_player_fee >= 0);

insert into public.settings (key, value)
values
  ('included_players_per_court', '8'),
  ('extra_player_rate_php', '100'),
  ('player_count_hard_max', '99'),
  ('extra_player_pricing_cutover_at', now()::text)
on conflict (key) do nothing;

comment on column public.bookings.player_count is
  'Customer-declared players for this court booking. Immutable after the hold is quoted.';
comment on column public.bookings.included_players is
  'Immutable pricing snapshot: players included without surcharge (8 at cutover).';
comment on column public.bookings.extra_player_rate is
  'Immutable pricing snapshot: PHP charged once for each player above included_players.';
comment on column public.bookings.extra_player_fee is
  'Immutable computed surcharge for this booking row; never multiplied by hours.';

create or replace function public.apply_or_guard_extra_player_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  quoting boolean := coalesce(current_setting('app.quote_booking_player_count', true), '') = '1';
  expected_fee numeric;
  expected_total numeric;
  hard_max integer := 99;
begin
  if tg_op = 'INSERT' then
    if new.player_count is null then
      if new.included_players is not null or new.extra_player_rate is not null or new.extra_player_fee is not null then
        raise exception 'Player pricing snapshots require a player count.' using errcode = '22000';
      end if;
      return new;
    end if;

    select greatest(coalesce(nullif(value, '')::integer, 99), 8)
      into hard_max from public.settings where key = 'player_count_hard_max';
    hard_max := coalesce(hard_max, 99);
    if new.player_count < 1 or new.player_count > hard_max then
      raise exception 'Player count must be between 1 and %.', hard_max using errcode = '22000';
    end if;
    new.included_players := 8;
    new.extra_player_rate := 100;
    new.extra_player_fee := greatest(new.player_count - 8, 0) * 100;
    return new;
  end if;

  if old.player_count is null and new.player_count is not null then
    if not quoting then
      raise exception 'Use quote_booking_player_count to set the player count.' using errcode = '22000';
    end if;
    expected_fee := greatest(new.player_count - 8, 0) * 100;
    expected_total := nullif(current_setting('app.quote_booking_total', true), '')::numeric;
    if new.included_players is distinct from 8
       or new.extra_player_rate is distinct from 100
       or new.extra_player_fee is distinct from expected_fee
       or expected_total is null
       or new.total is distinct from expected_total then
      raise exception 'Player surcharge quote is invalid.' using errcode = '22000';
    end if;
    return new;
  end if;

  if new.player_count is distinct from old.player_count
     or new.included_players is distinct from old.included_players
     or new.extra_player_rate is distinct from old.extra_player_rate
     or new.extra_player_fee is distinct from old.extra_player_fee then
    raise exception 'Player count and pricing snapshots are immutable after quoting.' using errcode = '22000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_01_apply_or_guard_extra_player_snapshot on public.bookings;
create trigger trg_01_apply_or_guard_extra_player_snapshot
before insert or update on public.bookings
for each row execute function public.apply_or_guard_extra_player_snapshot();

-- The existing anonymous-update guard normally makes total immutable. The
-- private transaction marker is set only inside the tightly-scoped quote RPC;
-- the snapshot trigger above also verifies the exact allowed price change.
create or replace function public.guard_public_booking_hold_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(auth.role(), nullif(current_setting('request.jwt.claim.role', true), ''));
  account_role text := public.current_account_role();
  service_fee numeric := 0;
  extra_fee numeric := 0;
  public_due numeric := 0;
  host_due numeric := 0;
  group_fee_ref text;
begin
  if coalesce(current_setting('app.quote_booking_player_count', true), '') = '1' then
    return new;
  end if;

  if request_role = 'anon'
     or (request_role = 'authenticated' and account_role = 'host') then
    if new.ref is distinct from old.ref
      or new.booking_group_ref is distinct from old.booking_group_ref
      or new.court_id is distinct from old.court_id
      or new.court_name is distinct from old.court_name
      or new.date is distinct from old.date
      or new.slots is distinct from old.slots
      or new.start_time is distinct from old.start_time
      or new.end_time is distinct from old.end_time
      or new.duration is distinct from old.duration
      or new.rate is distinct from old.rate
      or new.total is distinct from old.total
      or new.player_count is distinct from old.player_count
      or new.included_players is distinct from old.included_players
      or new.extra_player_rate is distinct from old.extra_player_rate
      or new.extra_player_fee is distinct from old.extra_player_fee
      or new.created_at is distinct from old.created_at
      or new.host_booking is distinct from old.host_booking
      or new.host_user_id is distinct from old.host_user_id
      or new.host_name is distinct from old.host_name
      or new.host_email is distinct from old.host_email
      or new.created_via is distinct from old.created_via
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_by_role is distinct from old.created_by_role
      or new.created_by_name is distinct from old.created_by_name
      or new.created_by_email is distinct from old.created_by_email
      or new.payment_provider is distinct from old.payment_provider
      or new.payment_session_id is distinct from old.payment_session_id
      or new.payment_checkout_url is distinct from old.payment_checkout_url
      or new.paid_at is distinct from old.paid_at
      or new.receipt_image_url is distinct from old.receipt_image_url
      or new.receipt_image_hash is distinct from old.receipt_image_hash
      or new.receipt_phash is distinct from old.receipt_phash
      or new.receipt_status is distinct from old.receipt_status
      or new.receipt_flags is distinct from old.receipt_flags
      or new.receipt_extracted is distinct from old.receipt_extracted
      or new.receipt_confidence is distinct from old.receipt_confidence
      or new.receipt_verified_at is distinct from old.receipt_verified_at
      or new.billed_at is distinct from old.billed_at
      or new.weekly_fee_id is distinct from old.weekly_fee_id then
      raise exception 'Reservation identity, slot, price, and ownership cannot be changed after a hold is created.';
    end if;

    if new.payment_status not in ('unpaid', 'pending', 'for_verification', 'rejected') then
      raise exception 'Reservation payment status cannot be approved by the booking client.';
    end if;
  end if;

  if request_role = 'anon' then
    if coalesce(old.host_booking, false)
      or old.host_user_id is not null
      or old.created_via <> 'customer'
      or old.created_by_user_id is not null then
      raise exception 'Anonymous clients may only finalize public customer holds.';
    end if;

    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Reservation payment amount is invalid.';
      end if;
      service_fee := least(greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0), old.total);
      if old.booking_fee_type_snapshot = 'flat'
         and nullif(btrim(old.booking_group_ref), '') is not null then
        select min(b.ref)
          into group_fee_ref
          from public.bookings b
         where b.booking_group_ref = old.booking_group_ref
           and b.status <> 'cancelled';
        if old.ref is distinct from group_fee_ref then
          service_fee := 0;
        end if;
      end if;
      extra_fee := least(greatest(coalesce(old.extra_player_fee, 0), 0), old.total - service_fee);
      public_due := round(service_fee + extra_fee + ((old.total - service_fee - extra_fee) * 0.50), 2);
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - public_due) > 0.01
         and (old.extra_player_fee is not null
              or (abs(new.downpayment - (old.total / 2)) > 0.01
                  and abs(new.downpayment - round(old.total / 2)) > 0.01)) then
        raise exception 'Reservation payment amount is invalid. Expected 50%% of the court fee plus full booking and extra-player fees.';
      end if;
    end if;
  elsif request_role = 'authenticated' and account_role = 'host' then
    if old.status <> 'verifying'
      or old.created_at is null
      or old.created_at <= now() - interval '15 minutes'
      or not coalesce(old.host_booking, false)
      or old.host_user_id is distinct from auth.uid()
      or old.created_via <> 'host'
      or old.created_by_user_id is distinct from auth.uid()
      or old.created_by_role <> 'host' then
      raise exception 'Hosts may only finalize their own active booking holds.';
    end if;
    if new.status not in ('verifying', 'pending', 'cancelled') then
      raise exception 'Host booking hold status transition is invalid.';
    end if;
    if new.status = 'pending' and new.downpayment is null then
      raise exception 'A finalized host booking must store its payment amount.';
    end if;
    if new.downpayment is not null then
      if old.total is null or old.total < 0 then
        raise exception 'Host booking total is invalid.';
      end if;
      service_fee := least(greatest(coalesce(old.booking_fee_amount_snapshot, 0), 0), old.total);
      if old.booking_fee_type_snapshot = 'flat'
         and nullif(btrim(old.booking_group_ref), '') is not null then
        select min(b.ref)
          into group_fee_ref
          from public.bookings b
         where b.booking_group_ref = old.booking_group_ref
           and b.status <> 'cancelled';
        if old.ref is distinct from group_fee_ref then
          service_fee := 0;
        end if;
      end if;
      extra_fee := least(greatest(coalesce(old.extra_player_fee, 0), 0), old.total - service_fee);
      host_due := round(service_fee + extra_fee + ((old.total - service_fee - extra_fee) * 0.25), 2);
      if abs(new.downpayment - old.total) > 0.01
         and abs(new.downpayment - host_due) > 0.01 then
        raise exception 'Host payment amount is invalid. Expected 25%% of the court fee plus full booking and extra-player fees.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Keep the no-hold fallback insert path valid: the full booking fee and full
-- extra-player fee are collected alongside half of the court price.
drop policy if exists bookings_insert_public on public.bookings;
create policy bookings_insert_public
  on public.bookings for insert to anon
  with check (
    coalesce(host_booking, false) = false
    and host_user_id is null and host_name is null and host_email is null
    and created_via = 'customer'
    and created_by_user_id is null and created_by_role is null
    and created_by_name is null and created_by_email is null
    and status in ('verifying', 'pending')
    and payment_status in ('unpaid', 'pending', 'for_verification')
    and created_at > now() - interval '15 minutes'
    and created_at <= now() + interval '5 minutes'
    and total is not null and total >= 0
    and (
      downpayment is null
      or abs(downpayment - total) <= 0.01
      or abs(
        downpayment - round(
          least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
          + least(
              greatest(coalesce(extra_player_fee, 0), 0),
              total - least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
            )
          + (
              total
              - least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
              - least(
                  greatest(coalesce(extra_player_fee, 0), 0),
                  total - least(greatest(coalesce(booking_fee_amount_snapshot, 0), 0), total)
                )
            ) * 0.50,
          2
        )
      ) <= 0.01
      or (
        extra_player_fee is null
        and (
          abs(downpayment - (total / 2)) <= 0.01
          or abs(downpayment - round(total / 2)) <= 0.01
        )
      )
    )
  );

create or replace function public.quote_booking_player_count(
  p_ref text,
  p_player_count integer
)
returns table (
  booking_ref text,
  player_count integer,
  included_players integer,
  extra_player_rate numeric,
  extra_player_fee numeric,
  total numeric,
  downpayment numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  booking public.bookings%rowtype;
  hard_max integer := 99;
  quoted_extra numeric;
  base_service_fee numeric;
  base_due numeric;
  quoted_total numeric;
  quoted_downpayment numeric;
  base_total numeric;
  fee_type text := 'per_hour';
  group_fee_ref text;
begin
  if nullif(btrim(p_ref), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22000';
  end if;

  select greatest(coalesce(nullif(value, '')::integer, 99), 8)
    into hard_max
    from public.settings
   where key = 'player_count_hard_max';
  hard_max := coalesce(hard_max, 99);
  if p_player_count is null or p_player_count < 1 or p_player_count > hard_max then
    raise exception 'Player count must be between 1 and %.', hard_max using errcode = '22000';
  end if;

  select * into booking
    from public.bookings
   where ref = p_ref
   for update;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if booking.player_count is not null then
    if booking.player_count <> p_player_count then
      raise exception 'Player count has already been finalized for this booking.' using errcode = '22000';
    end if;
    return query select booking.ref, booking.player_count, booking.included_players,
      booking.extra_player_rate, booking.extra_player_fee, booking.total, booking.downpayment;
    return;
  end if;

  if booking.status not in ('verifying', 'pending')
     or booking.payment_status not in ('unpaid', 'pending')
     or booking.created_at is null
     or booking.created_at <= now() - interval '15 minutes'
     or coalesce(booking.host_booking, false)
     or booking.host_user_id is not null
     or booking.created_via <> 'customer'
     or booking.created_by_user_id is not null then
    raise exception 'Only a fresh public customer hold can be quoted.' using errcode = '22000';
  end if;
  if booking.total is null or booking.total < 0 then
    raise exception 'Booking total is invalid.' using errcode = '22000';
  end if;

  select lower(trim(coalesce(value, 'per_hour')))
    into fee_type
    from public.settings
   where key = 'fee_type';
  fee_type := coalesce(fee_type, 'per_hour');

  -- Every grouped placeholder was historically inserted with the flat fee.
  -- Keep it on exactly one deterministic row so the group quote, receipt
  -- verifier, and PayMongo calculator all collect that transaction fee once.
  base_total := booking.total;
  base_service_fee := least(greatest(coalesce(booking.booking_fee_amount_snapshot, 0), 0), booking.total);
  if fee_type = 'flat' and nullif(btrim(booking.booking_group_ref), '') is not null then
    select min(b.ref)
      into group_fee_ref
      from public.bookings b
     where b.booking_group_ref = booking.booking_group_ref
       and b.status <> 'cancelled';
    if booking.ref is distinct from group_fee_ref then
      base_total := round(greatest(booking.total - base_service_fee, 0), 2);
      base_service_fee := 0;
    end if;
  end if;

  quoted_extra := greatest(p_player_count - 8, 0) * 100;
  quoted_total := round(base_total + quoted_extra, 2);
  base_due := round(base_service_fee + ((base_total - base_service_fee) * 0.50), 2);
  quoted_downpayment := case
    when booking.downpayment is null then null
    when abs(booking.downpayment - booking.total) <= 0.01 then quoted_total
    when abs(booking.downpayment - base_due) <= 0.01 then round(base_due + quoted_extra, 2)
    else null
  end;
  if booking.downpayment is not null and quoted_downpayment is null then
    raise exception 'Stored payment amount cannot be safely repriced.' using errcode = '22000';
  end if;

  perform set_config('app.quote_booking_player_count', '1', true);
  perform set_config('app.quote_booking_total', quoted_total::text, true);
  update public.bookings b
     set player_count = p_player_count,
         included_players = 8,
         extra_player_rate = 100,
         extra_player_fee = quoted_extra,
         total = quoted_total,
         downpayment = quoted_downpayment
   where b.ref = booking.ref
   returning b.* into booking;

  return query select booking.ref, booking.player_count, booking.included_players,
    booking.extra_player_rate, booking.extra_player_fee, booking.total, booking.downpayment;
end;
$$;

revoke all on function public.quote_booking_player_count(text, integer) from public;
grant execute on function public.quote_booking_player_count(text, integer) to anon, authenticated;

comment on function public.quote_booking_player_count(text, integer) is
  'Atomically finalizes a fresh public hold headcount and adds the immutable once-per-booking extra-player surcharge.';

notify pgrst, 'reload schema';
