// Owner alerts are built from saved records and private preferences only.
// Keep this module dependency-free so its delivery and retry behavior can be tested offline.
export const ownerEmailCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-notification-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
type Row = Record<string, any>;
export type OwnerEmailDependencies = {
  db: any;
  env: (name: string) => string;
  fetcher?: typeof fetch;
  now?: () => number;
};
const MAX_ATTEMPTS = 5;
// One wave of three deliveries fits below the Edge runtime wall-clock limit,
// including database/read/write deadlines and failure-state persistence.
const MAX_BATCH_SIZE = 3;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 15000;
const ownerRoles = new Set(["owner", "court_owner"]);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...ownerEmailCors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]!);

export async function constantTimeSecret(
  actual: string,
  expected: string,
): Promise<boolean> {
  // Hash both inputs to fixed-length buffers; never short-circuit on their contents.
  const encode = (s: string) => new TextEncoder().encode(s);
  const [a, b] = await Promise.all(
    [actual, expected].map((s) => crypto.subtle.digest("SHA-256", encode(s))),
  );
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0 && expected.length >= 32 && actual.length > 0;
}

export function savedRecipients(preferences: Row | null): string[] {
  if (!Array.isArray(preferences?.emails)) return [];
  const emails = [
    ...new Set<string>(
      preferences.emails.map((email: unknown) =>
        String(email).trim().toLowerCase()
      ),
    ),
  ];
  return emails.length >= 1 && emails.length <= 3 &&
      emails.every((email) =>
        email.length <= 254 &&
        /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)
      )
    ? emails
    : [];
}

function adminLink(env: OwnerEmailDependencies["env"]): string {
  try {
    const url = new URL(
      env("APP_ADMIN_URL") || "https://thequadrant.club/admin.html",
    );
    if (url.protocol === "https:" && !url.username && !url.password) {
      return url.href;
    }
  } catch { /* Use the production admin if server configuration is invalid. */ }
  return "https://thequadrant.club/admin.html";
}

function formatDate(value: unknown): string {
  const date = new Date(`${String(value || "").slice(0, 10)}T12:00:00+08:00`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-PH", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
    })
    : "See admin";
}

function eventState(row: Row, entityType: string): string {
  const status = String(row.status || "").trim().toLowerCase(),
    payment = String(row.payment_status || "").trim().toLowerCase();
  if (
    status === "cancelled" ||
    ["failed", "rejected", "cancelled", "canceled", "expired"].includes(payment)
  ) return "cancelled";
  if (
    ["paid", "downpayment_paid"].includes(payment) ||
    (entityType === "booking" && ["confirmed", "completed"].includes(status))
  ) return "confirmed";
  return entityType === "open_play" || ["pending", "verifying"].includes(status)
    ? "pending"
    : "unknown";
}

export function usableSavedRows(rows: Row[], job: Row, now: number): Row[] {
  const real = rows.filter((row) => {
    if (
      !String(row.full_name || "").trim() ||
      String(row.email || "").trim().toLowerCase() ===
        "reserve@hold.internal" ||
      /^reserving/i.test(String(row.full_name).trim())
    ) return false;
    return true;
  });
  return real.filter((row) => {
    const state = eventState(row, job.entity_type);
    if (state === "cancelled") return false;
    if (job.event === "pending" && state !== "pending") return false;
    if (!["new_booking", "pending"].includes(job.event)) return false;
    // A future reservation may be several days old when its receipt enters review.
    // Suppress elapsed booking dates, not legitimate bookings based on creation age.
    const today = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (
      state === "pending" && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)) &&
      row.date < today
    ) return false;
    return true;
  });
}

export function buildOwnerEmail(
  job: Row,
  rows: Row[],
  emails: string[],
  env: OwnerEmailDependencies["env"],
): Row {
  const event = job.event;
  const title = event === "new_booking" ? "New booking" : "Pending booking";
  const link = adminLink(env);
  const ref = job.entity_type === "open_play"
    ? `Open Play #${job.entity_key}`
    : String(job.entity_key);
  const lines = rows.map((row) => [
    ["Court", row.court_name || row.court_id || "See admin"],
    ["Date", formatDate(row.date)],
    [
      "Time (Asia/Manila)",
      row.time_label ||
      [row.start_time, row.end_time].filter(Boolean).join(" – ") || "See admin",
    ],
    ["Customer", row.full_name || "See admin"],
    ["Payment status", row.payment_status || "unpaid"],
  ]);
  const text = `${title}\nReference: ${ref}\n\n${
    lines.map((details) =>
      details.map(([key, value]) => `${key}: ${value}`).join("\n")
    ).join("\n\n")
  }\n\nOpen admin: ${link}\n\nThis is an owner notification. Check saved payment details before confirming a booking.`;
  const html = `<h2>${esc(title)}</h2><p><strong>Reference:</strong> ${
    esc(ref)
  }</p>${
    lines.map((details) =>
      `<table>${
        details.map(([key, value]) =>
          `<tr><th align="left" style="padding:4px 16px 4px 0">${
            esc(key)
          }</th><td>${esc(value)}</td></tr>`
        ).join("")
      }</table><br>`
    ).join("")
  }<p><a href="${
    esc(link)
  }">Open admin</a></p><p>This is an owner notification. Check saved payment details before confirming a booking.</p>`;
  // Backups are BCC so saved addresses are not disclosed to each other.
  return {
    from: env("EMAIL_FROM"),
    to: [emails[0]],
    ...(emails.length > 1 ? { bcc: emails.slice(1) } : {}),
    subject: `[The Quadrant] ${title}`,
    html,
    text,
  };
}

export function retryUpdate(
  job: Row,
  code: string,
  now: number,
  retryable = true,
): Row {
  const firstAttempt = Date.parse(job.first_attempt_at || "");
  const delay = Math.min(
    2 * 60 * 60 * 1000,
    60000 * (2 ** Math.max(0, Number(job.attempts || 1) - 1)),
  );
  const retry = retryable && Number(job.attempts) < MAX_ATTEMPTS &&
    Number.isFinite(firstAttempt) &&
    now + delay < firstAttempt + RETRY_WINDOW_MS;
  return {
    status: retry ? "queued" : "failed",
    last_error: code,
    available_at: new Date(now + delay).toISOString(),
    lease_token: null,
    locked_until: null,
  };
}

export async function sendFrozenEmail(
  body: string,
  key: string,
  deps: OwnerEmailDependencies,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<{ id?: string; code?: string; retryable?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (deps.fetcher || fetch)(
      "https://api.resend.com/emails",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${deps.env("RESEND_API_KEY")}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body,
      },
    );
    // Keep the deadline active through response-body consumption too.
    const data = await response.json().catch(() => null);
    if (response.ok && typeof data?.id === "string" && data.id) {
      return { id: data.id };
    }
    return {
      code: `provider_http_${response.status}`,
      retryable: response.status === 429 || response.status === 409 ||
        response.status >= 500 || response.ok,
    };
  } catch {
    return {
      code: controller.signal.aborted
        ? "provider_timeout"
        : "provider_network_error",
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function guardedUpdate(
  db: any,
  job: Row,
  updates: Row,
): Promise<boolean> {
  const { data, error } = await db.from("owner_email_notifications").update(
    updates,
  )
    .eq("id", job.id).eq("lease_token", job.lease_token).eq("status", "sending")
    .select("id");
  if (error) throw new Error("queue_write_failed");
  return Boolean(data?.length);
}

async function loadSavedRows(db: any, job: Row): Promise<Row[]> {
  if (job.entity_type === "open_play") {
    const { data, error } = await db.from("open_play_registrations").select(
      "id,full_name,email,court_id,court_name,date,time_label,payment_status,created_at",
    ).eq("id", job.entity_key);
    if (error) throw new Error("booking_read_failed");
    return data || [];
  }
  if (job.entity_type !== "booking") return [];
  const fields =
    "ref,booking_group_ref,full_name,email,court_id,court_name,date,start_time,end_time,payment_status,status,created_at";
  // Do not interpolate keys into PostgREST filter syntax.
  const [group, single] = await Promise.all([
    db.from("bookings").select(fields).eq("booking_group_ref", job.entity_key)
      .order("ref"),
    db.from("bookings").select(fields).eq("ref", job.entity_key),
  ]);
  if (group.error || single.error) throw new Error("booking_read_failed");
  return group.data?.length ? group.data : single.data || [];
}

async function processJob(
  job: Row,
  deps: OwnerEmailDependencies,
): Promise<string> {
  const { db, env } = deps;
  const now = deps.now || Date.now;
  try {
    const [account, preference] = await Promise.all([
      db.from("accounts").select("role").eq("id", job.user_id).maybeSingle(),
      db.from("owner_email_preferences").select(
        "emails,enabled,notify_new,notify_pending",
      ).eq("user_id", job.user_id).maybeSingle(),
    ]);
    if (account.error || preference.error) {
      throw new Error("preference_read_failed");
    }
    const pref = preference.data, emails = savedRecipients(pref);
    const wantsEvent = job.event === "new_booking"
      ? pref?.notify_new
      : job.event === "pending" && pref?.notify_pending;
    if (
      !ownerRoles.has(account.data?.role) || !pref?.enabled || !wantsEvent ||
      !emails.length
    ) {
      await guardedUpdate(db, job, {
        status: "skipped",
        last_error: "alerts_disabled",
        lease_token: null,
        locked_until: null,
      });
      return "skipped";
    }
    if (
      Number(job.attempts) > MAX_ATTEMPTS ||
      now() - Date.parse(job.first_attempt_at || "") >= RETRY_WINDOW_MS
    ) {
      await guardedUpdate(db, job, {
        status: "failed",
        last_error: "retry_window_expired",
        lease_token: null,
        locked_until: null,
      });
      return "failed";
    }
    // Recheck state even for a frozen retry: a pending alert may have been superseded.
    const rows = usableSavedRows(await loadSavedRows(db, job), job, now());
    if (!rows.length) {
      await guardedUpdate(db, job, {
        status: "skipped",
        last_error: "booking_no_longer_matches",
        lease_token: null,
        locked_until: null,
      });
      return "skipped";
    }
    let body =
      job.payload?.version === 1 && typeof job.payload.body === "string"
        ? job.payload.body
        : "";
    if (body) {
      const frozen = JSON.parse(body);
      const recipients = savedRecipients({
        emails: [...(frozen.to || []), ...(frozen.bcc || [])],
      });
      if (
        JSON.stringify(recipients.sort()) !== JSON.stringify([...emails].sort())
      ) {
        await guardedUpdate(db, job, {
          status: "skipped",
          last_error: "recipients_changed",
          lease_token: null,
          locked_until: null,
        });
        return "skipped";
      }
    }
    if (!body) {
      body = JSON.stringify(buildOwnerEmail(job, rows, emails, env));
      // A failed freeze must never be followed by an email send.
      if (!await guardedUpdate(db, job, { payload: { version: 1, body } })) {
        return "lease_lost";
      }
    }
    const result = await sendFrozenEmail(
      body,
      String(job.idempotency_key),
      deps,
    );
    if (result.id) {
      const saved = await guardedUpdate(db, job, {
        status: "sent",
        provider_id: result.id,
        sent_at: new Date(now()).toISOString(),
        last_error: null,
        lease_token: null,
        locked_until: null,
      });
      return saved ? "sent" : "lease_lost";
    }
    const update = retryUpdate(job, result.code!, now(), result.retryable);
    await guardedUpdate(db, job, update);
    return update.status;
  } catch (error) {
    // No provider body, recipient, booking data, token, or arbitrary exception is logged/stored.
    const code = error instanceof Error &&
        ["preference_read_failed", "booking_read_failed", "queue_write_failed"]
          .includes(error.message)
      ? error.message
      : "notification_processing_failed";
    console.warn("Owner email worker:", code);
    const update = retryUpdate(job, code, now());
    try {
      return await guardedUpdate(db, job, update)
        ? update.status
        : "lease_lost";
    } catch {
      return "failed"; /* Lease recovery retries with the frozen provider key. */
    }
  }
}

export async function handleOwnerEmail(
  req: Request,
  deps: OwnerEmailDependencies,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: ownerEmailCors });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  let body: Row;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  if (!body || !["process", "test", "status"].includes(body.action)) {
    return json({ ok: false, error: "Unknown action" }, 400);
  }
  const { db, env } = deps;
  try {
    if (body.action === "process") {
      if (
        !await constantTimeSecret(
          req.headers.get("x-notification-secret") || "",
          env("OWNER_NOTIFICATION_WORKER_SECRET"),
        )
      ) return json({ ok: false, error: "Unauthorized" }, 401);
      if (!env("RESEND_API_KEY") || !env("EMAIL_FROM")) {
        return json({
          ok: false,
          error: "Owner email delivery is not configured",
        }, 503);
      }
      const { data, error } = await db.rpc("claim_owner_email_notifications", {
        p_limit: MAX_BATCH_SIZE,
      });
      if (error) {
        return json({
          ok: false,
          error: "Could not claim queued notifications",
        }, 503);
      }
      const jobs = (Array.isArray(data) ? data : []).slice(0, MAX_BATCH_SIZE);
      const counts: Record<string, number> = {};
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(MAX_BATCH_SIZE, jobs.length) },
          async () => {
            while (next < jobs.length) {
              const state = await processJob(jobs[next++], deps);
              counts[state] = (counts[state] || 0) + 1;
            }
          },
        ),
      );
      return json({ ok: true, processed: jobs.length, counts });
    }
    const authorization = req.headers.get("authorization") || "";
    if (!/^Bearer\s+\S+$/i.test(authorization)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    const { data: auth, error: authError } = await db.auth.getUser(
      authorization.replace(/^Bearer\s+/i, ""),
    );
    if (authError || !auth?.user?.id) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    const { data: account, error: accountError } = await db.from("accounts")
      .select("role").eq("id", auth.user.id).maybeSingle();
    if (accountError || !ownerRoles.has(account?.role)) {
      return json({ ok: false, error: "Owner access required" }, 403);
    }
    const { data: preferences, error: preferenceError } = await db.from(
      "owner_email_preferences",
    ).select("emails,enabled,notify_new,notify_pending").eq(
      "user_id",
      auth.user.id,
    ).maybeSingle();
    if (preferenceError) {
      return json(
        { ok: false, error: "Could not read email preferences" },
        503,
      );
    }
    const emails = savedRecipients(preferences);
    const configured = Boolean(
      env("RESEND_API_KEY") && env("EMAIL_FROM") &&
        env("OWNER_NOTIFICATION_WORKER_SECRET").length >= 32,
    );
    if (body.action === "status") {
      return json({
        ok: true,
        configured,
        enabled: Boolean(preferences?.enabled),
        recipientCount: emails.length,
      });
    }
    if (!configured) {
      return json({
        ok: false,
        error: "Owner email delivery is not configured",
      }, 503);
    }
    if (!emails.length) {
      return json({
        ok: false,
        error: "Save at least one valid notification email first",
      }, 400);
    }
    const { data: allowed, error: limitError } = await db.rpc(
      "reserve_owner_email_test",
      { p_user_id: auth.user.id },
    );
    if (limitError) {
      return json(
        { ok: false, error: "Could not reserve a test notification" },
        503,
      );
    }
    if (!allowed) {
      return json({
        ok: false,
        error: "Wait 60 seconds before sending another test",
      }, 429);
    }
    const payload = {
      from: env("EMAIL_FROM"),
      to: [emails[0]],
      ...(emails.length > 1 ? { bcc: emails.slice(1) } : {}),
      subject: "[The Quadrant] Owner notification test",
      text:
        `Your saved owner notification emails are configured.\nOpen admin: ${
          adminLink(env)
        }\nProvider acceptance does not confirm inbox delivery.`,
      html:
        `<h2>Owner notification test</h2><p>Your saved owner notification emails are configured.</p><p><a href="${
          esc(adminLink(env))
        }">Open admin</a></p><p>Provider acceptance does not confirm inbox delivery.</p>`,
    };
    const result = await sendFrozenEmail(
      JSON.stringify(payload),
      `owner-email-test/${auth.user.id}/${crypto.randomUUID()}`,
      deps,
    );
    return result.id
      ? json({
        ok: true,
        status: "sent",
        sent: true,
        recipientCount: emails.length,
        message:
          "Accepted by the email provider. Check your inbox and spam folder; delivery is not yet confirmed.",
      })
      : json({
        ok: false,
        error:
          "The email provider did not confirm acceptance. Try again later.",
      }, 502);
  } catch {
    console.warn("Owner email endpoint: request_failed");
    return json({
      ok: false,
      error: "Owner email notifications are temporarily unavailable",
    }, 503);
  }
}
