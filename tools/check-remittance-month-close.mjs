// Executes the month-end remittance close migration against isolated,
// in-memory PostgreSQL (PGlite). No Supabase credentials are used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFileSync(new URL(`../supabase/migrations/${path}`, import.meta.url), 'utf8');
const base = read('20260713213000_accumulated_booking_fee_remittances.sql');
const dueDates = read('20260730213000_owner_selectable_remittance_due_date.sql');
const migration = read('20261102090000_month_end_remittance_close.sql');

// Slice one statement out of an existing migration so the real ledger tables,
// submission and review functions are exercised rather than copies.
function slice(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `Missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to >= 0, `Missing end of ${start}`);
  return source.slice(from, to + end.length);
}
const fn = (source, name) => slice(source, `create or replace function public.${name}`, '\n$$;');

const db = new PGlite();
const owner = '10000000-0000-0000-0000-000000000001';
const courtOwner = '10000000-0000-0000-0000-000000000002';
const sql = (text, args = []) => db.query(text, args);
const rows = async (text, args) => (await sql(text, args)).rows;
const scalar = async (text, args) => Object.values((await sql(text, args)).rows[0])[0];
async function asRole(role = 'postgres', id = '') {
  await db.exec('reset role');
  await sql("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}

try {
  await db.exec(`
    set check_function_bodies = off;
    create role anon;
    create role authenticated;
    create schema auth;
    create schema storage;
    grant usage on schema auth, public, storage to anon, authenticated;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table storage.objects (bucket_id text, name text);
    create table public.accounts (id uuid primary key, email text, role text not null);
    create function public.current_account_role() returns text language sql stable security definer
      set search_path=public as $$ select a.role from public.accounts a where a.id=auth.uid() limit 1 $$;
    create table public.settings (key text primary key, value text, updated_at timestamptz);
    create table public.booking_fee_remittance_due_date_events (
      id bigserial primary key, previous_due_on date, new_due_on date, change_source text,
      actor_user_id uuid, actor_role text, changed_at timestamptz, metadata jsonb
    );
    create table public.test_fees (ref text primary key, earned_at timestamptz, amount numeric);
    create function public.booking_fee_unclaimed_rows()
    returns table (
      booking_ref text, booking_group_ref text, booking_created_at timestamptz, fee_earned_at timestamptz,
      court_id text, court_name text, booking_date date, host_booking boolean, created_via text,
      fee_amount numeric, fee_rate numeric, fee_type text, fee_units numeric, fee_snapshot_source text
    ) language sql stable security definer set search_path = public as $$
      select f.ref, null, f.earned_at, f.earned_at, 'c1', 'Court 1', f.earned_at::date, false, 'online',
             f.amount, 15, 'per_hour', f.amount / 15, 'test'
        from public.test_fees f
       where not exists (select 1 from public.booking_fee_remittance_items i
                          where i.booking_ref = f.ref and i.released_at is null)
       order by f.earned_at, f.ref
    $$;
    create function public.get_booking_fee_remittance_detail(p_remittance_id uuid) returns jsonb
      language sql stable as $$ select jsonb_build_object('id', p_remittance_id) $$;
  `);
  await db.exec(slice(base, 'create table if not exists public.booking_fee_remittances (', 'on public.booking_fee_remittance_events (remittance_id, event_at, id);'));
  for (const name of ['submit_booking_fee_remittance', 'review_booking_fee_remittance_payment']) await db.exec(fn(base, name));
  for (const name of ['booking_fee_monthly_due_after', 'advance_booking_fee_remittance_due_on']) await db.exec(fn(dueDates, name));
  await db.exec(slice(dueDates, 'create trigger booking_fee_remittance_advance_due_date', 'execute function public.advance_booking_fee_remittance_due_on();'));
  await db.exec(`grant select on all tables in schema public to authenticated;`);
  await db.exec(migration);

  await sql(`insert into public.accounts values ($1,'owner@example.test','owner'), ($2,'court@example.test','court_owner')`, [owner, courtOwner]);
  await sql(`insert into public.settings values ('booking_fee_remittance_due_on', '2000-01-30', now())`);

  // Months are computed in Manila local time, exactly like the migration.
  const local = `date_trunc('month', timezone('Asia/Manila', now()))`;
  await db.exec(`
    insert into public.test_fees values
      ('two-months-ago', ((${local} - interval '2 months') + interval '10 days') at time zone 'Asia/Manila', 100),
      ('last-month',     ((${local} - interval '1 month') + interval '3 days') at time zone 'Asia/Manila', 50),
      ('last-second',    (${local} at time zone 'Asia/Manila') - interval '1 second', 25),
      ('this-month',     now() - interval '1 second', 15);
  `);

  await asRole('authenticated', courtOwner);
  await assert.rejects(sql('select public.run_booking_fee_month_end_close()'), e => e.code === '42501',
    'A court owner must not run the month-end close.');
  await assert.rejects(sql(`select public.close_booking_fee_ended_months_internal(null, 'system')`), e => e.code === '42501',
    'Clients must not call the internal close directly.');

  await asRole('authenticated', owner);
  const first = await scalar('select public.run_booking_fee_month_end_close()');
  assert.equal(first.created.length, 2, 'Each ended month must become its own batch.');

  await asRole();
  const batches = await rows(`
    select r.amount_due::numeric as amount, r.bookings_count, r.cycle_due_on::text as due, r.prepared_by_role,
           to_char(timezone('Asia/Manila', r.cutoff_at), 'DD HH24:MI:SS.US') as cutoff_local,
           timezone('Asia/Manila', r.cutoff_at)::date = (date_trunc('month', timezone('Asia/Manila', r.cutoff_at)) + interval '1 month - 1 day')::date as month_end,
           extract(day from r.cycle_due_on)::int as due_day
      from public.booking_fee_remittances r order by r.cutoff_at`);
  assert.deepEqual(batches.map(b => Number(b.amount)), [100, 75], 'Fees must split at the exact month boundary.');
  for (const b of batches) {
    assert.ok(b.month_end && b.cutoff_local.endsWith('23:59:59.999999'), `Cutoff must be the last instant of the month (${b.cutoff_local}).`);
    assert.equal(b.due_day, 7, 'Month-end batches are due on the 7th.');
    assert.equal(b.prepared_by_role, 'owner');
  }
  assert.equal(await scalar(`select count(*)::int from public.booking_fee_unclaimed_rows()`), 1,
    'The current month must stay in the live balance.');
  assert.equal(await scalar(`select value from public.settings where key='booking_fee_remittance_due_on'`),
    await scalar(`select ((max(cycle_due_on) + interval '1 month')::date)::text from public.booking_fee_remittances`),
    'The next due date must advance past the newest batch.');

  const again = await scalar(`select public.close_booking_fee_ended_months_internal(null, 'system')`);
  assert.equal(again.created.length, 0, 'Re-running the close must not create duplicate batches.');

  // System Owner records the court owner's payment for the older batch.
  const target = await scalar(`select id from public.booking_fee_remittances order by cutoff_at limit 1`);
  const proof = `${target}/${owner}/receipt.png`;
  await sql(`insert into storage.objects values ('remittance-proofs', $1)`, [proof]);

  await asRole('authenticated', courtOwner);
  await assert.rejects(
    sql(`select public.record_booking_fee_remittance_payment($1, 100, 'gcash', 'GC123456', $2, null, 'record-test-key-1')`, [target, proof]),
    e => e.code === '42501', 'Only the System Owner may record and accept a payment.');

  await asRole('authenticated', owner);
  const args = [target, proof];
  const recordSql = `select public.record_booking_fee_remittance_payment($1, 100, 'gcash', 'GC123456', $2, 'Paid at the venue', 'record-test-key-1')`;
  await sql(recordSql, args);
  await sql(recordSql, args); // idempotent retry

  await asRole();
  const settled = (await rows(`select status, amount_settled::numeric as settled from public.booking_fee_remittances where id=$1`, [target]))[0];
  assert.equal(settled.status, 'settled');
  assert.equal(Number(settled.settled), 100);
  assert.equal(await scalar(`select count(*)::int from public.booking_fee_remittance_payments where remittance_id=$1 and status='accepted'`, [target]), 1);
  assert.deepEqual(
    (await rows(`select event_type from public.booking_fee_remittance_events where remittance_id=$1 order by id`, [target])).map(r => r.event_type),
    ['prepared', 'payment_submitted', 'payment_accepted', 'settled'],
    'Recording a payment must keep the full submission and review audit trail.');

  console.log('Month-end remittance close checks passed.');
} finally {
  await db.close();
}
