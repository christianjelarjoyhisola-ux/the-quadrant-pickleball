import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INCLUDED_PLAYERS = 8;
const EXTRA_PLAYER_RATE = 100;
const feeFor = count => Math.max(0, count - INCLUDED_PLAYERS) * EXTRA_PLAYER_RATE;

assert.equal(feeFor(1), 0);
assert.equal(feeFor(8), 0);
assert.equal(feeFor(9), 100);
assert.equal(feeFor(10), 200);
assert.equal(feeFor(99), 9100);

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const expectText = (path, patterns) => {
  const text = source(path);
  patterns.forEach(pattern => assert.match(text, pattern, `${path} is missing ${pattern}`));
};

expectText('index.html', [
  /INCLUDED_PLAYERS_PER_COURT\s*=\s*8/,
  /EXTRA_PLAYER_RATE\s*=\s*100/,
  /bookingItemsExtraPlayerFee\(items\)/,
  /quoteBookingPlayerCount\(item\.ref, count\)/,
]);
expectText('supabase-config.js', [
  /quote_booking_player_count/,
  /included_players:\s*hasPlayerCount\s*\?/,
  /extra_player_fee:\s*hasPlayerCount\s*\?/,
]);
expectText('supabase/functions/create-payment-session/index.ts', [
  /courtTotal \+ serviceFee \+ extraPlayerFee/,
  /\(courtTotal \/ 2\) \+ serviceFee \+ extraPlayerFee/,
]);
expectText('supabase/functions/verify-gcash-receipt/index.ts', [
  /courtTotal \+ serviceFee \+ extraPlayerFee/,
  /\(courtTotal \/ 2\) \+ serviceFee \+ extraPlayerFee/,
]);
expectText('supabase/migrations/20260831120000_extra_player_pricing.sql', [
  /add column if not exists player_count integer/,
  /create or replace function public\.quote_booking_player_count/,
  /greatest\(p_player_count - 8, 0\) \* 100/,
  /app\.quote_booking_total/,
]);

console.log('Extra-player pricing checks passed: 8 included, PHP 100 per additional player, full surcharge due upfront.');
