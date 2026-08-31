-- ============================================================================
-- Legacy PayMongo net remittance reconciliation
--
-- The developer fee remains PHP 15 per booked hour. Bookings created before
-- the PayMongo cutoff retain their actual processor deduction; bookings on or
-- after the cutoff carry a zero deduction. New remittances consume the net
-- immutable snapshot so the dashboard and ledger agree.
-- ============================================================================

begin;

alter table public.bookings
  add column if not exists booking_fee_processor_deduction_snapshot numeric(12,2)
    not null default 0,
  add column if not exists booking_fee_net_amount_snapshot numeric(12,2)
    generated always as (
      greatest(
        round(
          coalesce(booking_fee_amount_snapshot, 0)
          - booking_fee_processor_deduction_snapshot,
          2
        ),
        0::numeric
      )
    ) stored;

alter table public.bookings
  drop constraint if exists bookings_booking_fee_processor_deduction_snapshot_check;
alter table public.bookings
  add constraint bookings_booking_fee_processor_deduction_snapshot_check
    check (
      booking_fee_processor_deduction_snapshot >= 0
      and booking_fee_processor_deduction_snapshot
        <= coalesce(booking_fee_amount_snapshot, 0)
    );

create or replace function public.calculate_legacy_paymongo_deduction(
  p_created_at timestamptz,
  p_payment_method text,
  p_payment_provider text,
  p_payment_status text,
  p_total numeric,
  p_downpayment numeric,
  p_gross_booking_fee numeric
)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_created_at < timestamptz '2026-07-13T15:25:18+08:00'
     and lower(coalesce(
       nullif(btrim(p_payment_provider), ''),
       nullif(btrim(p_payment_method), ''),
       ''
     )) in (
       'gcash', 'qrph', 'paymongo', 'paymongo_qrph',
       'bdopay', 'maya', 'gotyme', 'pnb'
     )
     and lower(coalesce(p_payment_status, '')) in ('paid', 'downpayment_paid')
    then least(
      greatest(coalesce(p_gross_booking_fee, 0), 0),
      round(
        greatest(
          case lower(coalesce(p_payment_status, ''))
            when 'paid' then coalesce(p_total, 0)
            when 'downpayment_paid' then coalesce(p_downpayment, coalesce(p_total, 0) / 2)
            else 0
          end,
          0
        ) * 0.0134,
        2
      )
    )
    else 0::numeric
  end;
$$;

-- Backfill only unsettled/unclaimed source rows. Settled remittance history and
-- paid legacy statements retain the exact amounts that were already accepted.
--
-- The old admin statement summed the unrounded processor amounts for the whole
-- booking month and rounded once. Allocate that monthly cent total across the
-- immutable booking rows with the largest-remainder method so July remains
-- exactly PHP 27.74 instead of losing one cent through per-row rounding.
drop trigger if exists trg_guard_booking_fee_snapshot_update on public.bookings;

with eligible as (
  select
    b.ref,
    date_trunc('month', b.created_at at time zone 'Asia/Manila')::date as booking_month,
    case
      when b.created_at < timestamptz '2026-07-13T15:25:18+08:00'
       and lower(coalesce(
         nullif(btrim(b.payment_provider), ''),
         nullif(btrim(b.payment_method), ''),
         ''
       )) in (
         'gcash', 'qrph', 'paymongo', 'paymongo_qrph',
         'bdopay', 'maya', 'gotyme', 'pnb'
       )
       and lower(coalesce(b.payment_status, '')) in ('paid', 'downpayment_paid')
      then least(
        greatest(coalesce(b.booking_fee_amount_snapshot, 0), 0),
        greatest(
          case lower(coalesce(b.payment_status, ''))
            when 'paid' then coalesce(b.total, 0)
            when 'downpayment_paid' then coalesce(b.downpayment, coalesce(b.total, 0) / 2)
            else 0
          end,
          0
        ) * 0.0134
      )
      else 0::numeric
    end as raw_deduction
  from public.bookings b
  where b.booking_fee_amount_snapshot is not null
    and not exists (
      select 1
        from public.booking_fee_remittance_items i
        join public.booking_fee_remittances r on r.id = i.remittance_id
       where i.booking_ref = b.ref
         and i.released_at is null
         and r.status = 'settled'
    )
    and not exists (
      select 1
        from public.weekly_fees wf
       where wf.status = 'paid'
         and coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
    )
), ranked as (
  select
    e.*,
    trunc(e.raw_deduction, 2) as base_deduction,
    row_number() over (
      partition by e.booking_month
      order by e.raw_deduction - trunc(e.raw_deduction, 2) desc, e.ref
    ) as remainder_rank,
    greatest(
      round(
        (
          round(sum(e.raw_deduction) over (partition by e.booking_month), 2)
          - sum(trunc(e.raw_deduction, 2)) over (partition by e.booking_month)
        ) * 100,
        0
      ),
      0
    )::integer as residual_cents
  from eligible e
)
update public.bookings b
   set booking_fee_processor_deduction_snapshot =
       r.base_deduction
       + case when r.remainder_rank <= r.residual_cents then 0.01 else 0 end
  from ranked r
 where b.ref = r.ref;

-- If a pre-cutoff booking earns its fee after this migration, freeze the same
-- legacy deduction at the qualifying paid/confirmed transition.
create or replace function public.mark_booking_fee_earned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.booking_fee_earned_at is not null then
    if new.booking_fee_earned_at is distinct from old.booking_fee_earned_at then
      raise exception 'A booking fee earned timestamp is immutable.'
        using errcode = '22000';
    end if;
    return new;
  end if;

  new.booking_fee_earned_at := null;
  if new.booking_fee_amount_snapshot is not null
     and new.booking_fee_ledger_eligible_snapshot
     and new.status in ('confirmed', 'completed')
     and new.payment_status in ('paid', 'downpayment_paid') then
    perform pg_advisory_xact_lock_shared(
      hashtextextended('the-quadrant-booking-fee-remittance', 0)
    );
    new.booking_fee_processor_deduction_snapshot :=
      public.calculate_legacy_paymongo_deduction(
        new.created_at,
        new.payment_method,
        new.payment_provider,
        new.payment_status,
        new.total,
        new.downpayment,
        new.booking_fee_amount_snapshot
      );
    new.booking_fee_earned_at := clock_timestamp();
  end if;

  return new;
end;
$$;

create or replace function public.guard_booking_fee_snapshot_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.booking_fee_amount_snapshot is distinct from old.booking_fee_amount_snapshot
     or new.booking_fee_rate_snapshot is distinct from old.booking_fee_rate_snapshot
     or new.booking_fee_type_snapshot is distinct from old.booking_fee_type_snapshot
     or new.booking_fee_units_snapshot is distinct from old.booking_fee_units_snapshot
     or new.booking_fee_snapshot_source is distinct from old.booking_fee_snapshot_source
     or new.booking_fee_ledger_eligible_snapshot is distinct from old.booking_fee_ledger_eligible_snapshot
     or (
       new.booking_fee_processor_deduction_snapshot
         is distinct from old.booking_fee_processor_deduction_snapshot
       and not (
         old.booking_fee_earned_at is null
         and new.booking_fee_earned_at is not null
         and new.booking_fee_processor_deduction_snapshot =
           public.calculate_legacy_paymongo_deduction(
             new.created_at,
             new.payment_method,
             new.payment_provider,
             new.payment_status,
             new.total,
             new.downpayment,
             new.booking_fee_amount_snapshot
           )
       )
     ) then
    raise exception 'Booking fee snapshots are immutable after booking creation.'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create trigger trg_guard_booking_fee_snapshot_update
before update on public.bookings
for each row execute function public.guard_booking_fee_snapshot_update();

-- Preserve the existing RPC contract: fee_amount now means the immutable net
-- amount to remit. fee_rate and fee_units still expose the gross calculation.
create or replace function public.booking_fee_unclaimed_rows()
returns table (
  booking_ref text,
  booking_group_ref text,
  booking_created_at timestamptz,
  fee_earned_at timestamptz,
  court_id text,
  court_name text,
  booking_date date,
  host_booking boolean,
  created_via text,
  fee_amount numeric,
  fee_rate numeric,
  fee_type text,
  fee_units numeric,
  fee_snapshot_source text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.ref,
    b.booking_group_ref,
    b.created_at,
    b.booking_fee_earned_at,
    b.court_id,
    b.court_name,
    b.date,
    coalesce(b.host_booking, false),
    b.created_via,
    b.booking_fee_net_amount_snapshot,
    b.booking_fee_rate_snapshot,
    b.booking_fee_type_snapshot,
    b.booking_fee_units_snapshot,
    b.booking_fee_snapshot_source
  from public.bookings b
  where b.booking_fee_earned_at is not null
    and b.booking_fee_net_amount_snapshot > 0
    and b.booking_fee_rate_snapshot is not null
    and b.booking_fee_type_snapshot in ('flat', 'per_hour')
    and b.booking_fee_units_snapshot is not null
    and b.booking_fee_snapshot_source is not null
    and b.booking_fee_ledger_eligible_snapshot
    and b.weekly_fee_id is null
    and b.billed_at is null
    and not exists (
      select 1
        from public.weekly_fees wf
       where wf.status = 'paid'
         and coalesce(wf.billed_refs, '[]'::jsonb) @> jsonb_build_array(b.ref)
    )
    and not exists (
      select 1
        from public.booking_fee_remittance_items i
       where i.booking_ref = b.ref
         and i.released_at is null
    )
  order by b.booking_fee_earned_at, b.created_at, b.ref
$$;

-- Reconcile only unpaid prepared/rejected records. Records with an active or
-- accepted payment and all settled records are deliberately left untouched.
create temporary table legacy_paymongo_remittance_reconciliation
on commit drop
as
select
  r.id as remittance_id,
  r.amount_due as old_amount_due,
  round(sum(coalesce(b.booking_fee_net_amount_snapshot, i.fee_amount)), 2) as new_amount_due
from public.booking_fee_remittances r
join public.booking_fee_remittance_items i
  on i.remittance_id = r.id and i.released_at is null
left join public.bookings b on b.ref = i.booking_ref
where r.status in ('prepared', 'payment_rejected')
  and not exists (
    select 1
      from public.booking_fee_remittance_payments p
     where p.remittance_id = r.id
       and p.status in ('pending', 'accepted', 'partially_accepted')
  )
group by r.id, r.amount_due
having abs(
  r.amount_due
  - round(sum(coalesce(b.booking_fee_net_amount_snapshot, i.fee_amount)), 2)
) > 0.009;

drop trigger if exists trg_guard_booking_fee_remittance_item_update
  on public.booking_fee_remittance_items;

update public.booking_fee_remittance_items i
   set fee_amount = b.booking_fee_net_amount_snapshot
  from public.bookings b,
       legacy_paymongo_remittance_reconciliation c
 where i.booking_ref = b.ref
   and i.remittance_id = c.remittance_id
   and i.released_at is null;

create trigger trg_guard_booking_fee_remittance_item_update
before update on public.booking_fee_remittance_items
for each row execute function public.guard_booking_fee_remittance_item_update();

update public.booking_fee_remittances r
   set amount_due = c.new_amount_due
  from legacy_paymongo_remittance_reconciliation c
 where r.id = c.remittance_id;

alter table public.booking_fee_remittance_events
  drop constraint if exists booking_fee_remittance_events_type_check;
alter table public.booking_fee_remittance_events
  add constraint booking_fee_remittance_events_type_check
    check (event_type in (
      'prepared',
      'zero_balance_settled',
      'payment_submitted',
      'payment_accepted',
      'payment_partially_accepted',
      'payment_rejected',
      'settled',
      'cancelled_and_released',
      'legacy_processor_deduction_reconciled'
    ));

insert into public.booking_fee_remittance_events (
  remittance_id,
  event_type,
  actor_role,
  metadata
)
select
  c.remittance_id,
  'legacy_processor_deduction_reconciled',
  'system_migration',
  jsonb_build_object(
    'old_amount_due', c.old_amount_due,
    'new_amount_due', c.new_amount_due,
    'paymongo_deduction', round(c.old_amount_due - c.new_amount_due, 2),
    'cutoff_at', '2026-07-13T15:25:18+08:00'
  )
from legacy_paymongo_remittance_reconciliation c;

comment on column public.bookings.booking_fee_processor_deduction_snapshot is
  'Immutable legacy PayMongo processor deduction. Zero for bookings at/after the July 13, 2026 cutoff.';
comment on column public.bookings.booking_fee_net_amount_snapshot is
  'Gross booking fee snapshot less the immutable legacy processor deduction; this is the remittance amount.';
comment on function public.calculate_legacy_paymongo_deduction(
  timestamptz, text, text, text, numeric, numeric, numeric
) is
  'Returns the capped 1.34% legacy PayMongo deduction for paid bookings created before the fixed cutoff.';

revoke all on function public.calculate_legacy_paymongo_deduction(
  timestamptz, text, text, text, numeric, numeric, numeric
) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
