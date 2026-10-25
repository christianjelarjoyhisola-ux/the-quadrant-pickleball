import {
  constantTimeSecret,
  ownerEmailCors,
  retryUpdate,
} from "./owner-email.ts";

type Row = Record<string, any>;
export type Dependencies = {
  db: any;
  env: (key: string) => string;
  fetcher?: typeof fetch;
  now?: () => number;
};
export const telegramCors = ownerEmailCors;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...telegramCors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const roles = new Set(["owner", "court_owner"]);
export const validChat = (value: unknown): string =>
  /^-?[1-9][0-9]{0,19}$/.test(String(value || "")) ? String(value) : "";
const lower = (value: unknown) => String(value || "").trim().toLowerCase();

// Keep classification aligned with owner_telegram_state in the migration.
export function notificationState(r: Row, kind: string): string {
  const status = lower(r.status), payment = lower(r.payment_status);
  if (
    ["cancelled", "canceled", "completed"].includes(status) ||
    ["failed", "rejected", "cancelled", "canceled", "expired"].includes(payment)
  ) return "ignore";
  const paid = ["paid", "downpayment_paid"].includes(payment);
  if (
    (status === "confirmed" || kind === "open_play") && paid &&
    (r.receipt_status === "auto_approved" ||
      r.automatic_confirmation_source === "paymongo")
  ) return "auto_confirmed";
  if (
    status === "confirmed" || paid || status === "verifying" ||
    ["processing", "verifying"].includes(lower(r.receipt_status))
  ) return "ignore";
  return kind === "open_play" || status === "pending" ? "pending" : "ignore";
}

export function matchingRows(rows: Row[], job: Row, now: number): Row[] {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  return rows.filter((r) =>
    String(r.full_name || "").trim() &&
    !/^reserving/i.test(String(r.full_name).trim()) &&
    lower(r.email) !== "reserve@hold.internal" &&
    notificationState(r, job.entity_type) === job.event &&
    !(job.event === "pending" && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) &&
      r.date < today)
  );
}

function adminUrl(env: Dependencies["env"]): string {
  try {
    const url = new URL(
      env("APP_ADMIN_URL") || "https://thequadrant.club/admin",
    );
    if (url.protocol === "https:" && !url.username && !url.password) {
      return url.href;
    }
  } catch { /* Safe production fallback. */ }
  return "https://thequadrant.club/admin";
}
const short = (value: unknown, max = 100) =>
  String(value ?? "See admin").replace(/[\r\n\t]/g, " ").slice(0, max);
export function buildTelegram(
  job: Row,
  rows: Row[],
  chatId: string,
  env: Dependencies["env"],
): Row {
  const confirmed = job.event === "auto_confirmed";
  const heading = confirmed
    ? "🟢 Automatically confirmed — no action needed"
    : "🟠 Pending booking — action needed";
  const details = rows.slice(0, 6).map((r) =>
    [
      `Player: ${short(r.full_name)}`,
      `Court: ${short(r.court_name || r.court_id)}`,
      `Date: ${short(r.date)}`,
      `Time (Manila): ${
        short(
          r.time_label ||
            [r.start_time, r.end_time].filter(Boolean).join(" – "),
        )
      }`,
      `Amount: PHP ${short(r.total ?? r.amount ?? "See admin", 30)}`,
      `Payment: ${short(r.payment_status)}${
        r.payment_method ? " / " + short(r.payment_method, 30) : ""
      }`,
    ].join("\n")
  ).join("\n\n");
  // Plain text prevents user-controlled names from becoming Telegram markup.
  // Bound the total below Telegram's 4096-character limit, including grouped bookings.
  const text =
    `${heading}\n${
      job.entity_type === "open_play" ? "Open Play " : ""
    }Reference: ${short(job.entity_key, 120)}\n\n${details}`.slice(0, 3700) +
    (rows.length > 6 ? `\n\n${rows.length - 6} more slots — see Admin.` : "") +
    (confirmed
      ? "\n\nPayment was automatically verified. This is a separate confirmation alert."
      : "\n\nReview this booking in Admin. It has not been automatically confirmed.");
  return {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "Open Admin", url: adminUrl(env) }]],
    },
  };
}

export async function sendTelegram(
  body: Row,
  deps: Dependencies,
  timeoutMs = 15000,
): Promise<{ id?: string; code?: string; retryable?: boolean }> {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await (deps.fetcher || fetch)(
      `https://api.telegram.org/bot${
        deps.env("TELEGRAM_BOT_TOKEN")
      }/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      },
    );
    const result = await response.json().catch(() => null);
    if (
      response.ok && result?.ok === true &&
      Number.isSafeInteger(result?.result?.message_id)
    ) return { id: String(result.result.message_id) };
    // Only a definite rate-limit rejection is automatically retried. Telegram
    // offers no idempotency key; a timeout/5xx may have already delivered.
    return {
      code: `telegram_http_${response.status}`,
      retryable: response.status === 429 && result?.ok === false,
    };
  } catch {
    return { code: "telegram_delivery_unknown", retryable: false };
  } finally {
    clearTimeout(timer);
  }
}

async function update(db: any, job: Row, value: Row): Promise<boolean> {
  const { data, error } = await db.from("owner_telegram_notifications").update(
    value,
  )
    .eq("id", job.id).eq("lease_token", job.lease_token).eq("status", "sending")
    .select("id");
  if (error) throw new Error("queue_write_failed");
  return Boolean(data?.length);
}
async function rowsFor(db: any, job: Row): Promise<Row[]> {
  if (job.entity_type === "open_play") {
    const { data, error } = await db.from("open_play_registrations")
      .select(
        "id,full_name,email,court_id,court_name,date,time_label,payment_status,receipt_status,automatic_confirmation_source,amount,payment_method",
      )
      .eq("id", job.entity_key);
    if (error) throw new Error("booking_read_failed");
    return data || [];
  }
  if (job.entity_type !== "booking") return [];
  const fields =
    "ref,booking_group_ref,full_name,email,court_id,court_name,date,start_time,end_time,payment_status,status,receipt_status,automatic_confirmation_source,total,payment_method";
  const [group, single] = await Promise.all([
    db.from("bookings").select(fields).eq("booking_group_ref", job.entity_key)
      .order("ref"),
    db.from("bookings").select(fields).eq("ref", job.entity_key),
  ]);
  if (group.error || single.error) throw new Error("booking_read_failed");
  return group.data?.length ? group.data : single.data || [];
}
async function processJob(job: Row, deps: Dependencies): Promise<string> {
  const now = deps.now || Date.now, { db, env } = deps;
  let dispatched = job.payload?.dispatch === "started";
  const finish = async (
    status: string,
    last_error: string | null,
    extra: Row = {},
  ) => {
    await update(db, job, {
      status,
      last_error,
      lease_token: null,
      locked_until: null,
      ...extra,
    });
    return status;
  };
  try {
    if (dispatched) return await finish("failed", "telegram_delivery_unknown");
    const [account, pref] = await Promise.all([
      db.from("accounts").select("role").eq("id", job.user_id).maybeSingle(),
      db.from("owner_telegram_preferences").select(
        "chat_id,enabled,notify_auto_confirmed,notify_pending",
      ).eq("user_id", job.user_id).maybeSingle(),
    ]);
    if (account.error || pref.error) throw new Error("preference_read_failed");
    const chat = validChat(pref.data?.chat_id);
    const wants = job.event === "pending"
      ? pref.data?.notify_pending
      : job.event === "auto_confirmed" && pref.data?.notify_auto_confirmed;
    if (
      !roles.has(account.data?.role) || !pref.data?.enabled || !chat || !wants
    ) return await finish("skipped", "alerts_disabled");
    const rows = matchingRows(await rowsFor(db, job), job, now());
    if (!rows.length) {
      return await finish("skipped", "booking_no_longer_matches");
    }
    if (job.payload?.body?.chat_id && job.payload.body.chat_id !== chat) {
      return await finish("skipped", "recipient_changed");
    }
    const body = buildTelegram(job, rows, chat, env);
    // Persist intent BEFORE sending: an expired lease after this point must not resend.
    if (
      !await update(db, job, {
        payload: { version: 1, dispatch: "started", body },
      })
    ) return "lease_lost";
    dispatched = true;
    const result = await sendTelegram(body, deps);
    if (result.id) {
      return await finish("sent", null, {
        provider_id: result.id,
        sent_at: new Date(now()).toISOString(),
      });
    }
    const changes = retryUpdate(
      job,
      result.code!,
      now(),
      result.retryable === true,
    );
    if (result.retryable) {
      changes.payload = { version: 1, dispatch: "rejected", body };
    }
    await update(db, job, changes);
    return changes.status;
  } catch {
    // Never log recipient, booking data, token or raw provider exceptions.
    const changes = retryUpdate(
      job,
      dispatched ? "telegram_delivery_unknown" : "notification_read_failed",
      now(),
      !dispatched,
    );
    try {
      await update(db, job, changes);
    } catch { /* Claim recovery handles the expired lease. */ }
    return changes.status;
  }
}

export async function handleOwnerTelegram(
  req: Request,
  deps: Dependencies,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: telegramCors });
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
      if (!env("TELEGRAM_BOT_TOKEN")) {
        return json({ ok: false, error: "Telegram is not configured" }, 503);
      }
      const { data, error } = await db.rpc(
        "claim_owner_telegram_notifications",
        { p_limit: 3 },
      );
      if (error) {
        return json({ ok: false, error: "Could not claim notifications" }, 503);
      }
      const jobs = (Array.isArray(data) ? data : []).slice(0, 3);
      const results = await Promise.all(
        jobs.map((job) => processJob(job, deps)),
      );
      return json({ ok: true, processed: jobs.length, results });
    }
    const token = (req.headers.get("authorization") || "").replace(
      /^Bearer\s+/i,
      "",
    );
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth?.user?.id) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    const { data: account, error: accountError } = await db.from("accounts")
      .select("role").eq("id", auth.user.id).maybeSingle();
    if (accountError || !roles.has(account?.role)) {
      return json({ ok: false, error: "Owner access required" }, 403);
    }
    const { data: pref, error } = await db.from("owner_telegram_preferences")
      .select("chat_id,enabled").eq("user_id", auth.user.id).maybeSingle();
    if (error) {
      return json({ ok: false, error: "Could not read saved settings" }, 503);
    }
    const configured = Boolean(
      env("TELEGRAM_BOT_TOKEN") &&
        env("OWNER_NOTIFICATION_WORKER_SECRET").length >= 32,
    );
    if (body.action === "status") {
      return json({
        ok: true,
        configured,
        enabled: Boolean(pref?.enabled),
        hasChat: Boolean(validChat(pref?.chat_id)),
      });
    }
    if (!configured || !validChat(pref?.chat_id)) {
      return json({
        ok: false,
        error: "Save a valid chat ID and configure Telegram first",
      }, 400);
    }
    const { data: allowed, error: limitError } = await db.rpc(
      "reserve_owner_telegram_test",
      { p_user_id: auth.user.id },
    );
    if (limitError || !allowed) {
      return json(
        { ok: false, error: "Wait 60 seconds before another test" },
        429,
      );
    }
    // Explicitly requested tests use the authenticated owner's saved destination only.
    const result = await sendTelegram({
      chat_id: pref.chat_id,
      text:
        "The Quadrant — Telegram test\nPending and automatic-confirmation alerts are separate messages.",
      reply_markup: {
        inline_keyboard: [[{ text: "Open Admin", url: adminUrl(env) }]],
      },
    }, deps);
    return result.id ? json({ ok: true, status: "sent" }) : json({
      ok: false,
      error: "Delivery was not confirmed. Check Telegram before trying again.",
    }, 502);
  } catch {
    return json({
      ok: false,
      error: "Telegram notifications are temporarily unavailable",
    }, 503);
  }
}
