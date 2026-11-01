-- Deployment template: run separately AFTER the migration and Edge Function
-- owner-email-notifications are deployed. This file is not an automatic migration.
--
-- 1. Enable pg_cron, pg_net and Vault in Supabase Dashboard.
-- 2. Set Edge Function secret OWNER_NOTIFICATION_WORKER_SECRET to a random value
--    of at least 32 characters. Deploy this function with --no-verify-jwt; its
--    process action authenticates the custom secret itself.
-- 3. Create these named Vault secrets through Dashboard (never commit values):
--    owner_email_worker_url:
--      https://<project-ref>.supabase.co/functions/v1/owner-email-notifications
--    owner_email_worker_secret: same value as OWNER_NOTIFICATION_WORKER_SECRET
--    owner_email_api_key: optional project publishable/anon key for the gateway
-- 4. Configure RESEND_API_KEY and EMAIL_FROM before enabling
--    an owner's saved notification preferences. No test email is sent here.
--
-- Official pattern: https://supabase.com/docs/guides/functions/schedule-functions
-- Same named cron job is updated on rerun, preventing duplicate schedules.
-- The worker claims at most 3 jobs per run (3/minute), in one concurrent wave.
-- A 120-second HTTP deadline leaves time for its bounded provider/database I/O.
-- Check every minute, but invoke the worker only when its claim RPC has work.
-- This avoids idle Edge/API requests; cron itself still runs and records results.

do $setup$
declare
  worker_url text;
  worker_secret text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
    or not exists (select 1 from pg_extension where extname = 'pg_net')
    or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Enable pg_cron, pg_net and Vault before configuring owner email delivery.';
  end if;
  select decrypted_secret into worker_url from vault.decrypted_secrets where name = 'owner_email_worker_url';
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name = 'owner_email_worker_secret';
  if worker_url is null or worker_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/functions/v1/owner-email-notifications$' then
    raise exception 'Set the owner_email_worker_url Vault secret to the deployed Supabase function URL.';
  end if;
  if worker_secret is null or length(worker_secret) < 32 then
    raise exception 'Set the owner_email_worker_secret Vault secret to the matching worker secret (32+ characters).';
  end if;
  perform cron.schedule(
    'owner-email-notifications',
    '* * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'owner_email_worker_url'),
        headers := jsonb_strip_nulls(jsonb_build_object(
          'Content-Type', 'application/json',
          'x-notification-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'owner_email_worker_secret'),
          'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'owner_email_api_key')
        )),
        body := '{"action":"process"}'::jsonb,
        timeout_milliseconds := 120000
      )
      where exists (
        select 1 from public.owner_email_notifications n
        where (
          -- Keep this aligned with claim_owner_email_notifications candidates.
          ((n.status = 'queued' and n.available_at <= now())
            or (n.status = 'sending' and n.locked_until <= now()))
          and n.attempts < 5
          and (n.first_attempt_at is null or n.first_attempt_at > now() - interval '23 hours')
        ) or (
          -- The RPC also finalizes exhausted jobs, even before available_at.
          -- Active leases must remain untouched until their lease expires.
          (n.status = 'queued' or (n.status = 'sending' and n.locked_until <= now()))
          and (n.attempts >= 5 or n.first_attempt_at <= now() - interval '23 hours')
        )
      );
    $job$
  );
end;
$setup$;

-- Monitoring (no secret or payload output):
-- select jobid, schedule, active from cron.job where jobname = 'owner-email-notifications';
-- select status, start_time, end_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'owner-email-notifications')
--   order by start_time desc limit 10;
-- Note: successful cron SQL may be an idle check with no HTTP request. When
-- work exists it queues HTTP asynchronously; verify Edge Function results and
-- owner_email_notifications delivery state as well.
-- Pause delivery scheduling if needed:
-- select cron.unschedule('owner-email-notifications');
