# The Quadrant Pickleball Booking System

Client-ready copy based on the pickleball booking system template.

## Brand Setup

Primary brand values live in `brand-config.js`.

Before launch, confirm and update:

1. Venue address and Google Maps URL.
2. Public domain.
3. Court names, photos, rates, and operating hours.
4. GCash/Maya/GoTyme/PNB payment account names, numbers, and QR images.
5. Admin owner/staff account emails.

## New Client Infrastructure

1. Create a brand-new Supabase project for The Quadrant.
2. Run `SETUP_NEW_SUPABASE.sql` in the new Supabase SQL editor.
3. Apply the remaining files in `supabase/migrations/` in dependency order: payment/security migrations first, agreement/receipt/weekly billing migrations next, `20260626_role_based_security.sql` before the host-session migrations, then the BDO Pay/Maya/received-account migrations.
4. Copy `.env.example` to `.env.local` and fill in the new Supabase values.
5. Update `supabase-config.js` with the new Supabase project URL and anon key.
6. Run `node create-accounts.js` only after `.env.local` has the new service role key.
7. Deploy the Supabase edge functions to the new Supabase project with `.\deploy-edge-functions.ps1`.
8. Set any remaining provider/dashboard settings, including verified email sender, PayMongo webhook, payment accounts, and Telegram if used.
9. Deploy the frontend to a new Cloudflare Pages project or domain.

## Important

Do not reuse another court owner's Supabase project. Each court owner must have separate bookings, Open Play reservations, payment settings, edge function secrets, and admin accounts.

Use `?localData=1` on the website URL when testing with browser-only demo data.
