// Offline behavioral checks. No database requests, browser sessions, or writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Cannot find ${start}`);
  return source.slice(a, b);
}
const realtimeSource = section('let _admRtDebounce=null;', 'async function renderDash()');
const navigationSource = section('async function goto(s){', 'let _admRtDebounce=null;');
const completionSource = section('let autoCompleteRan = false;', 'let _bookingRenderSeq');
const agreementSource = section('async function checkAgreementGate(session)', '</script>');
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function realtimeFixture(visibilityState = 'visible') {
  let nextTimer = 0, eventHandler, modal = false;
  const timers = new Map(), listeners = new Map();
  const calls = [], invalidations = [];
  const draft = { tagName: 'INPUT', value: 'saved value' };
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null,
    });
    return elements.get(id);
  }
  let active = 0, maxActive = 0, subscriptions = 0;
  const document = {
    visibilityState,
    activeElement: null,
    querySelector: () => modal ? {} : null,
    querySelectorAll: () => [],
    getElementById: element,
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const channel = {
    on(_event, _filter, callback) { eventHandler = callback; return this; },
    subscribe() { subscriptions++; },
  };
  const context = vm.createContext({
    window: { PB_USE_LOCAL_DATA: false }, document, $: element,
    console: { warn() {}, error() {} },
    SECTION_PERM: {}, titles: {}, sess: { role: 'owner' },
    Auth: { can: () => true }, resetBookingFilters() {},
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    DB: { clearCache(scopes) { invalidations.push([...scopes]); } },
    _supabase: { channel() { return channel; } },
    _curSection: 'bookings',
    SECTION_LOADERS: Object.fromEntries(['bookings', 'maintenance', 'payments', 'courts', 'blocked', 'remittances', 'gamemgr'].map(name => [name, () => {
      const call = { ...deferred(), section: name, invalidationsAtStart: invalidations.length };
      calls.push(call);
      draft.value = 'server value';
      maxActive = Math.max(maxActive, ++active);
      return call.promise.finally(() => { active--; });
    }])),
  });
  vm.runInContext(realtimeSource, context);
  vm.runInContext(navigationSource, context);
  vm.runInContext('startAdminRealtime(); startAdminRealtime();', context);
  assert.equal(subscriptions, 1, 'Starting twice must not duplicate the subscription');
  return {
    calls, invalidations, timers, document, draft,
    get maxActive() { return maxActive; },
    emit(table = 'bookings') { eventHandler({ table }); },
    setModal(value) { modal = value; },
    setSection(name) { context._curSection = name; },
    navigate(name) { context.destination = name; return vm.runInContext('goto(destination)', context); },
    dispatch(name) { listeners.get(name)?.(); },
    async tick() {
      assert(timers.size, 'Expected a deferred refresh');
      const [id, { callback }] = timers.entries().next().value;
      timers.delete(id);
      callback();
      await settle();
    },
  };
}

// Slow reads cannot accumulate renders; changes during a read become one follow-up.
{
  const f = realtimeFixture();
  f.emit(); await f.tick();
  for (let i = 0; i < 20; i++) f.emit();
  f.emit('settings'); f.emit('courts');
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  f.calls[0].resolve(); await settle();
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.maxActive, 1);
  assert.deepEqual(f.invalidations[0], ['bookings']);
  assert.deepEqual(f.invalidations[1].sort(), ['bookings', 'courts', 'settings']);
  f.calls[1].resolve(); await settle();
  assert.equal(f.timers.size, 0);
}

// Hidden tabs retain updates without timers or reads, then refresh once on return.
{
  const f = realtimeFixture('hidden');
  for (let i = 0; i < 20; i++) f.emit('open_play_registrations');
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
  f.document.visibilityState = 'visible'; f.dispatch('visibilitychange');
  await f.tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.invalidations[0], ['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  f.document.visibilityState = 'hidden'; f.dispatch('visibilitychange');
  f.emit();
  f.calls[0].resolve(); await settle();
  assert.equal(f.timers.size, 0);
  f.document.visibilityState = 'visible'; f.dispatch('visibilitychange');
  await f.tick();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(); await settle();
}

// Editing and modal guards defer, rather than lose, a received update.
{
  const f = realtimeFixture();
  f.document.activeElement = { tagName: 'INPUT' };
  f.emit(); await f.tick();
  assert.equal(f.calls.length, 0);
  f.document.activeElement = null; f.dispatch('focusout');
  await f.tick();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(); await settle();
  f.setModal(true); f.emit(); await f.tick();
  assert.equal(f.calls.length, 1);
  f.setModal(false); await f.tick();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(); await settle();
}

// A failed refresh does not leave the in-flight guard locked.
{
  const f = realtimeFixture();
  f.emit(); await f.tick(); f.emit();
  f.calls[0].reject(new Error('Offline read failed')); await settle();
  await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.maxActive, 1);
  f.calls[1].resolve(); await settle();
}

// Blurring an unsaved settings form (including Add/Delete Rule clicks) is not a save.
for (const name of ['maintenance', 'payments', 'courts', 'blocked', 'remittances', 'gamemgr']) {
  const f = realtimeFixture();
  f.setSection(name);
  f.draft.value = 'unsaved change';
  f.document.activeElement = f.draft;
  f.emit('settings');
  f.document.activeElement = null; f.dispatch('focusout');
  f.dispatch('visibilitychange');
  await settle();
  assert.equal(f.draft.value, 'unsaved change', `${name} must preserve unsaved form state`);
  assert.equal(f.calls.length, 0, `${name} must not auto-render after blur`);
  assert.equal(f.timers.size, 0, `${name} must not retain a polling timer`);
  assert.deepEqual(f.invalidations, [['settings']], `${name} must invalidate stale reads`);
  const navigated = f.navigate(name);
  assert.equal(f.calls.length, 1, `${name} still reloads on explicit navigation`);
  assert.equal(f.calls[0].invalidationsAtStart, 1);
  f.calls[0].resolve(); await navigated;
}

// Navigating into a form consumes an already queued refresh before loading it.
{
  const f = realtimeFixture();
  f.emit('settings');
  assert.equal(f.timers.size, 1);
  const navigated = f.navigate('maintenance');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.invalidations, [['settings']]);
  assert.equal(f.calls[0].section, 'maintenance');
  assert.equal(f.calls[0].invalidationsAtStart, 1);
  f.calls[0].resolve(); await navigated;
  f.draft.value = 'new unsaved rule';
  f.dispatch('focusout'); await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.draft.value, 'new unsaved rule');
  assert.equal(f.timers.size, 0);
}

function completionFixture() {
  const writes = [];
  let active = 0, maxActive = 0;
  const context = vm.createContext({
    DB: { updateBooking(ref, updates) {
      assert.equal(updates.status, 'completed');
      const write = deferred(); writes.push({ ...write, ref });
      maxActive = Math.max(maxActive, ++active);
      return write.promise.finally(() => { active--; });
    } },
  });
  vm.runInContext(completionSource, context);
  context.bookings = Array.from({ length: 10 }, (_, i) => ({
    ref: `OFFLINE-${i}`, status: 'confirmed', date: '2000-01-01', endTime: '6:00 PM',
  }));
  return {
    writes,
    get maxActive() { return maxActive; },
    run() { return vm.runInContext('autoCompleteBookings(bookings)', context); },
  };
}

// Five callers share ten updates, with at most three active database writes.
{
  const f = completionFixture();
  const runs = Array.from({ length: 5 }, () => f.run());
  await settle();
  assert.equal(f.writes.length, 3);
  for (let i = 0; i < 10; i++) {
    assert(f.writes[i], `Expected worker to reach booking ${i}`);
    f.writes[i].resolve(); await settle();
  }
  assert.deepEqual(await Promise.all(runs), [10, 10, 10, 10, 10]);
  assert.equal(f.writes.length, 10);
  assert.equal(new Set(f.writes.map(write => write.ref)).size, 10);
  assert.equal(f.maxActive, 3);
  assert.equal(await f.run(), 0);
}

// A failing worker cannot unlock another batch while its siblings still write.
{
  const f = completionFixture();
  const first = assert.rejects(f.run(), /Offline update failed/);
  await settle();
  f.writes[0].reject(new Error('Offline update failed')); await settle();
  const joined = assert.rejects(f.run(), /Offline update failed/);
  await settle();
  assert.equal(f.writes.length, 3);
  for (let i = 1; i < 10; i++) { f.writes[i].resolve(); await settle(); }
  await Promise.all([first, joined]);
  assert.equal(f.maxActive, 3);
}

// Failed agreement verification reaches the boot retry path; it never shows signing.
{
  let gateAccesses = 0, reads = 0;
  const context = vm.createContext({
    location: { hostname: 'thequadrant.club' }, AGREEMENT_VERSION: 13,
    DB: { async getAgreement() { reads++; throw new Error('Offline agreement read failed'); } },
    updateAgreementFeeCopy() { throw new Error('Must not prepare signing after failed verification'); },
    document: { getElementById() { gateAccesses++; throw new Error('Must not show gate'); } },
  });
  vm.runInContext(agreementSource, context);
  assert.equal(await vm.runInContext("checkAgreementGate({role:'owner'})", context), false);
  assert.equal(reads, 0);
  await assert.rejects(vm.runInContext("checkAgreementGate({id:'offline',role:'court_owner'})", context), /Offline agreement read failed/);
  assert.equal(gateAccesses, 0);
  context.DB.getAgreement = async () => ({ id: 'signed' });
  assert.equal(await vm.runInContext("checkAgreementGate({id:'offline',role:'court_owner'})", context), false);
}

console.log('Admin refresh checks passed: coalescing, hidden-tab recovery, unsaved-form protection, navigation freshness, bounded housekeeping, agreement failures.');
