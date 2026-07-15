-- Preserve the legacy PayMongo processor deduction for bookings created before
-- this instant. New bookings use one flat PHP 15 booking fee with no processor
-- deduction. Existing booking rows and generated remittance statements are not
-- rewritten.
insert into public.settings (key, value)
values
  ('maintenance_fee', '15'),
  ('service_fee_rate', '15'),
  ('booking_fee', '15'),
  ('fee_type', 'flat'),
  ('processor_fee_legacy_cutoff_at', '2026-07-13T15:25:18+08:00')
on conflict (key) do update
set value = excluded.value;
