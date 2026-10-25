// Offline UI behavior only: no emails, network calls, or production writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const admin = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const start = admin.indexOf('/* OWNER TELEGRAM NOTIFICATIONS */');
const end = admin.indexOf('/* END OWNER TELEGRAM NOTIFICATIONS */', start);
assert(start >= 0 && end > start);
assert.match(admin, /<label\b[^>]*id="ownerTelegramRecipientsLabel"[^>]*for="ownerTelegramRecipients"[^>]*>Telegram chat ID<\/label>/);
assert.match(admin, /<input\b[^>]*id="ownerTelegramRecipients"[^>]*aria-describedby="ownerTelegramRecipientsHelp"/);
const source = admin.slice(start, end);
const stored = { chat_id: '123456789', enabled: true, notify_auto_confirmed: true, notify_pending: true };
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(preferences = {}, role = 'court_owner') {
  const elements = new Map(), saves = [], tests = [], reads = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, disabled: false, textContent: '', innerHTML: '', style: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
    });
    return elements.get(id);
  };
  const DB = {
    async getOwnerTelegramPreferences() { reads.push('preferences'); return clone(preferences); },
    async saveOwnerTelegramPreferences(value) { saves.push(clone(value)); return clone(value); },
    async getOwnerTelegramNotificationLog() { reads.push('history'); return []; },
    async sendOwnerTelegramTest(...args) { tests.push(args); return { status: 'pending' }; },
  };
  const context = vm.createContext({
    DB, $: element, sess: { role },
    Auth: { can: (permission, accountRole) => permission === 'settings' && ['owner', 'court_owner'].includes(accountRole) },
    esc: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  });
  vm.runInContext(source, context);
  return { DB, element, saves, tests, reads, run: code => vm.runInContext(code, context), context };
}

// New owners are disabled by default; loading preferences/history never sends email.
{
  const f = fixture();
  await f.run('renderOwnerTelegramNotifications()');
  assert.equal(f.element('ownerTelegramEnabled').checked, false);
  assert.equal(f.element('ownerTelegramConfirmed').checked, true);
  assert.equal(f.element('ownerTelegramPending').checked, true);
  assert.equal(f.element('ownerTelegramTest').disabled, true);
  assert.equal(f.tests.length, 0);
  assert.equal(f.element('ownerTelegramFields').disabled, false);
}

// Email validation prevents invalid recipients, duplicates, excess recipients,
// or enabling alerts without an address and at least one selected event.
{
  const f = fixture();
  await f.run('renderOwnerTelegramNotifications()');
  f.element('ownerTelegramEnabled').checked = true;
  for (const invalid of ['', 'invalid', '123\n456', '0', '@channel']) {
    f.element('ownerTelegramRecipients').value = invalid;
    await f.run('saveOwnerTelegramPreferences()');
    assert.equal(f.saves.length, 0);
    assert.equal(f.element('ownerTelegramFeedback').attributes.role, 'alert');
  }
  f.element('ownerTelegramRecipients').value = '123456789';
  f.element('ownerTelegramConfirmed').checked = false;
  f.element('ownerTelegramPending').checked = false;
  await f.run('saveOwnerTelegramPreferences()');
  assert.equal(f.saves.length, 0);
  f.element('ownerTelegramConfirmed').checked = true;
  f.element('ownerTelegramRecipients').value = ' 123456789 ';
  await f.run('saveOwnerTelegramPreferences()');
  assert.deepEqual(f.saves[0], {
    chat_id: '123456789',
    enabled: true, notify_auto_confirmed: true, notify_pending: false,
  });
  assert(!('notify_confirmed' in f.saves[0]) && !('notify_cancelled' in f.saves[0]));
  assert.equal(f.element('ownerTelegramTest').disabled, false);
  assert.equal(f.tests.length, 0);
}

// Turning off alerts preserves recipients and allows both event choices off.
{
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  f.element('ownerTelegramEnabled').checked = false;
  f.element('ownerTelegramConfirmed').checked = false;
  f.element('ownerTelegramPending').checked = false;
  await f.run('saveOwnerTelegramPreferences()');
  assert.deepEqual(f.saves[0], { chat_id: stored.chat_id, enabled: false, notify_auto_confirmed: false, notify_pending: false });
  assert.equal(f.element('ownerTelegramTest').disabled, false, 'A saved disabled configuration may still be tested explicitly');
}

// Failed saves restore controls and preserve the draft without exposing service details.
{
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  f.DB.saveOwnerTelegramPreferences = async () => { throw new Error('RESEND_API_KEY internal detail'); };
  f.element('ownerTelegramRecipients').value = '987654321';
  await f.run('saveOwnerTelegramPreferences()');
  assert.equal(f.element('ownerTelegramFields').disabled, false);
  assert.equal(f.element('ownerTelegramSave').textContent, 'Save settings');
  assert.equal(f.element('ownerTelegramRecipients').value, '987654321');
  assert.equal(f.element('ownerTelegramTest').disabled, true);
  assert(!f.element('ownerTelegramFeedback').textContent.includes('RESEND'));
}

// A timed-out write may have committed. Keep its draft visible, prevent another
// write/test, and require an explicit successful read before unlocking the form.
{
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  let saveCalls = 0;
  f.DB.saveOwnerTelegramPreferences = async () => {
    saveCalls++;
    throw Object.assign(new Error('Internal save timeout'), { code: 'OWNER_TELEGRAM_SAVE_UNCERTAIN' });
  };
  f.element('ownerTelegramRecipients').value = '987654321';
  await f.run('saveOwnerTelegramPreferences()');
  assert.match(f.element('ownerTelegramFeedback').textContent, /may already have been saved/);
  assert.match(f.element('ownerTelegramFeedback').textContent, /Reload saved settings before trying again/);
  assert.equal(f.element('ownerTelegramRecipients').value, '987654321');
  assert.equal(f.element('ownerTelegramFields').disabled, true);
  assert.equal(f.element('ownerTelegramReload').hidden, false);
  assert.equal(f.element('ownerTelegramReload').style.display, '');
  assert.equal(f.element('ownerTelegramReload').disabled, false);
  await f.run('saveOwnerTelegramPreferences(); sendOwnerTelegramTest();');
  assert.equal(saveCalls, 1, 'Unknown write outcomes must not encourage duplicate saves');
  assert.equal(f.tests.length, 0);
  f.DB.getOwnerTelegramPreferences = async () => { throw new Error('Read unavailable'); };
  await f.run('reloadOwnerTelegramPreferences()');
  assert.equal(f.element('ownerTelegramFields').disabled, true);
  assert.equal(f.element('ownerTelegramReload').hidden, false, 'A failed reload must stay retryable');
  assert.equal(f.element('ownerTelegramReload').disabled, false);
  f.DB.getOwnerTelegramPreferences = async () => ({ ...stored, chat_id: '987654321' });
  await f.run('reloadOwnerTelegramPreferences()');
  assert.equal(f.element('ownerTelegramRecipients').value, '987654321');
  assert.equal(f.element('ownerTelegramFields').disabled, false);
  assert.equal(f.element('ownerTelegramTest').disabled, false);
  assert.equal(f.element('ownerTelegramReload').hidden, true);
  assert.equal(f.element('ownerTelegramReload').style.display, 'none');
  assert.equal(f.run('ownerTelegramIsDirty()'), false);
}

// Test message uses only persisted server preferences: unsaved fields never become a payload.
{
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  f.element('ownerTelegramRecipients').value = 'unsaved@example.com';
  f.run('ownerTelegramFormChanged()');
  await f.run('sendOwnerTelegramTest()');
  assert.equal(f.tests.length, 0);
  assert.match(f.element('ownerTelegramFeedback').textContent, /Save your changes/);
  f.element('ownerTelegramRecipients').value = '123456789';
  f.run('ownerTelegramFormChanged()');
  await f.run('sendOwnerTelegramTest()');
  assert.deepEqual(f.tests, [[]], 'Test endpoint receives no browser-provided recipients');
  assert.match(f.element('ownerTelegramFeedback').textContent, /requested/);
  assert.equal(f.element('ownerTelegramTest').textContent, 'Send Test Telegram');
}

// Double-clicks cannot send multiple tests while a request is active; failures recover.
{
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  let reject;
  f.DB.sendOwnerTelegramTest = (...args) => {
    f.tests.push(args);
    return new Promise((_, no) => { reject = no; });
  };
  const first = f.run('sendOwnerTelegramTest()');
  await settle();
  await f.run('sendOwnerTelegramTest()');
  assert.equal(f.tests.length, 1);
  assert.equal(f.element('ownerTelegramFields').disabled, true);
  reject(new Error('Private delivery detail'));
  await first;
  assert.equal(f.element('ownerTelegramFields').disabled, false);
  assert.equal(f.element('ownerTelegramTest').disabled, false);
  assert.equal(f.element('ownerTelegramFeedback').attributes.role, 'alert');
  assert(!f.element('ownerTelegramFeedback').textContent.includes('Private'));
}

// A lost test response must not claim a send failed or automatically send again.
for (const error of [new Error('Test message request (delivery outcome may be unknown) timed out'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  f.DB.sendOwnerTelegramTest = async () => { f.tests.push([]); throw error; };
  await f.run('sendOwnerTelegramTest()');
  assert.equal(f.tests.length, 1);
  assert.match(f.element('ownerTelegramFeedback').textContent, /may still have been sent/);
  assert.match(f.element('ownerTelegramFeedback').textContent, /Check your Telegram chat before sending another test/);
  assert.equal(f.element('ownerTelegramTest').disabled, false);
}

// Successful sends state provider acceptance; demo/other skipped sends remain explicit.
for (const [status, expected] of [['sent', /accepted by Telegram/], ['skipped', /No test message was sent/]]) {
  const f = fixture(stored);
  await f.run('renderOwnerTelegramNotifications()');
  f.DB.sendOwnerTelegramTest = async () => ({ ok: true, status });
  await f.run('sendOwnerTelegramTest()');
  assert.match(f.element('ownerTelegramFeedback').textContent, expected);
}

// History describes provider acceptance accurately and never emits raw error content.
{
  const f = fixture(stored);
  f.DB.getOwnerTelegramNotificationLog = async () => ['queued', 'pending', 'sending', 'sent', 'failed', 'skipped'].map((status, i) => ({
    id: String(i), event: i % 2 ? 'auto_confirmed' : 'pending', status, attempts: 1,
    created_at: '2026-10-17T04:00:00Z', last_error: '<script>private-provider-error</script>',
  }));
  await f.run('renderOwnerTelegramNotifications()');
  const html = f.element('ownerTelegramHistory').innerHTML;
  for (const status of ['Pending', 'Sending', 'Sent', 'Failed', 'Skipped']) assert(html.includes(status));
  assert.equal((html.match(/>Pending<\/span>/g) || []).length, 2, 'Both queued server rows and pending rows must display Pending');
  assert(!html.includes('Unknown'));
  assert(html.includes('Accepted by Telegram.'));
  assert(!html.includes('private-provider-error'));
  f.DB.getOwnerTelegramNotificationLog = async () => { throw new Error('Private database detail'); };
  await f.run('refreshOwnerTelegramHistory()');
  assert(f.element('ownerTelegramHistory').innerHTML.includes('role="alert"'));
  assert.equal(f.element('ownerTelegramHistoryRefresh').disabled, false);
  assert.equal(f.element('ownerTelegramHistory').attributes['aria-busy'], 'false');
}

// Failed initial reads cannot turn an unknown configuration into overwritten defaults.
{
  const f = fixture();
  f.DB.getOwnerTelegramPreferences = async () => { throw new Error('Read failed'); };
  await assert.rejects(f.run('renderOwnerTelegramNotifications()'), /Read failed/);
  await f.run('saveOwnerTelegramPreferences()');
  assert.equal(f.saves.length, 0);
  assert.equal(f.element('ownerTelegramFields').disabled, true);
}

// Staff and hosts cannot read, save, or test owner Telegram settings through these handlers.
for (const role of ['staff', 'host']) {
  const f = fixture(stored, role);
  await f.run('renderOwnerTelegramNotifications(); saveOwnerTelegramPreferences(); sendOwnerTelegramTest(); refreshOwnerTelegramHistory();');
  assert.equal(f.reads.length + f.saves.length + f.tests.length, 0);
}

console.log('Telegram notification UI checks passed: accessible label, defaults, validation, saved-only tests, uncertain-save reload, delivery feedback, queued history, role guards.');
