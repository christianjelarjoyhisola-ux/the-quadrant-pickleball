# Domain setup for thequadrant.club

Use `thequadrant.club` as the production hostname.

## Cloudflare Pages

1. Open the Cloudflare Pages project for this site.
2. Add the custom domain `thequadrant.club`.
3. Add `www.thequadrant.club` too if you want `www` traffic to work.
4. Set the Pages/Worker environment variable:

```text
CANONICAL_HOST=thequadrant.club
```

The existing `_worker.js` redirects `www.thequadrant.club` to `thequadrant.club` when that variable is set.

## DNS

If the domain is managed in Cloudflare, Cloudflare Pages will create the needed DNS records during custom-domain setup.

If the domain is managed at another registrar, point the domain to the Cloudflare Pages target shown in the Pages custom-domain screen. Use the exact target Cloudflare gives you.

## Supabase Edge Function environment

Set these production values before deploying the functions:

```text
APP_ADMIN_URL=https://thequadrant.club/admin.html
APP_LOGO_URL=https://thequadrant.club/the-quadrant-logo.jpg
PAYMENT_SUCCESS_URL=https://thequadrant.club/
PAYMENT_CANCEL_URL=https://thequadrant.club/
EMAIL_FROM=The Quadrant <bookings@thequadrant.club>
```

Run the existing deploy script after updating `.env.local`:

```powershell
.\deploy-edge-functions.ps1
```
