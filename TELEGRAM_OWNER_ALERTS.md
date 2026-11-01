# Telegram owner alerts

Owner notifications use Telegram. Player confirmation/reschedule emails remain unchanged.

The two independent events are `pending` (action needed) and `auto_confirmed` (no action needed). A booking/group can have one of each, and they are always separate messages. Holds, verification in progress, manual confirmations, cancelled/failed payments, and unrelated historical edits do not create automatic-confirmation alerts. Receipt verification is recognized after its status and `auto_approved` metadata writes; successful PayMongo functions attach a server-controlled source marker. Open Play follows the same rules.

Jobs settle for 60 seconds and are rechecked immediately before delivery. A pending job that has already confirmed is skipped. The scheduler checks every minute but invokes the worker only for due jobs or necessary cleanup. Errors and cron run history remain enabled; do not change the existing `cron.log_statement=off` setting.

Admin → Telegram Notifications has a private chat ID, enable switch, separate event switches, explicit test button, and delivery history. A chat can have one enabled managing account to prevent duplicate group notifications. Send `/start` to the existing bot to obtain the chat ID; `/start` alone never grants booking access. `/stop` disables that chat's saved alerts. Tests are explicit, throttled, and use only the authenticated owner's saved destination. No test message is sent during deployment.

Telegram has no sendMessage idempotency key. Definite rate-limit rejections can retry; ambiguous timeouts, network failures, or interrupted dispatches are marked failed for review instead of automatically resending. Check the chat before retrying. This favors avoiding duplicates over automatic recovery of ambiguous delivery. Queue history is not evidence the owner read the message.

## Quadrant-only rollout

Target: `mjwmvlhzjkaduwdtfwiu`, Cloudflare Pages `the-quadrant-pickleball`.

1. Run `npm run launch:check`. Use a release checkout on C: because D: is nearly full.
2. Verify access to this exact Supabase project and that `TELEGRAM_BOT_TOKEN` is still configured. Preserve all player-email secrets.
3. Deploy the retired `owner-email-notifications` endpoint first; allow existing invocations to finish (at least five minutes). Do not publish the new frontend before the backend is ready.
4. Apply `supabase/migrations/20261025080000_owner_telegram_notifications.sql`. It disables email preferences, revokes their write access, skips outstanding email jobs, and removes email enqueue triggers. Historical email records are retained.
5. Deploy `owner-telegram-notifications`, `payment-webhook`, `sync-payment-session`, `telegram-webhook`, `integration-status`, and the harmless legacy `send-telegram-notification` endpoint. The worker and webhook authenticate requests themselves; deploy them with `--no-verify-jwt`. Preserve existing authentication behavior for payment functions.
6. Keep the existing `OWNER_NOTIFICATION_WORKER_SECRET`. Create Vault entries `owner_telegram_worker_secret` with that same value and `owner_telegram_worker_url` with `https://mjwmvlhzjkaduwdtfwiu.supabase.co/functions/v1/owner-telegram-notifications`. An optional `owner_telegram_api_key` may reuse the old public gateway key. Copy secrets within Vault; never print them or commit them. Run `tools/setup-owner-telegram-schedule.sql`; it removes the old email schedule and creates the guarded Telegram schedule.
7. Verify the existing bot's webhook still points to this project's `telegram-webhook`. The previously installed webhook-secret digest remains supported; if rotating it, set a 32+ character `TELEGRAM_WEBHOOK_SECRET` and use the same value in Telegram's `setWebhook` request.
8. Verify the intended existing owner/chat mapping before enabling its preferences. Do not assign legacy global subscription records to arbitrary accounts. Use Admin or a reviewed service-side insert for the verified owner and existing chat ID. Retained legacy subscriptions are not automatically reactivated.
9. Publish only the explicit static asset package to Cloudflare Pages. Verify the live admin shows Telegram controls, the email endpoint is retired, the guarded cron succeeds, and no old email jobs remain active. Do not create production bookings or send test messages without recipient-specific authorization.

## Verification

`check:notifications` covers real PostgreSQL migration behavior, RLS, private preferences, source-marker protection, distinct transitions, grouped deduplication, switches, stale-state handling, lease recovery, scheduler/claim equivalence, UI behavior, full-request deadlines, saved-only test destinations, and mocked Telegram delivery. The Telegram unit tests never contact Telegram.

Local preview: `admin.html?localData=1` on localhost. Production ignores the local bypass.

If rollout must pause, leave the frontend unchanged. If rolling back after migration, pause the Telegram cron and disable Telegram preferences first; do not re-enable owner emails automatically. Player confirmation emails are unaffected by either path.
