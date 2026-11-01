// Deterministic public realtime checks. No network, payment calls, or writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('let _rtDebounce = null;');
const end = html.indexOf('function initScrollReveal()', start);
assert(start >= 0 && end > start, 'Public realtime section must exist');
const source = html.slice(start, end);
const settle = () => new Promise(resolve => setImmediate(resolve));
const allScopes = ['bookings', 'courts', 'settings', 'blockedDates', 'openPlayRegistrations', 'openPlayCount', 'openPlayCounts'];

function fixture({ hidden = false, local = false, legacy = false } = {}) {
  const timers = new Map(), listeners = new Map(), handlers = new Map();
  const calls = [], invalidations = [], reads = [];
  // Start with warm caches to isolate unnecessary invalidation from normal TTL expiry.
  const cached = new Set(allScopes);
  let timerId = 0, subscriptions = 0, onStatus, active = 0, maxActive = 0;
  let context;
  function load(kind) {
    const scopes = kind === 'courts' ? ['courts', 'bookings', 'settings', 'openPlayCount'] : ['settings', 'bookings', 'openPlayCount'];
    for (const scope of scopes) {
      if (!cached.has(scope)) { reads.push(scope); cached.add(scope); }
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ kind, resolve, reject, date: context.sharedCourtDate });
    maxActive = Math.max(maxActive, ++active);
    return promise.finally(() => { active--; });
  }
  const document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    addEventListener(name, callback) {
      assert(!listeners.has(name), 'Listeners must not be registered twice');
      listeners.set(name, callback);
    },
  };
  const channel = {
    on(event, filter, callback) {
      assert.equal(event, 'postgres_changes');
      assert.equal(filter.schema, 'public');
      assert.equal(filter.event, '*');
      handlers.set(filter.table, callback);
      return this;
    },
    subscribe(callback) { subscriptions++; onStatus = callback; return this; },
  };
  context = vm.createContext({
    window: { PB_USE_LOCAL_DATA: local }, document,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    _supabase: { channel(name) { assert.equal(name, 'public-rt'); return channel; } },
    DB: {
      clearCache(scopes) {
        assert(scopes?.length, 'Realtime must never clear every cache');
        invalidations.push([...scopes]);
        for (const scope of scopes) cached.delete(scope);
      },
    },
    renderCourts: () => load('courts'), renderSlots: () => load('slots'),
    loadOperatingHours() { assert.fail('renderCourts already loads operating hours'); },
    court: legacy ? { id: 'court-1' } : null,
    $: id => id === 'bDate' ? { value: '2026-10-23' } : null,
    sharedCourtDate: '2026-10-23',
  });
  vm.runInContext(source, context);
  vm.runInContext('startRealtime(); startRealtime();', context);
  return {
    document, calls, timers, invalidations, reads, handlers, listeners, context,
    get subscriptions() { return subscriptions; }, get maxActive() { return maxActive; },
    emit(table = 'bookings') { handlers.get(table)({ table }); },
    status(value) { onStatus?.(value); },
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; listeners.get('visibilitychange')?.(); },
    async tick() {
      assert.equal(timers.size, 1, 'Only one refresh timer may be pending');
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 300);
      timers.delete(id);
      timer.callback();
      await settle();
    },
    async resolve(index = calls.length - 1) { calls[index].resolve(); await settle(); },
  };
}

// Initial subscription does not repeat page initialization; local demo stays local.
{
  const f = fixture();
  assert.equal(f.subscriptions, 1);
  assert.deepEqual([...f.handlers.keys()], ['bookings', 'courts', 'settings', 'blocked_dates', 'open_play_registrations']);
  f.status('SUBSCRIBED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
  const local = fixture({ local: true });
  assert.equal(local.subscriptions, 0);
  assert.equal(local.listeners.size, 0);
  assert.equal(local.calls.length, 0);
}

// A burst uses one timer, and later events cannot keep postponing the first refresh.
{
  const f = fixture();
  f.emit();
  const originalTimer = [...f.timers.keys()][0];
  for (let i = 0; i < 30; i++) f.emit();
  f.emit('courts'); f.emit('settings');
  assert.deepEqual([...f.timers.keys()], [originalTimer]);
  await f.tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.invalidations, [['bookings', 'courts', 'settings']]);
  await f.resolve();
  assert.equal(f.timers.size, 0);
}

// Slow court and legacy-slot reads remain one operation. Updates during either
// phase coalesce into exactly one follow-up, with no overlapping render reads.
{
  const f = fixture({ legacy: true });
  f.emit(); await f.tick();
  for (let i = 0; i < 20; i++) f.emit();
  f.emit('settings');
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 1);
  await f.resolve(0);
  assert.equal(f.calls[1].kind, 'slots');
  f.emit('open_play_registrations');
  assert.equal(f.timers.size, 0, 'Legacy slot rendering must remain in flight');
  await f.resolve(1);
  await f.tick();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.invalidations[1], ['bookings', 'settings', 'openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  await f.resolve(2); await f.resolve(3);
  assert.equal(f.maxActive, 1);
  assert.equal(f.timers.size, 0);
}

// Known table changes invalidate only dependent caches. Within their normal TTL,
// twenty separately rendered booking events require no settings/court/count reads.
{
  const f = fixture();
  for (let i = 0; i < 20; i++) {
    f.emit(); await f.tick(); await f.resolve();
  }
  assert.equal(f.calls.length, 20);
  assert.deepEqual(f.reads, Array(20).fill('bookings'));
  assert(f.invalidations.every(scopes => scopes.length === 1 && scopes[0] === 'bookings'));
  f.emit('open_play_registrations'); await f.tick(); await f.resolve();
  assert.equal(f.reads.at(-1), 'openPlayCount');
  assert.deepEqual(f.invalidations.at(-1), ['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  f.emit('blocked_dates'); await f.tick(); await f.resolve();
  assert.deepEqual(f.invalidations.at(-1), ['blockedDates']);
}

// Hidden tabs neither refresh nor poll. Resume takes one current snapshot, even
// if a suspended connection missed events and therefore had no pending callback.
{
  const f = fixture({ hidden: true });
  for (let i = 0; i < 30; i++) f.emit();
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.invalidations.length, 0);
  f.visible(true); await f.tick(); await f.resolve();
  assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.invalidations[0]].sort(), [...allScopes].sort());
  f.visible(false); f.visible(true); await f.tick(); await f.resolve();
  assert.equal(f.calls.length, 2);
  f.emit(); f.visible(false);
  assert.equal(f.timers.size, 0, 'Hiding must cancel a not-yet-started timer');
  f.visible(true); await f.tick(); await f.resolve();
  assert.equal(f.calls.length, 3);
}

// An already-running read may finish while hidden, but no secondary reads or
// queued refreshes start until the page becomes visible again.
{
  const f = fixture({ legacy: true });
  f.emit(); await f.tick();
  f.visible(false); f.emit('settings');
  await f.resolve();
  assert.equal(f.calls.length, 1, 'Do not begin a legacy slot read after hiding');
  assert.equal(f.timers.size, 0);
  f.visible(true); await f.tick(); await f.resolve(); await f.resolve();
  assert.deepEqual(f.calls.map(call => call.kind), ['courts', 'courts', 'slots']);
  assert.equal(f.maxActive, 1);
}

// Reconnection catches up once, without changing the first subscription's load.
{
  const f = fixture();
  f.status('SUBSCRIBED'); f.status('CHANNEL_ERROR');
  assert.equal(f.timers.size, 0);
  f.status('SUBSCRIBED'); f.emit('bookings');
  await f.tick(); await f.resolve();
  assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.invalidations[0]].sort(), [...allScopes].sort());
}

// Errors release the coordinator; a following change can recover. No failure
// creates a self-repeating request loop. The current browse date is preserved.
for (const failedPhase of ['courts', 'slots']) {
  const f = fixture({ legacy: failedPhase === 'slots' });
  f.emit(); await f.tick();
  if (failedPhase === 'slots') await f.resolve();
  f.calls.at(-1).reject(new Error('Offline availability read failed'));
  await settle();
  assert.equal(f.timers.size, 0);
  f.context.sharedCourtDate = '2026-10-25';
  f.emit(); await f.tick();
  assert.equal(f.calls.at(-1).date, '2026-10-25');
  await f.resolve();
  if (failedPhase === 'slots') await f.resolve();
  assert.equal(f.context.sharedCourtDate, '2026-10-25');
  assert.equal(f.maxActive, 1);
}

console.log('Public realtime checks passed: targeted cache invalidation, burst coalescing, serialized court/slot reads, hidden-tab pause/resume, reconnect freshness, initial subscription, error recovery.');
