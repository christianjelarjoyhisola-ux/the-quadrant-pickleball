// Run the actual scheduler SQL and claim RPC in isolated PostgreSQL. The HTTP
// function below only writes to an in-memory table; no network or secrets exist.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const schedule = readFileSync(new URL('./setup-owner-telegram-schedule.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261025080000_owner_telegram_notifications.sql', import.meta.url), 'utf8');
const job = schedule.match(/\$job\$([\s\S]*?)\$job\$/)?.[1];
const claim = migration.match(/create or replace function public\.claim_owner_telegram_notifications\([\s\S]*?\n\$\$;/)?.[0];
assert.ok(job, 'The deployed schedule must contain its worker SQL');
assert.ok(claim, 'Test the actual migration claim RPC');
assert.match(schedule, /'owner-telegram-notifications',\s*'\* \* \* \* \*'/, 'Keep checks every minute');

const db = new PGlite();
try {
  await db.exec(`
    create table public.owner_telegram_notifications (
      id uuid primary key default gen_random_uuid(), status text not null,
      attempts integer not null, available_at timestamptz not null,
      locked_until timestamptz, first_attempt_at timestamptz,
      lease_token uuid, last_error text, payload jsonb, created_at timestamptz default now()
    );
    create schema vault;
    create table vault.decrypted_secrets(name text, decrypted_secret text);
    insert into vault.decrypted_secrets values
      ('owner_telegram_worker_url', 'https://offline.example.test/worker'),
      ('owner_telegram_worker_secret', 'offline-placeholder');
    create schema net;
    create table net.requests(id bigint generated always as identity, body jsonb, timeout_ms integer);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
      returns bigint language sql volatile as $$
        insert into net.requests(body, timeout_ms) values(body, timeout_milliseconds) returning id
      $$;
  `);
  await db.exec(claim);

  const rows = async () => (await db.query('select * from public.owner_telegram_notifications order by id')).rows;
  const requests = async () => (await db.query('select * from net.requests')).rows;
  await db.exec(job);
  assert.equal((await requests()).length, 0, 'An empty queue causes no HTTP invocation');

  // The RPC is the oracle: wake if and only if a claim or terminal cleanup
  // changes a row. A transaction keeps now() identical for boundary checks.
  let combinations = 0;
  for (const status of ['queued', 'sending', 'sent', 'failed', 'skipped']) {
    for (const availability of ['now()', "now() + interval '1 hour'"]) {
      for (const lease of ['null', 'now()', "now() + interval '1 minute'"]) {
        for (const attempts of [0, 4, 5]) {
          for (const firstAttempt of ['null', "now() - interval '23 hours' + interval '1 second'", "now() - interval '23 hours'", "now() - interval '24 hours'"]) {
            const label = JSON.stringify({ status, availability, lease, attempts, firstAttempt });
            await db.exec('begin');
            try {
              await db.query(`insert into public.owner_telegram_notifications(status, attempts, available_at, locked_until, first_attempt_at)
                values($1, $2, ${availability}, ${lease}, ${firstAttempt})`, [status, attempts]);
              const before = await rows();
              await db.exec(job);
              const calls = await requests();
              await db.query('select * from public.claim_owner_telegram_notifications(3)');
              const changed = JSON.stringify(before) !== JSON.stringify(await rows());
              assert.equal(calls.length, changed ? 1 : 0, label);
              if (calls.length) {
                assert.deepEqual(calls[0].body, { action: 'process' });
                assert.equal(calls[0].timeout_ms, 120000);
              }
              combinations++;
            } finally {
              await db.exec('rollback');
            }
          }
        }
      }
    }
  }

  // An uncertain dispatch must be finalized even if its retry is not due yet.
  await db.exec(`insert into public.owner_telegram_notifications(status,attempts,available_at,payload)
    values('queued',1,now()+interval '1 hour','{"dispatch":"started"}')`);
  await db.exec(job);
  assert.equal((await requests()).length,1);
  assert.equal((await db.query('select * from public.claim_owner_telegram_notifications(3)')).rows.length,0);
  assert.equal((await rows())[0].status,'failed');
  await db.exec('truncate public.owner_telegram_notifications, net.requests');

  await db.exec(`insert into public.owner_telegram_notifications(status, attempts, available_at)
    select 'queued', 0, now() from generate_series(1, 10)`);
  await db.exec(job);
  assert.equal((await requests()).length, 1, 'A backlog queues only one worker invocation per check');
  assert.equal((await db.query('select * from public.claim_owner_telegram_notifications(3)')).rows.length, 3);
  console.log(`Owner Telegram schedule: empty queue, ${combinations} claim/cleanup states, and backlog passed.`);
} finally {
  await db.close();
}
