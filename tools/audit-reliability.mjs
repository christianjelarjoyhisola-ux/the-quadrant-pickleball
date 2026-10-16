// Read-only, offline diagnostic reproductions. No production requests or writes.
// Regression assertions verify the repaired reliability behavior.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const config = read('supabase-config.js');
const index = read('index.html');
const admin = read('admin.html');
const section = (source, start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Cannot locate ${start}`);
  return source.slice(a, b);
};
const findings = [];
const report = (name, evidence) => findings.push({ name, evidence });
const storage = () => {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
};
let queryCalls = 0;
let response = { data: null, error: { message: 'Simulated database outage' } };
const query = new Proxy({}, { get: (_, key) => key === 'then'
  ? (resolve, reject) => Promise.resolve(response).then(resolve, reject)
  : () => query });
const context = vm.createContext({
  URLSearchParams, structuredClone, setTimeout, clearTimeout,
  console: { error() {}, log() {}, warn() {} },
  location: { hostname: 'thequadrant.club', search: '' },
  localStorage: storage(), sessionStorage: storage(),
  supabase: { createClient: () => ({ from() { queryCalls++; return query; } }) },
});
context.window = context;
vm.runInContext(config, context);

for (const name of ['index.html', 'admin.html', 'login.html', 'signature-view.html']) {
  let count = 0;
  for (const match of read(name).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1], { filename: `${name}:inline-${++count}` });
  }
  console.log(`SYNTAX OK: ${name}, ${count} inline scripts`);
}

await assert.rejects(context.DB.getCourts());
const before = queryCalls;
await assert.rejects(context.DB.getCourts());
assert.equal(queryCalls, before + 1);
report('Database errors are not cached', 'A failed court load rejects and the next call retries.');
await assert.rejects(context.DB.getBookings());
await assert.rejects(context.DB.getOpenPlayCountForDate('2026-10-16'));
report('Availability fails closed', 'Failed availability queries reject instead of returning empty availability.');
for (const name of ['deleteBooking', 'deleteOpenPlayRegistration', 'addBlockedDate', 'removeBlockedDate', 'deleteAccount']) {
  await assert.rejects(context.DB[name]('diagnostic-only'));
}
report('Admin mutation errors propagate', 'All five simulated failed writes reject.');

await vm.runInContext(`(async () => {
  let resolveOld;
  const old = _pbCached('audit-race', {}, 60000, () => new Promise(r => { resolveOld = r; }));
  await Promise.resolve();
  _pbClearFastCache(['audit-race']);
  await _pbCached('audit-race', {}, 60000, async () => 'new');
  resolveOld('old'); await old;
  window.auditRace = await _pbCached('audit-race', {}, 60000, async () => 'unexpected');
})()`, context);
assert.equal(context.auditRace, 'new');
report('Cache invalidation preserves newer data', 'An obsolete request cannot overwrite a newer cached result.');

const effects = { invoices: [], confirmations: [], updates: [], emails: [] };
const returnContext = vm.createContext({
  URLSearchParams, Date,
  location: { search: '?payment=success&bookingRef=AUDIT', pathname: '/' },
  document: { title: 'Offline audit' }, history: { replaceState() {} },
  setTimeout: fn => { fn(); return 0; },
  dismissSplash() {}, toast() {}, renderCourts: async () => {},
  showInvoice: b => effects.invoices.push(b),
  showOpenPlayConfirmed: r => effects.confirmations.push(r),
  sendCustomerConfirmationEmail: b => effects.emails.push(b),
  DB: {
    syncPaymentSession: async () => ({ paid: false, status: 'pending' }),
    getBookingByRef: async () => ({ ref: 'AUDIT', status: 'pending', paymentStatus: 'unpaid' }),
    getOpenPlayRegistration: async () => ({ id: 'AUDIT', payment_status: 'pending' }),
    updateOpenPlayRegistration: async (id, updates) => { effects.updates.push(updates); throw new Error('Permission denied'); },
    sendOpenPlayConfirmationEmail: async r => effects.emails.push(r),
  },
});
vm.runInContext(section(index, 'function openPlayIdFromPaymentRef', 'function showOpenPlayConfirmed'), returnContext);
vm.runInContext(section(index, 'async function handleOpenPlayPaymentReturn', "document.addEventListener('DOMContentLoaded', async () =>"), returnContext);
await vm.runInContext('handlePaymentReturn()', returnContext);
assert.equal(effects.invoices.length, 0);
await vm.runInContext("handleOpenPlayPaymentReturn({payment:'success', bookingRef:'OP-AUDIT', params:new URLSearchParams()})", returnContext);
assert.equal(effects.confirmations.length, 0);
assert.equal(effects.updates.length, 0);
assert.equal(effects.emails.length, 0);
report('Unverified payment stays pending', 'No paid invoice, confirmation, update or email occurs for pending payments.');

const maintenance = vm.createContext({
  DB: { getMaintenanceSettings: async () => ({ maintenance_config: '{broken' }), getCourts: async () => [] },
});
vm.runInContext(section(admin, 'let _mtLoaded = false', 'function mtRuleModeChanged'), maintenance);
await assert.rejects(vm.runInContext('renderMaintenance()', maintenance), /JSON|property|Expected|Unexpected/);
report('Malformed maintenance settings abort rendering', 'renderMaintenance rejects on malformed JSON; this is a failure-path test, not evidence that live settings are malformed.');

const button = { disabled: false, textContent: 'Login' };
const login = vm.createContext({
  _withTimeout: promise => promise,
  document: { getElementById: () => ({ value: 'offline-test', checked: false, classList: {add() {}} }) },
  Auth: { login: async () => { throw new Error('Connection interrupted'); } },
});
vm.runInContext(section(read('login.html'), 'async function doLogin', '// Redirect if already logged in'), login);
login.event = { preventDefault() {}, target: { querySelector: () => button } };
await vm.runInContext('doLogin(event)', login);
assert.equal(button.disabled, false);
assert.equal(button.textContent, 'Login to Dashboard →');
report('Login recovers after rejected request', 'The button is restored and the error is handled.');

console.log(JSON.stringify({ reproduced: findings.length, findings }, null, 2));
