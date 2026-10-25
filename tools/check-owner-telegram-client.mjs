// Real Supabase client with a fully mocked network and fake application clocks.
// No production request, credential, database write, or email is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';

const source = readFileSync(new URL('../supabase-config.js', import.meta.url), 'utf8');
const ownerId = '00000000-0000-4000-8000-000000000001';
const saved = { chat_id: '123456789', enabled: true, notify_auto_confirmed: true, notify_pending: false };
const copy = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

function harness(respond = request => {
  if (request.url.pathname.endsWith('/owner_telegram_preferences')) return json(request.method === 'POST' ? saved : [saved]);
  if (request.url.pathname.endsWith('/get_owner_telegram_notification_log')) return json([{ id: 'test-log', event: 'new_booking', status: 'queued' }]);
  return json({ ok: true, status: 'sent' });
}) {
  const requests = [], timers = new Map(), authCalls = [];
  let timerId = 0;
  const context = vm.createContext({
    URLSearchParams, AbortController, structuredClone,
    console: { log() {}, warn() {}, error() {} },
    location: { hostname: 'thequadrant.club', search: '' },
    localStorage: storage(), sessionStorage: storage(),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const request = { url: new URL(url), ...options, aborted: false };
      requests.push(request);
      return respond(request);
    },
    supabase: {
      createClient(url, key, options) {
        return createClient(url, key, { ...options, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      },
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  const auth = context._supabase.auth;
  auth.getUser = async () => { authCalls.push('getUser'); return { data: { user: { id: ownerId } }, error: null }; };
  auth.getSession = async () => { authCalls.push('getSession'); return { data: { session: { access_token: 'offline-test-token' } }, error: null }; };
  return {
    db: context.DB, requests, timers, auth, authCalls,
    expire(delay) {
      const due = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
      assert(due.length, `Expected a ${delay}ms application deadline`);
      for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
    },
  };
}

async function until(predicate) {
  for (let i = 0; i < 30 && !predicate(); i++) await settle();
  assert(predicate(), 'The mocked operation did not reach the expected state');
}
function neverRespond(request) {
  return new Promise((_, reject) => {
    if (!request.signal) return;
    const abort = () => { request.aborted = true; reject(new DOMException('The request was aborted', 'AbortError')); };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
}
function stalledBody() {
  return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } });
}

// Read/save payloads use the authenticated account and the new/pending contract.
{
  const h = harness();
  assert.deepEqual(copy(await h.db.getOwnerTelegramPreferences()), saved);
  const read = h.requests[0];
  assert.equal(read.method, 'GET');
  assert.equal(read.url.searchParams.get('user_id'), `eq.${ownerId}`);
  assert.equal(read.url.searchParams.get('select'), 'chat_id,enabled,notify_auto_confirmed,notify_pending,updated_at');
  await h.db.saveOwnerTelegramPreferences({
    user_id: 'another-account', chat_id: ' 123456789 ',
    enabled: true, notify_auto_confirmed: true, notify_pending: false, notify_confirmed: true, notify_cancelled: true,
  });
  const write = h.requests[1];
  assert.equal(write.method, 'POST');
  assert.deepEqual(JSON.parse(write.body), {
    user_id: ownerId, chat_id: '123456789', enabled: true, notify_auto_confirmed: true, notify_pending: false,
  });
  assert.equal((await h.db.getOwnerTelegramNotificationLog())[0].status, 'queued');
  assert.equal(h.requests[2].method, 'GET');
  assert.equal(h.requests[2].body, undefined);
  assert.equal(h.timers.size, 0, 'Successful operations must release their deadlines');
}

// Missing preferences are safely disabled; invalid drafts never leave the browser.
{
  const h = harness(() => json([]));
  assert.deepEqual(copy(await h.db.getOwnerTelegramPreferences()), { chat_id: '', enabled: false, notify_auto_confirmed: true, notify_pending: true });
  for (const preferences of [
    { ...saved, chat_id: 'invalid' },
    { ...saved, chat_id: '0' },
    { ...saved, chat_id: '' },
    { ...saved, notify_auto_confirmed: false, notify_pending: false },
  ]) await assert.rejects(h.db.saveOwnerTelegramPreferences(preferences));
  assert.equal(h.requests.length, 1);
  const disabled = harness();
  await disabled.db.saveOwnerTelegramPreferences({ ...saved, enabled: false, notify_auto_confirmed: false, notify_pending: false });
  assert.deepEqual(JSON.parse(disabled.requests[0].body).chat_id, saved.chat_id);
}

// Tests send only an action; saved recipients are resolved by the server.
{
  const h = harness();
  assert.equal((await h.db.sendOwnerTelegramTest({ emails: ['unsaved@example.com'] })).status, 'sent');
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert(request.url.pathname.endsWith('/functions/v1/owner-telegram-notifications'));
  assert.equal(request.method, 'POST');
  assert.equal(new Headers(request.headers).get('Authorization'), 'Bearer offline-test-token');
  assert.deepEqual(JSON.parse(request.body), { action: 'test' });
  assert.equal(h.timers.size, 0);
  const skipped = harness(() => json({ ok: true, status: 'skipped' }));
  assert.equal((await skipped.db.sendOwnerTelegramTest()).status, 'skipped');
  const denied = harness(() => json({ ok: false, error: 'Saved email required' }, 400));
  await assert.rejects(denied.db.sendOwnerTelegramTest(), /Saved email required/);
  assert.equal(denied.requests.length, 1, 'Failed test requests must not use a fallback or retry');
  assert.equal(denied.timers.size, 0);
}

// Stalled auth has a deadline and never launches a database write or test email.
for (const [name, method, timeout, invoke] of [
  ['preferences', 'getUser', 15000, db => db.getOwnerTelegramPreferences()],
  ['save', 'getUser', 15000, db => db.saveOwnerTelegramPreferences(saved)],
  ['test', 'getSession', 12000, db => db.sendOwnerTelegramTest()],
]) {
  const h = harness();
  h.auth[method] = () => new Promise(() => {});
  const pending = invoke(h.db);
  const rejected = assert.rejects(pending, error => /Sign-in check timed out/.test(error.message) && error.code !== 'OWNER_TELEGRAM_SAVE_UNCERTAIN');
  h.expire(timeout);
  await rejected;
  assert.equal(h.requests.length, 0, `${name}: auth timeout must not send a request`);
  assert.equal(h.timers.size, 0);
}

// A header deadline alone misses stalled response bodies. Exercise all four
// complete operations after their fetch has already returned successful headers.
for (const [name, timeout, invoke, uncertain] of [
  ['preferences', 15000, db => db.getOwnerTelegramPreferences(), false],
  ['delivery log', 15000, db => db.getOwnerTelegramNotificationLog(), false],
  ['save', 15000, db => db.saveOwnerTelegramPreferences(saved), true],
  ['test', 25000, db => db.sendOwnerTelegramTest(), false],
]) {
  const h = harness(stalledBody);
  const pending = invoke(h.db);
  const rejected = assert.rejects(pending, error => {
    if (uncertain) assert.equal(error.code, 'OWNER_TELEGRAM_SAVE_UNCERTAIN');
    else assert.match(error.message, /timed out/i, `${name} must report its deadline`);
    return true;
  });
  await until(() => h.requests.length === 1);
  await settle();
  assert.equal(h.timers.size, 1, `${name} must retain its complete-operation deadline after response headers`);
  h.expire(timeout);
  await rejected;
  await settle();
  assert.equal(h.requests.length, 1, `${name} must not retry an uncertain request`);
  assert.equal(h.timers.size, 0, `${name} must clear its deadline after rejecting`);
}

// A write that never returns headers may already have committed. Report an
// unknown outcome and never silently issue the write or test email again.
for (const [name, timeout, invoke, uncertain] of [
  ['save', 15000, db => db.saveOwnerTelegramPreferences(saved), true],
  ['test', 25000, db => db.sendOwnerTelegramTest(), false],
]) {
  const h = harness(neverRespond);
  const pending = invoke(h.db);
  const rejected = assert.rejects(pending, error => {
    if (uncertain) assert.equal(error.code, 'OWNER_TELEGRAM_SAVE_UNCERTAIN');
    else assert.match(error.message, /timed out|abort/i);
    return true;
  });
  await until(() => h.requests.length === 1);
  h.expire(timeout);
  await rejected;
  await settle();
  assert.equal(h.requests.length, 1, `${name} must not retry after a lost response`);
  assert.equal(h.timers.size, 0);
  if (name === 'test') assert(h.requests[0].aborted, 'Stalled test transport should be aborted');
}

// PostgREST converts rejected fetches into result.error, so they must still be
// classified as uncertain writes instead of inviting a blind save retry.
for (const transportError of [
  new TypeError('Failed to fetch'),
  new DOMException('The operation was aborted', 'AbortError'),
  new Error('Network request failed'),
  new Error('Request timeout'),
]) {
  const h = harness(() => { throw transportError; });
  await assert.rejects(h.db.saveOwnerTelegramPreferences(saved), error => {
    assert.equal(error.code, 'OWNER_TELEGRAM_SAVE_UNCERTAIN');
    assert.match(error.message, /reload saved settings before trying again/i);
    return true;
  });
  assert.equal(h.requests.length, 1, 'Transport failures must never trigger a second write');
  assert.equal(h.timers.size, 0);
}

// Genuine permission, validation and database timeout responses remain known
// database failures even if their messages contain transport-like words.
for (const [code, message, status] of [
  ['42501', 'Permission denied', 403],
  ['23514', 'Invalid network alert configuration', 400],
  ['57014', 'canceling statement due to statement timeout', 500],
]) {
  const h = harness(() => json({ code, message }, status));
  await assert.rejects(h.db.saveOwnerTelegramPreferences(saved), error => error.code === code && error.message === message);
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
}

console.log('Owner Telegram client checks passed: account/payload contract, saved-only test sends, auth and full-response deadlines, uncertain saves, no automatic retries, timer cleanup.');
