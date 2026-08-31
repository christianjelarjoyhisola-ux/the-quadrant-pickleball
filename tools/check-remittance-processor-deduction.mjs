import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  'supabase/migrations/20260831133000_legacy_paymongo_net_remittance.sql',
  'utf8',
);
const admin = await readFile('admin.html', 'utf8');

for (const expected of [
  'booking_fee_processor_deduction_snapshot',
  'booking_fee_net_amount_snapshot',
  "timestamptz '2026-07-13T15:25:18+08:00'",
  'booking_fee_net_amount_snapshot,',
  "r.status in ('prepared', 'payment_rejected')",
  "p.status in ('pending', 'accepted', 'partially_accepted')",
  'legacy_processor_deduction_reconciled',
  'largest-remainder method',
  'residual_cents',
]) {
  assert.ok(migration.includes(expected), `Missing remittance safeguard: ${expected}`);
}

assert.match(admin, /legacy PayMongo/);
assert.match(admin, /gross-net/);

const cutoff = new Date('2026-07-13T15:25:18+08:00').getTime();
const deduction = ({ createdAt, rail, status, total, downpayment, gross }) => {
  const digital = ['gcash', 'qrph', 'paymongo', 'paymongo_qrph', 'bdopay', 'maya', 'gotyme', 'pnb'];
  if (new Date(createdAt).getTime() >= cutoff || !digital.includes(rail) || !['paid', 'downpayment_paid'].includes(status)) return 0;
  const paid = status === 'paid' ? total : (downpayment ?? total / 2);
  return Math.min(gross, Math.round((paid * 0.0134 + Number.EPSILON) * 100) / 100);
};

assert.equal(deduction({ createdAt: '2026-07-01T00:00:00Z', rail: 'paymongo', status: 'paid', total: 1000, gross: 45 }), 13.4);
assert.equal(deduction({ createdAt: '2026-07-14T00:00:00+08:00', rail: 'paymongo', status: 'paid', total: 1000, gross: 45 }), 0);
assert.equal(deduction({ createdAt: '2026-07-01T00:00:00Z', rail: 'cash', status: 'paid', total: 1000, gross: 45 }), 0);
assert.equal(deduction({ createdAt: '2026-07-01T00:00:00Z', rail: 'paymongo', status: 'downpayment_paid', total: 1000, downpayment: 400, gross: 45 }), 5.36);
assert.equal(deduction({ createdAt: '2026-07-01T00:00:00Z', rail: 'paymongo', status: 'paid', total: 5000, gross: 15 }), 15);

const julyRawProcessorFees = [3.551, 7.102, 2.881, 7.102, 7.102];
const julyAggregateDeduction = Math.round(
  (julyRawProcessorFees.reduce((sum, amount) => sum + amount, 0) + Number.EPSILON) * 100,
) / 100;
assert.equal(julyAggregateDeduction, 27.74);
assert.equal(Math.round((735 - 27.74 + Number.EPSILON) * 100) / 100, 707.26);
assert.equal(Math.round((707.26 + 2025 + Number.EPSILON) * 100) / 100, 2732.26);

console.log('Legacy PayMongo remittance deduction checks passed.');
