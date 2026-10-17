// Executes the migration against isolated, in-memory PostgreSQL (PGlite).
// No Supabase credentials, production connections, or real emails are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = readFileSync(new URL('../supabase/migrations/20261017080000_owner_email_notifications.sql', import.meta.url), 'utf8');
const owner = '10000000-0000-0000-0000-000000000001';
const courtOwner = '10000000-0000-0000-0000-000000000002';
const disabledOwner = '10000000-0000-0000-0000-000000000003';
const staff = '10000000-0000-0000-0000-000000000004';
const sql = (text, args = []) => db.query(text, args);
const scalar = async (text, args) => Object.values((await sql(text, args)).rows[0])[0];
async function asRole(role = 'postgres', id = '') {
  await db.exec('reset role');
  await sql("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function denied(action, message) {
  await assert.rejects(action, error => error.code === '42501', message);
}
async function invalid(action) {
  await assert.rejects(action, error => ['23514', '23502'].includes(error.code));
}
const insertBooking = (ref, options = {}) => sql(`
  insert into public.bookings (ref,booking_group_ref,full_name,email,status,payment_status)
  values ($1,$2,$3,$4,$5,$6)`, [
  ref, options.group ?? null, options.name ?? 'Offline Customer', options.email ?? 'customer@example.test',
  options.status ?? 'pending', options.payment ?? 'unpaid',
]);

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    grant usage on schema auth, public to anon, authenticated, service_role;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table public.accounts (id uuid primary key references auth.users(id), role text not null);
    create function public.current_account_role() returns text language sql stable security definer
      set search_path=public as $$ select a.role from public.accounts a where a.id=auth.uid() limit 1 $$;
    create function public.has_account_role(allowed_roles text[]) returns boolean language sql stable security definer
      set search_path=public as $$ select coalesce(public.current_account_role()=any(allowed_roles),false) $$;
    create table public.bookings (
      ref text primary key, booking_group_ref text, full_name text, email text,
      status text, payment_status text, receipt_status text, receipt_flags text[]
    );
    create table public.open_play_registrations (
      id bigint generated always as identity primary key, full_name text, email text,
      payment_status text, receipt_status text
    );
    grant select,insert,update on public.bookings to anon,authenticated;
  `);
  for (const [id, role] of [[owner, 'owner'], [courtOwner, 'court_owner'], [disabledOwner, 'owner'], [staff, 'staff']]) {
    await sql('insert into auth.users values ($1)', [id]);
    await sql('insert into public.accounts values ($1,$2)', [id, role]);
  }
  await db.exec(migration);

  await asRole('authenticated', owner);
  await sql('insert into public.owner_email_preferences(user_id,emails,enabled) values ($1,$2,true)', [owner, [' Owner@Example.test ']]);
  assert.deepEqual(await scalar('select emails from public.owner_email_preferences'), ['owner@example.test']);
  await asRole('authenticated', courtOwner);
  await sql('insert into public.owner_email_preferences(user_id,emails,enabled,notify_new) values ($1,$2,true,false)', [courtOwner, ['court@example.test', 'backup@example.test']]);
  // Match supabase-js upsert: the conflict update includes user_id itself.
  await sql(`insert into public.owner_email_preferences(user_id,emails,enabled,notify_new,notify_pending)
    values ($1,$2,true,false,true) on conflict(user_id) do update set
      user_id=excluded.user_id,emails=excluded.emails,enabled=excluded.enabled,
      notify_new=excluded.notify_new,notify_pending=excluded.notify_pending`, [courtOwner, ['court@example.test', 'backup@example.test']]);
  await denied(() => sql('update public.owner_email_preferences set user_id=$1', [disabledOwner]), 'Upsert permission cannot transfer preferences to another user');
  assert.equal(await scalar('select count(*)::int from public.owner_email_preferences'), 1);
  assert.equal((await sql('update public.owner_email_preferences set enabled=false where user_id=$1 returning user_id', [owner])).rows.length, 0);
  await denied(() => sql('insert into public.owner_email_preferences(user_id) values ($1)', [disabledOwner]));
  await denied(() => sql('update public.owner_email_preferences set last_test_at=now()'), 'Users cannot bypass the server test-email throttle');
  await denied(() => sql('select payload from public.owner_email_notifications'));
  await denied(() => sql('select * from public.claim_owner_email_notifications()'));
  await denied(() => sql('select public.reserve_owner_email_test($1)', [courtOwner]));

  for (const addresses of [
    ['one@example.test', 'two@example.test', 'three@example.test', 'four@example.test'],
    ['same@example.test', 'SAME@example.test'], ['invalid'], [''], [null],
    ['injected\r\nBcc:attacker@example.test'],
  ]) {
    await invalid(() => sql('update public.owner_email_preferences set emails=$1', [addresses]));
  }
  await invalid(() => sql("update public.owner_email_preferences set emails='{}'"));
  await invalid(() => sql('update public.owner_email_preferences set emails=null'));
  await invalid(() => sql("update public.owner_email_preferences set emails=ARRAY[['one@example.test','two@example.test']]"));
  await asRole('authenticated', staff);
  assert.equal(await scalar('select count(*)::int from public.owner_email_preferences'), 0);
  await denied(() => sql('insert into public.owner_email_preferences(user_id,emails,enabled) values ($1,$2,true)', [staff, ['staff@example.test']]));
  await denied(() => sql('select * from public.get_owner_email_notification_log()'));
  await asRole('anon');
  await denied(() => sql('select * from public.owner_email_preferences'));
  await denied(() => sql('select * from public.owner_email_notifications'));
  await denied(() => sql('select * from public.get_owner_email_notification_log()'));
  await denied(() => sql('select * from public.claim_owner_email_notifications()'));
  await denied(() => sql('insert into public.owner_email_preferences(user_id) values ($1)', [staff]));
  await asRole();
  await sql('insert into public.owner_email_preferences(user_id,emails) values ($1,$2)', [disabledOwner, ['disabled@example.test']]);
  // Even a leftover preference after demotion must not receive alerts.
  await sql('insert into public.owner_email_preferences(user_id,emails,enabled) values ($1,$2,true)', [staff, ['staff@example.test']]);

  await asRole('anon');
  await insertBooking('hold', { name: 'Reserving…', email: 'reserve@hold.internal', status: 'verifying' });
  await insertBooking('cancelled-import', { status: 'cancelled' });
  await sql("update public.bookings set status='cancelled' where ref='hold'");
  await asRole();
  assert.equal(await scalar('select count(*)::int from public.owner_email_notifications'), 0);

  // Placeholder -> real UPDATE, including service-side PayMongo identity recovery.
  await insertBooking('hold-real', { group: 'GROUP-1', name: 'Reserving...', email: 'reserve@hold.internal', status: 'verifying' });
  await asRole('anon');
  await sql("update public.bookings set full_name='Offline Customer',email='customer@example.test' where ref='hold-real'");
  await asRole();
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1' and event='new_booking' and user_id=$1", [owner]), 1);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1' and event='pending' and user_id=$1", [courtOwner]), 1, 'Pending-only preference receives the initial pending booking');
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where user_id in ($1,$2)", [staff, disabledOwner]), 0);
  await insertBooking('group-second', { group: 'GROUP-1' });
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1'"), 2, 'One initial email per recipient/group, not both new and pending');
  await sql("update public.owner_email_notifications set available_at=now()-interval '1 minute' where entity_key='GROUP-1'");
  await sql("update public.bookings set receipt_status='manual_review',receipt_flags=ARRAY['unreadable'] where ref='hold-real'");
  assert.equal(await scalar("select bool_and(available_at > now()+interval '14 seconds') from public.owner_email_notifications where entity_key='GROUP-1'"), true);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1'"), 2, 'Review transition coalesces with the queued initial alert');

  // Owner confirmations/cancellations are never queued.
  await sql("update public.bookings set status='confirmed',payment_status='paid' where booking_group_ref='GROUP-1'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1'"), 2);
  await sql("update public.bookings set status='cancelled' where booking_group_ref='GROUP-1'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1'"), 2);
  // A later pending transition can alert once after the initial alert was sent.
  await sql("update public.owner_email_notifications set status='sent',sent_at=now() where entity_key='GROUP-1'");
  await sql("update public.bookings set status='pending',payment_status='for_verification' where booking_group_ref='GROUP-1'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1' and status<>'sent'"), 1);
  await sql("update public.bookings set receipt_status='manual_review' where booking_group_ref='GROUP-1'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1'"), 3, 'Separate review metadata and group updates do not duplicate alerts');
  await sql("update public.owner_email_notifications set status='sent',sent_at=now() where entity_key='GROUP-1'");
  await sql("update public.bookings set payment_status='for_verification' where booking_group_ref='GROUP-1'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='GROUP-1' and status<>'sent'"), 0, 'Repeated webhooks cannot recreate sent events');

  // An already-confirmed new booking is still new; later confirmation is not.
  await insertBooking('confirmed-new', { status: 'confirmed', payment: 'paid' });
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='confirmed-new' and event='new_booking'"), 1);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='confirmed-new' and user_id=$1", [courtOwner]), 0);

  // A payment-review transition can follow an already-sent initial pending row.
  await insertBooking('later-review');
  await sql("update public.owner_email_notifications set status='sent',sent_at=now() where entity_key='later-review'");
  await sql("update public.bookings set payment_status='for_verification' where ref='later-review'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='later-review' and event='pending' and user_id=$1", [owner]), 1);
  await sql("update public.bookings set receipt_status='manual_review' where ref='later-review'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='later-review'"), 3);

  await sql('update public.owner_email_preferences set notify_pending=false where user_id=$1', [owner]);
  await insertBooking('new-only');
  await sql("update public.owner_email_notifications set status='sent',sent_at=now() where entity_key='new-only'");
  await sql("update public.bookings set payment_status='for_verification' where ref='new-only'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='new-only' and user_id=$1", [owner]), 1, 'New-only preference does not receive later review alerts');
  await sql('update public.owner_email_preferences set notify_pending=true where user_id=$1', [owner]);

  await insertBooking('old-unrelated-edit');
  await sql("delete from public.owner_email_notifications where entity_key='old-unrelated-edit'");
  await sql("update public.bookings set full_name='Corrected Customer Name' where ref='old-unrelated-edit'");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='old-unrelated-edit'"), 0, 'Unrelated edits never backfill historical bookings');

  // Existing booking/group refs are unrestricted text: notification constraints
  // must not roll back valid booking writes after an owner enables alerts.
  const longRef = 'R'.repeat(201);
  const longGroup = 'G'.repeat(201);
  await asRole('anon');
  await insertBooking(longRef);
  await insertBooking('long-group-first', { group: longGroup });
  await insertBooking('long-group-second', { group: longGroup });
  await insertBooking('');
  await sql("update public.bookings set payment_status='for_verification' where ref=$1", [longRef]);
  await asRole();
  for (const key of [longRef, longGroup, '']) {
    assert.equal(await scalar('select count(*)::int from public.owner_email_notifications where entity_key=$1', [key]), 2, 'Long and legacy empty refs preserve booking writes and group deduplication');
  }
  assert.equal(await scalar('select count(*)::int from public.bookings where ref in ($1,$2,$3,$4)', [longRef, 'long-group-first', 'long-group-second', '']), 4);

  // A repeated-character fixture compresses in PostgreSQL and misses B-tree
  // tuple limits. This deterministic 10k key exercises incompressible text.
  const hugeGroup = Array.from({ length: 313 }, (_, i) => createHash('sha256').update(`owner-email-group-${i}`).digest('hex')).join('').slice(0, 10000);
  assert.equal(hugeGroup.length, 10000);
  await asRole('anon');
  try {
    await insertBooking('huge-group-first', { group: hugeGroup });
    await insertBooking('huge-group-second', { group: hugeGroup });
    await sql("update public.bookings set payment_status='for_verification' where ref='huge-group-first'");
  } catch (error) {
    // Keep the diagnostic useful without dumping the 10k test SQL parameter.
    throw new Error(`Incompressible group reference failed: ${error.code}: ${error.message}`);
  }
  await asRole();
  assert.equal(await scalar('select count(*)::int from public.bookings where booking_group_ref=$1', [hugeGroup]), 2);
  assert.equal(await scalar('select count(*)::int from public.owner_email_notifications where entity_key=$1', [hugeGroup]), 2, 'Large exact group keys retain original text and deduplicate');
  assert.equal(await scalar("select encode(entity_key_hash,'hex') from public.owner_email_notifications where entity_key=$1 limit 1", [hugeGroup]), createHash('sha256').update(hugeGroup).digest('hex'));
  const anotherHugeGroup = `${hugeGroup.slice(0, -1)}${hugeGroup.endsWith('a') ? 'b' : 'a'}`;
  await insertBooking('huge-group-distinct', { group: anotherHugeGroup });
  assert.equal(await scalar('select count(*)::int from public.owner_email_notifications where entity_key=$1', [anotherHugeGroup]), 2, 'Similar long keys remain distinct');

  // Open Play does not have a booking status column: payment state is authoritative.
  const opId = await scalar("insert into public.open_play_registrations(full_name,email,payment_status) values('Open Player','op@example.test','pending') returning id");
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_type='open_play' and entity_key=$1", [String(opId)]), 2);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_type='open_play' and entity_key=$1 and event='new_booking'", [String(opId)]), 1);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_type='open_play' and entity_key=$1 and event='pending'", [String(opId)]), 1);
  await sql("update public.open_play_registrations set payment_status='paid' where id=$1", [opId]);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_type='open_play'"), 2);
  await sql("update public.open_play_registrations set payment_status='rejected' where id=$1", [opId]);
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_type='open_play'"), 2);

  // A rollback rolls the outbox back too; email is never queued for a failed save.
  await db.exec('begin');
  await insertBooking('rolled-back');
  await db.exec('rollback');
  assert.equal(await scalar("select count(*)::int from public.owner_email_notifications where entity_key='rolled-back'"), 0);

  // Test-email slot is service-only, atomic, and allows testing before enabling.
  await asRole('service_role');
  assert.equal(await scalar('select public.reserve_owner_email_test($1)', [disabledOwner]), true);
  assert.equal(await scalar('select public.reserve_owner_email_test($1)', [disabledOwner]), false);
  assert.equal(await scalar('select public.reserve_owner_email_test($1)', [staff]), false);
  await sql("update public.owner_email_preferences set last_test_at=now()-interval '61 seconds' where user_id=$1", [disabledOwner]);
  assert.equal(await scalar('select public.reserve_owner_email_test($1)', [disabledOwner]), true);

  // Claim respects the coalescing window. Then claim disjoint jobs and lease them.
  assert.equal((await sql('select * from public.claim_owner_email_notifications()')).rows.length, 0);
  await sql("update public.owner_email_notifications set available_at=now()-interval '1 second' where status='queued'");
  const claimed = (await sql('select * from public.claim_owner_email_notifications(1)')).rows;
  assert.equal(claimed.length, 1);
  const job = claimed[0];
  assert.equal(job.status, 'sending');
  assert.equal(job.attempts, 1);
  assert(job.first_attempt_at && job.lease_token);
  assert.equal(await scalar("select locked_until > now()+interval '4 minutes 59 seconds' from public.owner_email_notifications where id=$1", [job.id]), true);
  const secondClaim = (await sql('select * from public.claim_owner_email_notifications(1)')).rows;
  assert.equal(secondClaim.length, 1);
  assert.notEqual(secondClaim[0].id, job.id);

  // Persist the exact frozen provider payload, expire lease, and recover it.
  const frozen = { version: 1, body: '{"to":["owner@example.test"],"subject":"Offline test"}' };
  await sql("update public.owner_email_notifications set payload=$1,locked_until=now()-interval '1 second' where id=$2 and lease_token=$3 and status='sending'", [frozen, job.id, job.lease_token]);
  const recovered = (await sql('select * from public.claim_owner_email_notifications(10)')).rows.find(row => row.id === job.id);
  assert(recovered);
  assert.equal(recovered.attempts, 2);
  assert.notEqual(recovered.lease_token, job.lease_token);
  assert.equal(recovered.idempotency_key, job.idempotency_key);
  assert.deepEqual(recovered.payload, frozen);
  assert.equal((await sql("update public.owner_email_notifications set status='sent' where id=$1 and lease_token=$2 and status='sending' returning id", [job.id, job.lease_token])).rows.length, 0, 'Stale worker cannot complete a reclaimed job');
  assert.equal((await sql("update public.owner_email_notifications set status='sent',sent_at=now(),provider_id='offline-message' where id=$1 and lease_token=$2 and status='sending' returning id", [job.id, recovered.lease_token])).rows.length, 1);

  // Terminal retry limits never create a sixth attempt or cross 23 hours.
  await sql("update public.owner_email_notifications set attempts=5,locked_until=now()-interval '1 second' where id=$1", [secondClaim[0].id]);
  await sql('select * from public.claim_owner_email_notifications()');
  assert.equal(await scalar('select status from public.owner_email_notifications where id=$1', [secondClaim[0].id]), 'failed');
  await asRole();
  await insertBooking('age-limit');
  await sql("update public.owner_email_notifications set first_attempt_at=now()-interval '23 hours',attempts=1,available_at=now() where entity_key='age-limit'");
  await asRole('service_role');
  const afterAgeLimit = (await sql('select * from public.claim_owner_email_notifications()')).rows;
  assert(!afterAgeLimit.some(row => row.entity_key === 'age-limit'));
  assert.equal(await scalar("select bool_and(status='failed') from public.owner_email_notifications where entity_key='age-limit'"), true);

  // Logs expose only own sanitized metadata, with no payload/recipient/entity data.
  await sql("update public.owner_email_notifications set last_error='provider raw: secret-token customer@example.test' where user_id=$1", [owner]);
  await asRole('authenticated', owner);
  const logs = (await sql('select * from public.get_owner_email_notification_log()')).rows;
  assert(logs.length > 0);
  for (const log of logs) {
    assert.deepEqual(Object.keys(log).sort(), ['id', 'event', 'status', 'attempts', 'last_error', 'sent_at', 'created_at'].sort());
    assert(!JSON.stringify(log).includes('secret-token'));
    assert(!JSON.stringify(log).includes('@example.test'));
  }
  await asRole();
  const ownCount = await scalar('select count(*)::int from public.owner_email_notifications where user_id=$1', [owner]);
  assert.equal(logs.length, ownCount);
  assert.equal(await scalar("select provolatile from pg_proc where oid='public.get_owner_email_notification_log()'::regprocedure"), 's');
  console.log('Owner email SQL checks passed: private preferences, validation, roles, placeholder/group events, Open Play, rollback, dedupe, claims/leases, frozen retries, limits, throttle, and sanitized logs.');
} finally {
  await db.close();
}
