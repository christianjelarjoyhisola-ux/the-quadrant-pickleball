import {
  buildTelegram,
  handleOwnerTelegram,
  matchingRows,
  notificationState,
  sendTelegram,
  validChat,
} from "./owner-telegram.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
namespace assert {
  export function equal(actual: unknown, expected: unknown) {
    assert(
      Object.is(actual, expected),
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
  export function deepEqual(actual: unknown, expected: unknown) {
    equal(JSON.stringify(actual), JSON.stringify(expected));
  }
}

const NOW = Date.parse("2026-10-17T06:00:00Z");
const SECRET = "offline-only-worker-secret-at-least-32-characters";
const env = (name: string) =>
  ({
    TELEGRAM_BOT_TOKEN: "offline-mock-key",
    EMAIL_FROM: "The Quadrant <alerts@example.test>",
    OWNER_NOTIFICATION_WORKER_SECRET: SECRET,
    APP_ADMIN_URL: "https://thequadrant.club/admin.html",
  })[name as "TELEGRAM_BOT_TOKEN"] || "";
const preference = {
  user_id: "owner-a",
  chat_id: "123456789",
  enabled: true,
  notify_auto_confirmed: true,
  notify_pending: true,
};
const booking = {
  ref: "BOOK-1",
  booking_group_ref: "GROUP-1",
  full_name: "Customer <script>",
  email: "customer@example.test",
  court_id: "c1",
  court_name: "Court 1",
  date: "2026-10-18",
  start_time: "5:00 PM",
  end_time: "6:00 PM",
  status: "pending",
  payment_status: "unpaid",
  created_at: new Date(NOW - 60000).toISOString(),
};
const queue = {
  id: "job-a",
  user_id: "owner-a",
  entity_type: "booking",
  entity_key: "GROUP-1",
  event: "pending",
  status: "queued",
  attempts: 0,
  idempotency_key: "owner-telegram/stable-key",
  first_attempt_at: null,
  payload: null,
};
type AnyRow = Record<string, any>;

function fixture() {
  const tables: Record<string, AnyRow[]> = {
    accounts: [{ id: "owner-a", role: "court_owner" }],
    owner_telegram_preferences: [structuredClone(preference)],
    bookings: [structuredClone(booking), {
      ...booking,
      ref: "BOOK-2",
      court_id: "c2",
      court_name: "Court 2",
    }],
    open_play_registrations: [],
    owner_telegram_notifications: [structuredClone(queue)],
  };
  const journal: string[] = [], sends: { body: string; key: string }[] = [];
  let now = NOW,
    testAllowed = true,
    freezeFailure = false,
    loseLease = false,
    providerStatus = 200;
  const db = {
    auth: {
      getUser: async (token: string) => ({
        data: token === "good-token" ? { user: { id: "owner-a" } } : null,
        error: null,
      }),
    },
    rpc: async (name: string, args: AnyRow) => {
      journal.push(`rpc:${name}`);
      if (name === "reserve_owner_telegram_test") {
        assert.equal(args.p_user_id, "owner-a");
        return { data: testAllowed, error: null };
      }
      assert.equal(name, "claim_owner_telegram_notifications");
      assert.equal(args.p_limit, 3);
      const jobs = tables.owner_telegram_notifications.filter((row) =>
        row.status === "queued"
      ).slice(0, args.p_limit).map((row) => {
        Object.assign(row, {
          status: "sending",
          attempts: row.attempts + 1,
          lease_token: `lease-${row.attempts + 1}`,
          first_attempt_at: row.first_attempt_at || new Date(now).toISOString(),
        });
        return structuredClone(row);
      });
      return { data: jobs, error: null };
    },
    from(table: string) {
      const filters: [string, unknown][] = [];
      let update: AnyRow | null = null, single = false;
      const builder: any = {
        select() {
          return builder;
        },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return builder;
        },
        order() {
          return builder;
        },
        update(values: AnyRow) {
          update = values;
          return builder;
        },
        maybeSingle() {
          single = true;
          return builder;
        },
        then(resolve: any, reject: any) {
          if (update?.payload && loseLease) {
            tables.owner_telegram_notifications[0].lease_token =
              "another-worker";
          }
          const matched = (tables[table] || []).filter((row) =>
            filters.every(([key, value]) => String(row[key]) === String(value))
          );
          if (update) {
            assert(filters.some(([key]) => key === "id"));
            assert(filters.some(([key]) => key === "lease_token"));
            assert(
              filters.some(([key, value]) =>
                key === "status" && value === "sending"
              ),
            );
            if (update.payload && freezeFailure) {
              return Promise.resolve({
                data: null,
                error: { message: "private-database-message" },
              }).then(resolve, reject);
            }
            if (update.payload) journal.push("freeze");
            matched.forEach((row) =>
              Object.assign(row, structuredClone(update))
            );
          }
          return Promise.resolve({
            data: single
              ? structuredClone(matched[0] || null)
              : structuredClone(matched),
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const fetcher: typeof fetch = async (_url, options) => {
    journal.push("send");
    sends.push({
      body: String(options?.body),
      key: new Headers(options?.headers).get("Idempotency-Key")!,
    });
    return new Response(
      JSON.stringify(
        providerStatus === 200
          ? { ok: true, result: { message_id: 42 } }
          : { ok: false, description: "private-provider-error" },
      ),
      { status: providerStatus },
    );
  };
  return {
    tables,
    journal,
    sends,
    deps: { db, env, fetcher, now: () => now },
    setNow(value: number) {
      now = value;
    },
    setTestAllowed(value: boolean) {
      testAllowed = value;
    },
    setFreezeFailure(value: boolean) {
      freezeFailure = value;
    },
    setProviderStatus(value: number) {
      providerStatus = value;
    },
    loseLeaseOnFreeze() {
      loseLease = true;
    },
  };
}

const request = (body: AnyRow, headers: Record<string, string> = {}) =>
  new Request("https://offline.test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const process = (f: ReturnType<typeof fixture>) =>
  handleOwnerTelegram(
    request({ action: "process" }, { "x-notification-secret": SECRET }),
    f.deps,
  );
Deno.test("Telegram classifies saved pending, processing, manual, and automatic states separately", () => {
  assert.equal(notificationState(booking, "booking"), "pending");
  assert.equal(
    notificationState({ ...booking, status: "verifying" }, "booking"),
    "ignore",
  );
  assert.equal(
    notificationState({ ...booking, receipt_status: "processing" }, "booking"),
    "ignore",
  );
  assert.equal(
    notificationState({
      ...booking,
      status: "confirmed",
      payment_status: "paid",
    }, "booking"),
    "ignore",
  );
  assert.equal(
    notificationState({
      ...booking,
      status: "confirmed",
      payment_status: "paid",
      receipt_status: "auto_approved",
    }, "booking"),
    "auto_confirmed",
  );
  assert.equal(
    notificationState({
      ...booking,
      status: "confirmed",
      payment_status: "downpayment_paid",
      automatic_confirmation_source: "paymongo",
    }, "booking"),
    "auto_confirmed",
  );
  assert.equal(
    matchingRows(
      [{
        ...booking,
        status: "confirmed",
        payment_status: "paid",
        receipt_status: "auto_approved",
      }],
      queue,
      NOW,
    ).length,
    0,
  );
  assert.equal(
    matchingRows([{ ...booking, full_name: "Reserving slot" }], queue, NOW)
      .length,
    0,
  );
  assert.equal(
    matchingRows([{ ...booking, date: "2026-10-16" }], queue, NOW).length,
    0,
  );
});
Deno.test("Telegram messages have distinct headings, booking details, safe plain text and bounded groups", () => {
  const pending = buildTelegram(queue, [booking], "123456789", env);
  const confirmed = buildTelegram(
    { ...queue, event: "auto_confirmed" },
    [booking],
    "123456789",
    env,
  );
  assert(pending.text.startsWith("🟠 Pending booking"));
  assert(confirmed.text.startsWith("🟢 Automatically confirmed"));
  assert(
    pending.text.includes("GROUP-1") && pending.text.includes("Court 1") &&
      pending.text.includes("Customer <script>"),
  );
  assert.equal(pending.parse_mode, undefined);
  assert.equal(
    pending.reply_markup.inline_keyboard[0][0].url,
    "https://thequadrant.club/admin.html",
  );
  assert(
    buildTelegram(
      queue,
      Array(50).fill({ ...booking, full_name: "x".repeat(1000) }),
      "123456789",
      env,
    ).text.length < 4096,
  );
  assert.equal(validChat("-100123456"), "-100123456");
  assert.equal(validChat("@stranger"), "");
});
Deno.test("Worker authentication blocks public clients and ignores supplied destinations", async () => {
  const f = fixture();
  assert.equal(
    (await handleOwnerTelegram(request({ action: "process" }), f.deps)).status,
    401,
  );
  assert.equal(f.sends.length, 0);
  await process(f);
  assert.equal(f.sends.length, 1);
  assert.equal(JSON.parse(f.sends[0].body).chat_id, "123456789");
  assert.equal(f.tables.owner_telegram_notifications[0].status, "sent");
  assert.deepEqual(f.journal.filter((x) => ["freeze", "send"].includes(x)), [
    "freeze",
    "send",
  ]);
  await process(f);
  assert.equal(f.sends.length, 1);
});
Deno.test("Later automatic confirmation sends separately; stale pending messages are skipped", async () => {
  const f = fixture();
  await process(f);
  f.tables.bookings.forEach((r) =>
    Object.assign(r, {
      status: "confirmed",
      payment_status: "paid",
      receipt_status: "auto_approved",
    })
  );
  f.tables.owner_telegram_notifications.push({
    ...structuredClone(queue),
    id: "auto-job",
    event: "auto_confirmed",
  });
  await process(f);
  assert.equal(f.sends.length, 2);
  assert(JSON.parse(f.sends[1].body).text.startsWith("🟢"));
  const stale = fixture();
  stale.tables.bookings.forEach((r) =>
    Object.assign(r, { status: "confirmed", payment_status: "paid" })
  );
  await process(stale);
  assert.equal(stale.sends.length, 0);
  assert.equal(stale.tables.owner_telegram_notifications[0].status, "skipped");
});
Deno.test("Separate preference switches and role demotion prevent sends", async () => {
  for (const kind of ["disabled", "pending-off", "demoted"]) {
    const f = fixture();
    if (kind === "disabled") {
      f.tables.owner_telegram_preferences[0].enabled = false;
    }
    if (kind === "pending-off") {
      f.tables.owner_telegram_preferences[0].notify_pending = false;
    }
    if (kind === "demoted") f.tables.accounts[0].role = "staff";
    await process(f);
    assert.equal(f.sends.length, 0);
  }
});
Deno.test("Freeze failure and lost leases never send", async () => {
  const f = fixture();
  f.setFreezeFailure(true);
  await process(f);
  assert.equal(f.sends.length, 0);
  const lost = fixture();
  lost.loseLeaseOnFreeze();
  await process(lost);
  assert.equal(lost.sends.length, 0);
});
Deno.test("Uncertain provider outcomes and interrupted dispatches are not resent", async () => {
  const f = fixture();
  f.setProviderStatus(500);
  await process(f);
  assert.equal(f.tables.owner_telegram_notifications[0].status, "failed");
  await process(f);
  assert.equal(f.sends.length, 1);
  const interrupted = fixture();
  interrupted.tables.owner_telegram_notifications[0].payload = {
    dispatch: "started",
  };
  await process(interrupted);
  assert.equal(interrupted.sends.length, 0);
  assert.equal(
    interrupted.tables.owner_telegram_notifications[0].status,
    "failed",
  );
  const timeout = await sendTelegram({}, {
    ...f.deps,
    fetcher: async () => {
      throw new Error("private token");
    },
  }, 1);
  assert.equal(timeout.retryable, false);
  assert.equal(timeout.code, "telegram_delivery_unknown");
});
Deno.test("Definite rate limit rejection may retry with rechecked booking state", async () => {
  const f = fixture();
  f.setProviderStatus(429);
  await process(f);
  assert.equal(f.tables.owner_telegram_notifications[0].status, "queued");
  assert.equal(
    f.tables.owner_telegram_notifications[0].payload.dispatch,
    "rejected",
  );
  f.setProviderStatus(200);
  await process(f);
  assert.equal(f.sends.length, 2);
  assert.equal(f.tables.owner_telegram_notifications[0].status, "sent");
});
Deno.test("Tests require owner authentication and rate limit, using only saved chat", async () => {
  const f = fixture();
  const req = () =>
    request({ action: "test", chat_id: "999" }, {
      authorization: "Bearer good-token",
    });
  assert.equal(
    (await handleOwnerTelegram(request({ action: "test" }), f.deps)).status,
    401,
  );
  assert.equal((await handleOwnerTelegram(req(), f.deps)).status, 200);
  assert.equal(JSON.parse(f.sends[0].body).chat_id, "123456789");
  f.setTestAllowed(false);
  assert.equal((await handleOwnerTelegram(req(), f.deps)).status, 429);
  assert.equal(f.sends.length, 1);
});
