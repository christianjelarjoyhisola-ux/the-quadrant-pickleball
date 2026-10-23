# Log ingestion audit — 23 October 2026

## Measured baseline

Supabase Dashboard, current billing cycle 25 September–25 October 2026:

| Scope | Logs ingested | Logs queried |
| --- | ---: | ---: |
| Organization, all projects | 0.759 GB | 12.373 GB |
| the-quadrant-pickleball | 0.099 GB | 10.55 GB |

The Quadrant represents approximately 13% of organization ingestion. The remaining approximately 87% is outside this project; reducing this project's logs alone cannot remove most organization usage. Query volume measures logs scanned and is not ingestion. Dashboard figures can lag by an hour.

A last-hour aggregate query in The Quadrant Logs Explorer returned: Postgres 142 events, function runtime 120, PostgREST 85, API gateway 61, function requests 59, Realtime 5. These are counts, not billed bytes, and do not establish each service's byte share.

## Database configuration inspected read-only

The SQL Editor's current Postgres session reported:

| Setting | Value |
| --- | --- |
| log_statement | ddl |
| log_min_duration_statement | -1 |
| log_min_messages | warning |
| log_connections / log_disconnections | off / off |
| log_lock_waits | on |
| log_autovacuum_min_duration | 600000 |
| log_temp_files | -1 |
| pgaudit.log | none |
| cron.log_statement | on |
| cron.log_min_messages | warning |
| cron.log_run | on |

Do not disable errors, lock-wait diagnostics, or schema-change logging for speculative savings. Per-role/per-database overrides were not audited. Cron command logging deserves separate review: retain execution history and failure visibility if routine command text logging is reduced.

## Prepared local improvements (not deployed)

1. `tools/setup-owner-email-schedule.sql` now invokes the email worker only when a job can be claimed or requires terminal cleanup. Minute cadence, leases, retry limits, and failure logging remain intact. An entirely idle day avoids up to 1,440 Edge Function calls and 1,440 claim REST requests. Cron still runs every minute. This is an avoided-request estimate, not a measured log-byte reduction; command text logging can offset some savings.
2. `index.html` now invalidates only affected caches, coalesces events, serializes realtime refreshes, waits for slot rendering, and pauses realtime-triggered reads in hidden tabs. It catches up on visibility/reconnection. Payment polling remains unchanged. Actual savings depend on events, cache expiry, and traffic; dashboard Realtime message usage was zero for this project in this billing period, so this is primarily prevention and reliability work.
3. Added focused behavior tests to existing reliability/notification check commands. The SQL test covers an empty queue, backlog, and 360 retry/lease/age/status combinations against the actual claim function. Both check suites passed.

## Cloudflare

The deployed Pages Worker only redirects www and serves assets; it has no logging calls. No custom observability/Logpush configuration was found in the repository. Standard Pages Function logs are temporary live streams, not persisted Workers Logs. Account-wide exports and ingestion remain unverified because available credentials do not permit those APIs. No evidence supports changing Cloudflare sampling now; blanket sampling can discard error requests too.

## Recommended rollout and measurement

- Review/apply the guarded scheduler and publish the frontend changes when releasing this optimization. The old ignored deployment helper pins the former scheduler hash and must not be reused without review.
- Scope confirmed by the owner: The Quadrant only; do not modify or audit the other project as part of this release.
- Set `cron.log_statement=off` during a planned maintenance window, keeping `cron.log_run=on` and existing warning/error settings. Supabase explicitly recommends this combination when using `cron.job_run_details`. This setting requires a database restart; do not restart the live booking database casually. After applying, verify `setting='off'` and `pending_restart=false`, plus continued scheduled execution and failure visibility.
- Record daily ingest for comparable traffic over 48–72 hours after changes, with invocation/error counts and queue health. Do not compare cumulative month totals as a before/after daily rate.
- Use short, filtered log queries; reducing query scans does not itself reduce ingestion.

No production settings, scheduler, deployments, customer data, or email sends were changed during this audit. Browser access was sufficient for the read-only measurements; the former 24-hour deployment token was not reused.

References:
- https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest
- https://supabase.com/docs/guides/platform/manage-your-usage/logs-query
- https://developers.cloudflare.com/pages/functions/debugging-and-logging/#limits
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://github.com/citusdata/pg_cron#extension-settings
- https://supabase.com/docs/guides/database/postgres/postgres-log-config#cronlog_statement
- https://supabase.com/docs/guides/database/custom-postgres-config#managing-postgres-configuration-with-the-cli

## Release update — 23 October 2026

The guarded scheduler was applied to project `mjwmvlhzjkaduwdtfwiu` through its authenticated dashboard and verified active, every minute, with the guard present and zero pending jobs. The complete `launch:check` suite passed, including production dependency audit (zero vulnerabilities).

The frontend optimization is included in this release. `cron.log_statement` remains unchanged: the former deployment token expired and current CLI access returns HTTP 401. Completing that setting requires renewed Management API/CLI access and a database restart; neither was performed in this release.

Drive D: had no free space. Release commits and packaging use a separate checkout on C:; the original workspace and unrelated user files remain intact. No other Supabase project is changed.
