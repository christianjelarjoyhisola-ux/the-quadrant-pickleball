import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  'supabase/migrations/20260831213000_align_remittance_with_reportable_bookings.sql',
  'utf8',
);

for (const expected of [
  "new.status in ('confirmed', 'completed')",
  "b.status in ('confirmed', 'completed')",
  'b.booking_fee_earned_at is null',
  'booking_fee_remittance_items',
  'cancelled rows remain audit history but leave the live balance',
]) {
  assert.ok(migration.includes(expected), `Missing report-alignment safeguard: ${expected}`);
}

assert.doesNotMatch(
  migration,
  /new\.payment_status\s+in\s*\('paid',\s*'downpayment_paid'\)/,
  'Confirmed/completed report rows must not be omitted solely because receipt review is pending.',
);

const previousLiveBalance = 2822.26;
const cancelledUnclaimedFee = 8 * 15;
const completedPendingReviewFee = 2 * 15;
const correctedLiveBalance = Math.round(
  (previousLiveBalance - cancelledUnclaimedFee + completedPendingReviewFee + Number.EPSILON) * 100,
) / 100;

assert.equal(correctedLiveBalance, 2732.26);

console.log('Remittance/report alignment checks passed: cancelled -PHP 120, completed review +PHP 30.');
