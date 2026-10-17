// Offline behavioral checks using the real Supabase client and a mocked network.
// No production requests, credentials, bookings, or payment writes are used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';

const source = readFileSync(new URL('../supabase-config.js', import.meta.url), 'utf8');
const storage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

function harness(respond) {
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    URLSearchParams, AbortController, structuredClone,
    console: { log() {}, warn() {}, error() {} },
    location: { hostname: 'thequadrant.club', search: '' },
    localStorage: storage(), sessionStorage: storage(),
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const request = { url: new URL(url), ...options, aborted: false };
      requests.push(request);
      return respond(request);
    },
    supabase: {
      createClient(url, key, options) {
        return createClient(url, key, {
          ...options,
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
      },
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  return { db: context.DB, requests, timers };
}

function stalled(request) {
  assert(request.signal, 'A stalled read must receive an abort signal');
  return new Promise((resolve, reject) => {
    const abort = () => {
      request.aborted = true;
      reject(new DOMException('The request was aborted', 'AbortError'));
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
}

async function until(predicate) {
  for (let i = 0; i < 20 && !predicate(); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert(predicate(), 'Expected the mocked request to start');
}

function success(request) {
  if (request.url.pathname.endsWith('/get_booking_fee_remittance_dashboard')) {
    return json({ accumulated: { amount: 120 }, open_remittances: [], settled_total: 0 });
  }
  if (request.url.pathname.endsWith('/get_booking_fee_remittance_detail')) return json({ id: 'test-id' });
  return json([]);
}

// A missing agreement differs from a failed agreement query.
const agreementError = harness(() => json({ code: '42501', message: 'Agreement read denied' }, 403));
await assert.rejects(agreementError.db.getAgreement('test-user', 13), error => error.message === 'Agreement read denied');
assert.equal(agreementError.timers.size, 0);
const agreementMissing = harness(() => json([]));
assert.equal(await agreementMissing.db.getAgreement('test-user', 13), null);
const agreementPresent = harness(() => json([{ id: 'agreement-id', full_name: 'Test', agreed_at: '2026-10-17' }]));
assert.equal((await agreementPresent.db.getAgreement('test-user', 13)).id, 'agreement-id');

// Successful reads preserve data and cursor semantics while using bounded GETs.
const reads = harness(success);
const dashboard = await reads.db.getBookingFeeRemittanceDashboard();
assert.equal(dashboard.live.amount, 120);
await reads.db.getBookingFeeRemittanceHistory();
await reads.db.getBookingFeeRemittanceHistory({ limit: 150, before: '2026-10-16T03:00:00+08:00' });
assert.equal((await reads.db.getBookingFeeRemittanceDetail('test-id')).id, 'test-id');
const rpcRequests = reads.requests.filter(request => request.url.pathname.includes('/rpc/'));
assert.equal(rpcRequests.length, 5);
for (const request of rpcRequests) {
  assert.equal(request.method, 'GET');
  assert(request.signal);
  assert.equal(request.body, undefined);
}
const historyRequests = rpcRequests.filter(request => request.url.pathname.endsWith('/get_booking_fee_remittance_history'));
assert(!historyRequests[0].url.searchParams.has('p_before'));
assert(!historyRequests[1].url.searchParams.has('p_before'));
assert.equal(historyRequests[2].url.searchParams.get('p_before'), '2026-10-16T03:00:00+08:00');
assert.equal(historyRequests[2].url.searchParams.get('p_limit'), '100');
assert.equal(reads.timers.size, 0, 'Successful reads must release their deadline timers');

// Advance the fake 15-second clock and prove the actual network request aborts.
for (const [name, path, invoke] of [
  ['agreement', '/agreements', db => db.getAgreement('test-user', 13)],
  ['dashboard', '/get_booking_fee_remittance_dashboard', db => db.getBookingFeeRemittanceDashboard()],
  ['dashboard history', '/get_booking_fee_remittance_history', db => db.getBookingFeeRemittanceDashboard()],
  ['history', '/get_booking_fee_remittance_history', db => db.getBookingFeeRemittanceHistory()],
  ['detail', '/get_booking_fee_remittance_detail', db => db.getBookingFeeRemittanceDetail('test-id')],
]) {
  const test = harness(request => request.url.pathname.endsWith(path) ? stalled(request) : success(request));
  const pending = invoke(test.db);
  const rejection = assert.rejects(pending, error => /abort/i.test(error.message));
  await until(() => test.requests.some(request => request.url.pathname.endsWith(path)));
  await new Promise(resolve => setImmediate(resolve));
  const [timer] = [...test.timers.values()];
  assert(timer, `${name} must have a deadline`);
  assert.equal(timer.delay, 15000);
  timer.callback();
  await rejection;
  const targeted = test.requests.filter(request => request.url.pathname.endsWith(path));
  assert.equal(targeted.length, 1, `${name} must not retry an aborted request`);
  assert(targeted[0].aborted, `${name} must cancel its fetch`);
  assert.equal(test.timers.size, 0, `${name} must clean up its deadline`);
}

// Financial mutations remain POST and do not acquire read timeout/retry logic.
const mutation = harness(() => json({ due_on: '2026-10-30' }));
await mutation.db.setBookingFeeRemittanceDueDate('2026-10-30');
assert.equal(mutation.requests.length, 1);
assert.equal(mutation.requests[0].method, 'POST');
assert.equal(mutation.requests[0].signal, undefined);
assert.deepEqual(JSON.parse(mutation.requests[0].body), { p_due_on: '2026-10-30' });
assert.equal(mutation.timers.size, 0);

console.log('Backend read checks passed: agreement errors, RPC GET/cursors, five aborted reads, timer cleanup, and unchanged mutation POST.');
