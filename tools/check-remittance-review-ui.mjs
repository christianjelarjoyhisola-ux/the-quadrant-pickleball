import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const admin = await readFile('admin.html', 'utf8');
const statusSource = admin.match(/function rmStatus\(r\)\{[^\r\n]+\}/)?.[0];
const cardSource = admin.match(/function rmRecordCard\(r\)\{[^\r\n]+\}/)?.[0];

assert.ok(statusSource, 'Could not find the remittance status resolver.');
assert.ok(cardSource, 'Could not find the remittance record renderer.');

const rmVal = (record, key) => record?.[key];
const rmPayment = record => record?.latest_payment || {};
const statusFor = Function(
  'rmVal',
  'rmPayment',
  `'use strict';${statusSource};return rmStatus;`,
)(rmVal, rmPayment);

assert.equal(
  statusFor({ status: 'submitted', is_overdue: true }),
  'under-review',
  'A submitted proof must remain under review even after the due date.',
);
assert.equal(
  statusFor({
    status: 'prepared',
    is_overdue: true,
    latest_payment: { status: 'pending' },
  }),
  'under-review',
  'A pending proof must remain reviewable even if the header is stale.',
);
assert.equal(
  statusFor({ status: 'prepared', is_overdue: true }),
  'overdue',
  'An overdue unpaid remittance must still be labeled overdue.',
);
assert.equal(
  statusFor({ status: 'settled', is_overdue: true }),
  'settled',
  'A settled remittance must not regress to overdue.',
);
assert.equal(
  statusFor({ status: 'cancelled', is_overdue: true }),
  'cancelled',
  'A cancelled remittance must not regress to overdue.',
);
assert.equal(
  statusFor({ status: 'payment_rejected', is_overdue: true }),
  'rejected',
  'A rejected proof must remain rejected even after the due date.',
);

const renderCardForRole = role => Function(
  '_rmState',
  'sess',
  'rmStatus',
  'rmStatusLabel',
  'rmPayment',
  'rmId',
  'rmRef',
  'rmDate',
  'jsArg',
  'rmDue',
  'fmt',
  'rmRemaining',
  'rmCount',
  'esc',
  'rmBreakdown',
  `'use strict';${cardSource};return rmRecordCard;`,
)(
  { dashboard: { role } },
  { role },
  statusFor,
  status => status,
  rmPayment,
  record => String(record.id),
  record => String(record.remittance_ref),
  () => 'Sep 1, 2026',
  value => value,
  record => Number(record.amount_due),
  value => `PHP ${Number(value).toFixed(2)}`,
  record => Number(record.remaining_balance),
  record => Number(record.bookings_count),
  value => String(value),
  () => 'PHP 15/hr',
);

const submittedOverdue = {
  id: 'test-remittance',
  remittance_ref: 'REM-TEST',
  status: 'submitted',
  is_overdue: true,
  amount_due: 2732.26,
  remaining_balance: 2732.26,
  bookings_count: 73,
  latest_payment: { payment_reference: '1044575913697', status: 'pending' },
};
const ownerCard = renderCardForRole('owner')(submittedOverdue);

assert.match(
  ownerCard,
  />Review Proof<\/button>/,
  'System Owners must receive the Review Proof action for under-review remittances.',
);
assert.doesNotMatch(
  ownerCard,
  />Record Payment<\/button>/,
  'A remittance with pending proof must not offer Record Payment again.',
);
assert.doesNotMatch(
  renderCardForRole('court_owner')(submittedOverdue),
  />Review Proof<\/button>/,
  'Court Owners must not receive the System Owner review action.',
);

console.log('Remittance review-state precedence and System Owner action checks passed.');
