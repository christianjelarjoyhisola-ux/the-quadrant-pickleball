// Offline UI behavior only: no emails, network calls, or production writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const admin = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const start = admin.indexOf('/* OWNER EMAIL NOTIFICATIONS */');
const end = admin.indexOf('/* END OWNER EMAIL NOTIFICATIONS */', start);
assert(start >= 0 && end > start);
assert.match(admin, /<label\b[^>]*id="ownerEmailRecipientsLabel"[^>]*for="ownerEmailRecipients"[^>]*>Email addresses<\/label>/);
assert.match(admin, /<textarea\b[^>]*id="ownerEmailRecipients"[^>]*aria-labelledby="ownerEmailRecipientsLabel"/);
const source = admin.slice(start, end);
const stored = { emails: ['owner@example.com'], enabled: true, notify_new: true, notify_pending: true };
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
    async getOwnerEmailPreferences() { reads.push('preferences'); return clone(preferences); },
    async saveOwnerEmailPreferences(value) { saves.push(clone(value)); return clone(value); },
    async getOwnerEmailNotificationLog() { reads.push('history'); return []; },
    async sendOwnerEmailTest(...args) { tests.push(args); return { status: 'pending' }; },
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
  await f.run('renderOwnerEmailNotifications()');
  assert.equal(f.element('ownerEmailEnabled').checked, false);
  assert.equal(f.element('ownerEmailNew').checked, true);
  assert.equal(f.element('ownerEmailPending').checked, true);
  assert.equal(f.element('ownerEmailTest').disabled, true);
  assert.equal(f.tests.length, 0);
  assert.equal(f.element('ownerEmailFields').disabled, false);
}

// Email validation prevents invalid recipients, duplicates, excess recipients,
// or enabling alerts without an address and at least one selected event.
{
  const f = fixture();
  await f.run('renderOwnerEmailNotifications()');
  f.element('ownerEmailEnabled').checked = true;
  for (const invalid of ['', 'missing-at.example.com', 'one@example.com\nONE@example.com', 'one@example.com\ntwo@example.com\nthree@example.com\nfour@example.com']) {
    f.element('ownerEmailRecipients').value = invalid;
    await f.run('saveOwnerEmailPreferences()');
    assert.equal(f.saves.length, 0);
    assert.equal(f.element('ownerEmailFeedback').attributes.role, 'alert');
  }
  f.element('ownerEmailRecipients').value = 'owner@example.com';
  f.element('ownerEmailNew').checked = false;
  f.element('ownerEmailPending').checked = false;
  await f.run('saveOwnerEmailPreferences()');
  assert.equal(f.saves.length, 0);
  f.element('ownerEmailNew').checked = true;
  f.element('ownerEmailRecipients').value = ' owner@example.com \n backup@example.com\n third@example.com ';
  await f.run('saveOwnerEmailPreferences()');
  assert.deepEqual(f.saves[0], {
    emails: ['owner@example.com', 'backup@example.com', 'third@example.com'],
    enabled: true, notify_new: true, notify_pending: false,
  });
  assert(!('notify_confirmed' in f.saves[0]) && !('notify_cancelled' in f.saves[0]));
  assert.equal(f.element('ownerEmailTest').disabled, false);
  assert.equal(f.tests.length, 0);
}

// Turning off alerts preserves recipients and allows both event choices off.
{
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  f.element('ownerEmailEnabled').checked = false;
  f.element('ownerEmailNew').checked = false;
  f.element('ownerEmailPending').checked = false;
  await f.run('saveOwnerEmailPreferences()');
  assert.deepEqual(f.saves[0], { emails: stored.emails, enabled: false, notify_new: false, notify_pending: false });
  assert.equal(f.element('ownerEmailTest').disabled, false, 'A saved disabled configuration may still be tested explicitly');
}

// Failed saves restore controls and preserve the draft without exposing service details.
{
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  f.DB.saveOwnerEmailPreferences = async () => { throw new Error('RESEND_API_KEY internal detail'); };
  f.element('ownerEmailRecipients').value = 'changed@example.com';
  await f.run('saveOwnerEmailPreferences()');
  assert.equal(f.element('ownerEmailFields').disabled, false);
  assert.equal(f.element('ownerEmailSave').textContent, 'Save settings');
  assert.equal(f.element('ownerEmailRecipients').value, 'changed@example.com');
  assert.equal(f.element('ownerEmailTest').disabled, true);
  assert(!f.element('ownerEmailFeedback').textContent.includes('RESEND'));
}

// A timed-out write may have committed. Keep its draft visible, prevent another
// write/test, and require an explicit successful read before unlocking the form.
{
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  let saveCalls = 0;
  f.DB.saveOwnerEmailPreferences = async () => {
    saveCalls++;
    throw Object.assign(new Error('Internal save timeout'), { code: 'OWNER_EMAIL_SAVE_UNCERTAIN' });
  };
  f.element('ownerEmailRecipients').value = 'changed@example.com';
  await f.run('saveOwnerEmailPreferences()');
  assert.match(f.element('ownerEmailFeedback').textContent, /may already have been saved/);
  assert.match(f.element('ownerEmailFeedback').textContent, /Reload saved settings before trying again/);
  assert.equal(f.element('ownerEmailRecipients').value, 'changed@example.com');
  assert.equal(f.element('ownerEmailFields').disabled, true);
  assert.equal(f.element('ownerEmailReload').hidden, false);
  assert.equal(f.element('ownerEmailReload').style.display, '');
  assert.equal(f.element('ownerEmailReload').disabled, false);
  await f.run('saveOwnerEmailPreferences(); sendOwnerEmailTest();');
  assert.equal(saveCalls, 1, 'Unknown write outcomes must not encourage duplicate saves');
  assert.equal(f.tests.length, 0);
  f.DB.getOwnerEmailPreferences = async () => { throw new Error('Read unavailable'); };
  await f.run('reloadOwnerEmailPreferences()');
  assert.equal(f.element('ownerEmailFields').disabled, true);
  assert.equal(f.element('ownerEmailReload').hidden, false, 'A failed reload must stay retryable');
  assert.equal(f.element('ownerEmailReload').disabled, false);
  f.DB.getOwnerEmailPreferences = async () => ({ ...stored, emails: ['changed@example.com'] });
  await f.run('reloadOwnerEmailPreferences()');
  assert.equal(f.element('ownerEmailRecipients').value, 'changed@example.com');
  assert.equal(f.element('ownerEmailFields').disabled, false);
  assert.equal(f.element('ownerEmailTest').disabled, false);
  assert.equal(f.element('ownerEmailReload').hidden, true);
  assert.equal(f.element('ownerEmailReload').style.display, 'none');
  assert.equal(f.run('ownerEmailIsDirty()'), false);
}

// Test email uses only persisted server preferences: unsaved fields never become a payload.
{
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  f.element('ownerEmailRecipients').value = 'unsaved@example.com';
  f.run('ownerEmailFormChanged()');
  await f.run('sendOwnerEmailTest()');
  assert.equal(f.tests.length, 0);
  assert.match(f.element('ownerEmailFeedback').textContent, /Save your changes/);
  f.element('ownerEmailRecipients').value = 'owner@example.com';
  f.run('ownerEmailFormChanged()');
  await f.run('sendOwnerEmailTest()');
  assert.deepEqual(f.tests, [[]], 'Test endpoint receives no browser-provided recipients');
  assert.match(f.element('ownerEmailFeedback').textContent, /requested/);
  assert.equal(f.element('ownerEmailTest').textContent, 'Send Test Email');
}

// Double-clicks cannot send multiple tests while a request is active; failures recover.
{
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  let reject;
  f.DB.sendOwnerEmailTest = (...args) => {
    f.tests.push(args);
    return new Promise((_, no) => { reject = no; });
  };
  const first = f.run('sendOwnerEmailTest()');
  await settle();
  await f.run('sendOwnerEmailTest()');
  assert.equal(f.tests.length, 1);
  assert.equal(f.element('ownerEmailFields').disabled, true);
  reject(new Error('Private delivery detail'));
  await first;
  assert.equal(f.element('ownerEmailFields').disabled, false);
  assert.equal(f.element('ownerEmailTest').disabled, false);
  assert.equal(f.element('ownerEmailFeedback').attributes.role, 'alert');
  assert(!f.element('ownerEmailFeedback').textContent.includes('Private'));
}

// A lost test response must not claim a send failed or automatically send again.
for (const error of [new Error('Test email request (delivery outcome may be unknown) timed out'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  f.DB.sendOwnerEmailTest = async () => { f.tests.push([]); throw error; };
  await f.run('sendOwnerEmailTest()');
  assert.equal(f.tests.length, 1);
  assert.match(f.element('ownerEmailFeedback').textContent, /may still have been sent/);
  assert.match(f.element('ownerEmailFeedback').textContent, /Check your saved inboxes and spam folders before sending another test/);
  assert.equal(f.element('ownerEmailTest').disabled, false);
}

// Successful sends state provider acceptance; demo/other skipped sends remain explicit.
for (const [status, expected] of [['sent', /accepted by the email provider/], ['skipped', /No test email was sent/]]) {
  const f = fixture(stored);
  await f.run('renderOwnerEmailNotifications()');
  f.DB.sendOwnerEmailTest = async () => ({ ok: true, status });
  await f.run('sendOwnerEmailTest()');
  assert.match(f.element('ownerEmailFeedback').textContent, expected);
}

// History describes provider acceptance accurately and never emits raw error content.
{
  const f = fixture(stored);
  f.DB.getOwnerEmailNotificationLog = async () => ['queued', 'pending', 'sending', 'sent', 'failed', 'skipped'].map((status, i) => ({
    id: String(i), event: i % 2 ? 'new' : 'pending', status, attempts: 1,
    created_at: '2026-10-17T04:00:00Z', last_error: '<script>private-provider-error</script>',
  }));
  await f.run('renderOwnerEmailNotifications()');
  const html = f.element('ownerEmailHistory').innerHTML;
  for (const status of ['Pending', 'Sending', 'Sent', 'Failed', 'Skipped']) assert(html.includes(status));
  assert.equal((html.match(/>Pending<\/span>/g) || []).length, 2, 'Both queued server rows and pending rows must display Pending');
  assert(!html.includes('Unknown'));
  assert(html.includes('Accepted by the email provider.'));
  assert(!html.includes('private-provider-error'));
  f.DB.getOwnerEmailNotificationLog = async () => { throw new Error('Private database detail'); };
  await f.run('refreshOwnerEmailHistory()');
  assert(f.element('ownerEmailHistory').innerHTML.includes('role="alert"'));
  assert.equal(f.element('ownerEmailHistoryRefresh').disabled, false);
  assert.equal(f.element('ownerEmailHistory').attributes['aria-busy'], 'false');
}

// Failed initial reads cannot turn an unknown configuration into overwritten defaults.
{
  const f = fixture();
  f.DB.getOwnerEmailPreferences = async () => { throw new Error('Read failed'); };
  await assert.rejects(f.run('renderOwnerEmailNotifications()'), /Read failed/);
  await f.run('saveOwnerEmailPreferences()');
  assert.equal(f.saves.length, 0);
  assert.equal(f.element('ownerEmailFields').disabled, true);
}

// Staff and hosts cannot read, save, or test owner email settings through these handlers.
for (const role of ['staff', 'host']) {
  const f = fixture(stored, role);
  await f.run('renderOwnerEmailNotifications(); saveOwnerEmailPreferences(); sendOwnerEmailTest(); refreshOwnerEmailHistory();');
  assert.equal(f.reads.length + f.saves.length + f.tests.length, 0);
}

console.log('Email notification UI checks passed: accessible label, defaults, validation, saved-only tests, uncertain-save reload, delivery feedback, queued history, role guards.');
