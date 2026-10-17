# Owner booking email alerts

Admin > Email Notifications lets each system owner or court owner save a primary
address and up to two backup addresses. Alerts start disabled. Recipients are
private to that account; they are not stored in the publicly readable settings.

Recommended settings: enable New bookings and Pending / payment review. A new
pending reservation produces one email per recipient configuration, including
all courts in a grouped booking. A later payment-review transition can produce
one additional alert. There are no repeated reminders, owner confirmation
emails, or cancellation emails. Existing player confirmation emails continue.
Open Play registrations use the same preferences. Backup addresses are BCC.

## Deployment order

Apply the backend before publishing the new frontend. These instructions target
the existing project `mjwmvlhzjkaduwdtfwiu`; verify the selected project first.
The broad `deploy-edge-functions.ps1` is for full installations and writes local
provider secrets. Do not use it for this targeted update.

1. Run `npm run launch:check` locally. Tests use fake recipients and isolated
   PostgreSQL; they do not contact production or send emails.
2. Apply only `supabase/migrations/20261017080000_owner_email_notifications.sql`
   through the project's normal migration process or Supabase SQL Editor. Apply
   it once, in a transaction. If using the SQL Editor, record its migration
   version in the deployment record before a later CLI migration deployment.
   It creates preferences/outbox tables and booking/Open Play triggers. No
   booking records or existing Telegram history are deleted or backfilled.
3. Keep the existing `RESEND_API_KEY` and verified `EMAIL_FROM`. Set a new random
   server-only `OWNER_NOTIFICATION_WORKER_SECRET` of at least 32 characters in
   Edge Function secrets. Never place it in frontend code, Git, or public settings.
4. Deploy the five functions using `tools/deploy-owner-email.ps1`. This deploys
   the queue worker, integration status, receipt verifier without its Telegram
   call, and both retired Telegram endpoints. Their retired responses stop old
   cached clients/webhooks from sending Telegram messages.
5. Follow `tools/setup-owner-email-schedule.sql`: enable pg_cron, pg_net and Vault,
   add the named URL/secret values, then run the scheduler template. The Vault
   `owner_email_worker_secret` must match the Edge Function secret. The worker runs
   every minute; its process endpoint authenticates this secret itself.
6. Verify the scheduler is active and a worker invocation returns success with
   an empty queue. Check actual HTTP/function results, not only cron SQL success.
   Keep preferences disabled during setup. Do not create live sample bookings.
7. Publish the whitelisted static website assets to Cloudflare Pages. Do not
   upload the repository root, environment files, migrations, or deployment tools.
8. The owner signs in, saves their actual email, selects alerts, and enables them.
   They may explicitly click Send Test Email to check their own inbox/spam folder.

The deployment script requires an authenticated Supabase CLI with access to the
project. It does not overwrite provider secrets or run unrelated migrations.

## Delivery behavior and troubleshooting

The booking transaction queues an alert without making an HTTP request. Closing
the customer's browser does not cancel the queued alert. The queue waits 15
seconds to collect grouped writes; delivery normally starts on the next minute's
worker run. Provider outages retry up to five times within 23 hours, with the
same frozen message and idempotency key. Changes to recipients or booking state
can skip obsolete alerts. Failed alerts require review; there is no automatic
replay beyond the provider deduplication window.

Admin shows the last 25 alerts for the signed-in owner. “Sent” means the provider
accepted the message, not that the recipient's inbox received it. Test sends
have a server-side 60-second throttle and report acceptance directly; they do not
create a booking or a delivery-history row. If a test request times out, inspect
the inbox/provider before manually trying again.

Use the monitoring queries in the scheduler template and Supabase function logs.
Never copy message payloads, recipients, Vault values, or provider credentials
into public logs. Integration status confirms secret presence, not scheduler
health or inbox delivery. To stop delivery, disable owner preferences or pause
the named cron job; preserve the queue and booking records for diagnosis.

Scheduler reference: https://supabase.com/docs/guides/functions/schedule-functions
Provider deduplication: https://resend.com/docs/dashboard/emails/idempotency-keys
