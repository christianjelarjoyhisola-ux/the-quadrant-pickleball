-- ============================================================================
-- Align the accumulated remittance balance with the dashboard booking report
--
-- A platform fee is reportable while the booking is confirmed or completed.
-- Cancelled bookings that have not been frozen into a remittance must not stay
-- in the live balance. Conversely, a confirmed/completed platform booking is
-- reportable even when its manual receipt is still marked for verification.
-- Existing prepared/paid/settled remittances remain immutable.
-- ============================================================================

begin;

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
     and new.status in ('confirmed', 'completed') then
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

-- Re-run the server-owned transition for eligible confirmed/completed rows
-- that the previous paid-only rule skipped. This does not touch rows already
-- claimed by an exact-cutoff remittance or a paid legacy statement.
update public.bookings b
   set booking_fee_earned_at = b.booking_fee_earned_at
 where b.booking_fee_earned_at is null
   and b.booking_fee_amount_snapshot is not null
   and b.booking_fee_ledger_eligible_snapshot
   and b.status in ('confirmed', 'completed')
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
   );

-- Preserve the existing RPC contract while applying the same active booking
-- rule used by the developer-fee report. An already prepared remittance keeps
-- its frozen item rows; this predicate affects only the current live balance.
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
    and b.status in ('confirmed', 'completed')
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

comment on column public.bookings.booking_fee_earned_at is
  'Server timestamp when a reportable confirmed/completed platform booking first became eligible for remittance.';
comment on function public.booking_fee_unclaimed_rows() is
  'Returns only unclaimed confirmed/completed platform booking fees; cancelled rows remain audit history but leave the live balance.';

notify pgrst, 'reload schema';

commit;
