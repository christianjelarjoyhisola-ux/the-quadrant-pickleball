-- ============================================================================
-- Automatic month-end booking-fee remittance close
--
-- Every ended calendar month (Asia/Manila) is frozen into its own remittance
-- with an exact cutoff at the last instant of that month, due on the 7th of
-- the following month. Months are closed oldest first, so a backlog (for
-- example September and October) becomes one batch per month. A daily
-- pg_cron job runs the close shortly after midnight Manila time; the System
-- Owner may also run it on demand.
--
-- Fees are stamped with booking_fee_earned_at = clock_timestamp() under the
-- shared remittance lock, so no new fee can ever be earned before a past
-- cutoff. Freezing an ended month after the fact is therefore exact.
--
-- The System Owner may also record a court owner's payment directly: the
-- proof is submitted and accepted in one transaction with the full audit
-- trail of a normal submission and review.
-- ============================================================================

begin;

create or replace function public.close_booking_fee_ended_months_internal(
  p_actor_user_id uuid default null,
  p_actor_role text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_time timestamptz;
  actor_email text;
  earliest_earned timestamptz;
  latest_cutoff timestamptz;
  latest_due date;
  period_month date;
  period_end timestamptz;
  cutoff_time timestamptz;
  due_on date;
  new_id uuid;
  generated_ref text;
  item_count integer;
  total_due numeric;
  coverage_start timestamptz;
  created jsonb := '[]'::jsonb;
  guard integer := 0;
begin
  -- Same exclusive lock as prepare_booking_fee_remittance: no fee can become
  -- earned and no other batch can be prepared while months are being closed.
  perform pg_advisory_xact_lock(
    hashtextextended('the-quadrant-booking-fee-remittance', 0)
  );
  run_time := clock_timestamp();

  if p_actor_user_id is not null then
    select a.email into actor_email
      from public.accounts a
     where a.id = p_actor_user_id
     limit 1;
  end if;

  loop
    guard := guard + 1;
    exit when guard > 36;

    select min(u.fee_earned_at)
      into earliest_earned
      from public.booking_fee_unclaimed_rows() u
     where u.fee_amount > 0;
    exit when earliest_earned is null;

    select max(r.cutoff_at), max(r.cycle_due_on)
      into latest_cutoff, latest_due
      from public.booking_fee_remittances r
     where r.scope_key = 'venue'
       and r.status <> 'cancelled';

    -- A fee released from a cancelled batch keeps its old earned time; it
    -- rolls into the first month that ends after the latest existing cutoff.
    period_month := date_trunc(
      'month',
      timezone(
        'Asia/Manila',
        greatest(earliest_earned, coalesce(latest_cutoff + interval '1 microsecond', earliest_earned))
      )
    )::date;
    period_end := (period_month + interval '1 month')::timestamp at time zone 'Asia/Manila';
    exit when period_end > run_time;
    cutoff_time := period_end - interval '1 microsecond';

    due_on := (period_month + interval '1 month' + interval '6 days')::date;
    if latest_due is not null and due_on <= latest_due then
      due_on := latest_due + 1;
    end if;

    new_id := gen_random_uuid();
    generated_ref := 'REM-' || to_char(due_on, 'YYYYMMDD') || '-' ||
      upper(substr(replace(new_id::text, '-', ''), 1, 8));

    insert into public.booking_fee_remittances (
      id,
      remittance_ref,
      cycle_due_on,
      cutoff_at,
      status,
      prepared_at,
      prepared_by_user_id,
      prepared_by_email,
      prepared_by_role,
      prepare_idempotency_key,
      owner_override,
      owner_override_reason
    ) values (
      new_id,
      generated_ref,
      due_on,
      cutoff_time,
      'prepared',
      run_time,
      p_actor_user_id,
      actor_email,
      coalesce(nullif(trim(p_actor_role), ''), 'system'),
      'month-close-' || to_char(period_month, 'YYYY-MM') || '-' || substr(new_id::text, 1, 8),
      false,
      null
    );

    insert into public.booking_fee_remittance_items (
      remittance_id,
      booking_ref,
      booking_group_ref,
      booking_created_at,
      fee_earned_at,
      court_id,
      court_name,
      booking_date,
      host_booking,
      created_via,
      fee_amount,
      fee_rate,
      fee_type,
      fee_units,
      fee_snapshot_source
    )
    select
      new_id,
      u.booking_ref,
      u.booking_group_ref,
      u.booking_created_at,
      u.fee_earned_at,
      u.court_id,
      u.court_name,
      u.booking_date,
      u.host_booking,
      u.created_via,
      round(u.fee_amount, 2),
      round(u.fee_rate, 2),
      u.fee_type,
      u.fee_units,
      u.fee_snapshot_source
    from public.booking_fee_unclaimed_rows() u
    where u.fee_earned_at <= cutoff_time
    order by u.fee_earned_at, u.booking_created_at, u.booking_ref
    on conflict (booking_ref) where released_at is null do nothing;

    select count(*)::integer,
           coalesce(round(sum(i.fee_amount), 2), 0),
           min(i.fee_earned_at)
      into item_count, total_due, coverage_start
      from public.booking_fee_remittance_items i
     where i.remittance_id = new_id
       and i.released_at is null;

    update public.booking_fee_remittances r
       set bookings_count = item_count,
           amount_due = total_due,
           coverage_start_at = coverage_start,
           status = case when total_due = 0 then 'settled' else 'prepared' end,
           settled_at = case when total_due = 0 then run_time else null end
     where r.id = new_id;

    insert into public.booking_fee_remittance_events (
      remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
    ) values (
      new_id,
      'prepared',
      p_actor_user_id,
      coalesce(nullif(trim(p_actor_role), ''), 'system'),
      run_time,
      jsonb_build_object(
        'cycle_due_on', due_on,
        'cutoff_at', cutoff_time,
        'bookings_count', item_count,
        'amount_due', total_due,
        'owner_override', false,
        'month_end_close', true,
        'period_month', to_char(period_month, 'YYYY-MM')
      )
    );

    if total_due = 0 then
      insert into public.booking_fee_remittance_events (
        remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
      ) values (
        new_id,
        'zero_balance_settled',
        p_actor_user_id,
        coalesce(nullif(trim(p_actor_role), ''), 'system'),
        run_time,
        jsonb_build_object('amount_due', 0)
      );
    end if;

    created := created || jsonb_build_array(jsonb_build_object(
      'id', new_id,
      'remittance_ref', generated_ref,
      'period_month', to_char(period_month, 'YYYY-MM'),
      'cutoff_at', cutoff_time,
      'cycle_due_on', due_on,
      'bookings_count', item_count,
      'amount_due', total_due
    ));
  end loop;

  return jsonb_build_object(
    'created', created,
    'server_now', run_time,
    'timezone', 'Asia/Manila'
  );
end;
$$;

create or replace function public.run_booking_fee_month_end_close()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_account_role() is distinct from 'owner' then
    raise exception 'Only the System Owner can run the month-end close.'
      using errcode = '42501';
  end if;
  return public.close_booking_fee_ended_months_internal(auth.uid(), 'owner');
end;
$$;

create or replace function public.record_booking_fee_remittance_payment(
  p_remittance_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_payment_reference text,
  p_proof_path text,
  p_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment public.booking_fee_remittance_payments%rowtype;
begin
  if public.current_account_role() is distinct from 'owner' then
    raise exception 'Only the System Owner can record a remittance payment directly.'
      using errcode = '42501';
  end if;

  -- Reuses every validation of a normal submission (amount, reference,
  -- proof path ownership, duplicate references, idempotent retries).
  perform public.submit_booking_fee_remittance(
    p_remittance_id,
    p_amount,
    p_payment_method,
    p_payment_reference,
    p_proof_path,
    p_note,
    p_idempotency_key
  );

  select p.* into payment
    from public.booking_fee_remittance_payments p
   where p.submitted_by_user_id = auth.uid()
     and p.submission_idempotency_key = trim(p_idempotency_key)
   limit 1;
  if not found then
    raise exception 'Recorded payment was not found.' using errcode = 'P0002';
  end if;
  if payment.status <> 'pending' then
    return public.get_booking_fee_remittance_detail(payment.remittance_id);
  end if;

  return public.review_booking_fee_remittance_payment(
    payment.id,
    'accept',
    payment.amount_submitted,
    'Recorded by the System Owner on behalf of the court owner.',
    'record-' || md5(trim(p_idempotency_key))
  );
end;
$$;

revoke all on function public.close_booking_fee_ended_months_internal(uuid, text)
  from public, anon, authenticated;
revoke all on function public.run_booking_fee_month_end_close()
  from public, anon, authenticated;
grant execute on function public.run_booking_fee_month_end_close()
  to authenticated;
revoke all on function public.record_booking_fee_remittance_payment(uuid, numeric, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_booking_fee_remittance_payment(uuid, numeric, text, text, text, text, text)
  to authenticated;

comment on function public.close_booking_fee_ended_months_internal(uuid, text) is
  'Freezes every ended Asia/Manila month with unclaimed booking fees into its own remittance (cutoff at month end, due on the 7th). Internal; run by pg_cron and the System Owner RPC.';
comment on function public.run_booking_fee_month_end_close() is
  'System-owner-only on-demand month-end close. Idempotent: months already closed are skipped.';
comment on function public.record_booking_fee_remittance_payment(uuid, numeric, text, text, text, text, text) is
  'System-owner-only: submits payment proof on behalf of the court owner and accepts it in the same transaction.';

-- Daily at 00:05 Asia/Manila (16:05 UTC). Running daily instead of monthly
-- means a missed run is caught up the next night. Re-running reuses the job.
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'booking-fee-month-end-close',
      '5 16 * * *',
      $job$select public.close_booking_fee_ended_months_internal(null, 'system');$job$
    );
  else
    raise notice 'pg_cron is not enabled; enable it and rerun this block to schedule booking-fee-month-end-close.';
  end if;
end;
$cron$;

notify pgrst, 'reload schema';

commit;
