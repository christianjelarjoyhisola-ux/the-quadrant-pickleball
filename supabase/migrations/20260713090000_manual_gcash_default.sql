-- Manual GCash is the default processing mode. QRPh/PayMongo remains available
-- as an explicit admin opt-in through the gcash_checkout_enabled setting.
insert into public.settings (key, value)
values ('gcash_checkout_enabled', '0')
on conflict (key) do update
set value = excluded.value;
