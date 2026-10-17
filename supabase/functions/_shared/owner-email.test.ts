import {
  buildOwnerEmail,
  constantTimeSecret,
  handleOwnerEmail,
  retryUpdate,
  savedRecipients,
  sendFrozenEmail,
  usableSavedRows,
} from "./owner-email.ts";

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
    RESEND_API_KEY: "offline-mock-key",
    EMAIL_FROM: "The Quadrant <alerts@example.test>",
    OWNER_NOTIFICATION_WORKER_SECRET: SECRET,
    APP_ADMIN_URL: "https://thequadrant.club/admin.html",
  })[name as "RESEND_API_KEY"] || "";
const preference = {
  user_id: "owner-a",
  emails: ["primary@example.test", "backup@example.test"],
  enabled: true,
  notify_new: true,
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
  idempotency_key: "owner-email/stable-key",
  first_attempt_at: null,
  payload: null,
};
type AnyRow = Record<string, any>;

function fixture() {
  const tables: Record<string, AnyRow[]> = {
    accounts: [{ id: "owner-a", role: "court_owner" }],
    owner_email_preferences: [structuredClone(preference)],
    bookings: [structuredClone(booking), {
      ...booking,
      ref: "BOOK-2",
      court_id: "c2",
      court_name: "Court 2",
    }],
    open_play_registrations: [],
    owner_email_notifications: [structuredClone(queue)],
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
      if (name === "reserve_owner_email_test") {
        assert.equal(args.p_user_id, "owner-a");
        return { data: testAllowed, error: null };
      }
      assert.equal(name, "claim_owner_email_notifications");
      assert.equal(args.p_limit, 3);
      const jobs = tables.owner_email_notifications.filter((row) =>
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
            tables.owner_email_notifications[0].lease_token = "another-worker";
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
          ? { id: "provider-id" }
          : { message: "private-provider-error", name: "error" },
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
  handleOwnerEmail(
    request({ action: "process" }, { "x-notification-secret": SECRET }),
    f.deps,
  );

Deno.test("secret comparison and recipient validation reject missing/short/untrusted values", async () => {
  assert(await constantTimeSecret(SECRET, SECRET));
  assert(!await constantTimeSecret("wrong", SECRET));
  assert(!await constantTimeSecret("", ""));
  assert(!await constantTimeSecret("short", "short"));
  assert.deepEqual(
    savedRecipients({ emails: ["bad\r\nBcc: victim@example.test"] }),
    [],
  );
  assert.deepEqual(
    savedRecipients({
      emails: ["a@b.test", "b@b.test", "c@b.test", "d@b.test"],
    }),
    [],
  );
});

Deno.test("unauthenticated process/test and staff cannot access private delivery", async () => {
  const f = fixture();
  assert.equal(
    (await handleOwnerEmail(request({ action: "process" }), f.deps)).status,
    401,
  );
  assert.equal(f.journal.length, 0);
  assert.equal(
    (await handleOwnerEmail(request({ action: "test" }), f.deps)).status,
    401,
  );
  f.tables.accounts[0].role = "staff";
  assert.equal(
    (await handleOwnerEmail(
      request({ action: "test" }, { authorization: "Bearer good-token" }),
      f.deps,
    )).status,
    403,
  );
  assert.equal(f.sends.length, 0);
});

Deno.test("test uses saved addresses only, hides backups, and respects atomic rate limit", async () => {
  const f = fixture();
  const response = await handleOwnerEmail(
    request({
      action: "test",
      emails: ["injected@example.test"],
      html: "injected",
    }, { authorization: "Bearer good-token" }),
    f.deps,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "sent");
  const sent = JSON.parse(f.sends[0].body);
  assert.deepEqual(sent.to, ["primary@example.test"]);
  assert.deepEqual(sent.bcc, ["backup@example.test"]);
  assert(!f.sends[0].body.includes("injected"));
  f.setTestAllowed(false);
  assert.equal(
    (await handleOwnerEmail(
      request({ action: "test" }, { authorization: "Bearer good-token" }),
      f.deps,
    )).status,
    429,
  );
  assert.equal(f.sends.length, 1);
});

Deno.test("worker claims and processes at most three jobs per invocation", async () => {
  const f = fixture();
  f.tables.owner_email_notifications = Array.from(
    { length: 7 },
    (_, index) => ({
      ...queue,
      id: `job-${index}`,
      entity_key: `GROUP-${index}`,
      idempotency_key: `owner-email/batch-${index}`,
    }),
  );
  f.tables.bookings = Array.from({ length: 7 }, (_, index) => ({
    ...booking,
    ref: `BOOK-${index}`,
    booking_group_ref: `GROUP-${index}`,
  }));
  const response = await process(f);
  assert.equal((await response.json()).processed, 3);
  assert.equal(f.sends.length, 3);
  assert.equal(
    f.tables.owner_email_notifications.filter((row) => row.status === "sent")
      .length,
    3,
  );
  assert.equal(
    f.tables.owner_email_notifications.filter((row) =>
      row.status === "queued" && row.attempts === 0
    ).length,
    4,
  );
});

Deno.test("grouped booking sends one escaped email only after durable payload freeze", async () => {
  const f = fixture();
  const response = await process(f);
  assert.equal(response.status, 200);
  assert.equal(f.sends.length, 1);
  assert(f.journal.indexOf("freeze") < f.journal.indexOf("send"));
  const sent = JSON.parse(f.sends[0].body);
  assert(sent.html.includes("Court 1") && sent.html.includes("Court 2"));
  assert(sent.html.includes("&lt;script&gt;"));
  assert(!sent.html.includes("<script>"));
  assert(sent.text.includes("Asia/Manila"));
  assert.equal(f.tables.owner_email_notifications[0].status, "sent");
  assert.equal(
    f.tables.owner_email_notifications[0].provider_id,
    "provider-id",
  );
  await process(f);
  assert.equal(f.sends.length, 1);
});

Deno.test("retry reuses exact frozen body/key and stores only sanitized provider status", async () => {
  const f = fixture();
  f.setProviderStatus(503);
  await process(f);
  const job = f.tables.owner_email_notifications[0];
  assert.equal(job.status, "queued");
  assert.equal(job.last_error, "provider_http_503");
  const first = f.sends[0];
  f.tables.bookings[0].full_name = "Changed after first send";
  f.setNow(NOW + 60000);
  f.setProviderStatus(200);
  await process(f);
  assert.deepEqual(f.sends[1], first);
  assert.equal(job.status, "sent");
});

Deno.test("a worker that loses its lease before freeze cannot send or overwrite the new lease", async () => {
  const f = fixture();
  f.loseLeaseOnFreeze();
  await process(f);
  assert.equal(f.sends.length, 0);
  assert.equal(
    f.tables.owner_email_notifications[0].lease_token,
    "another-worker",
  );
  assert.equal(f.tables.owner_email_notifications[0].payload, null);
});

Deno.test("retry skips changed recipients without rewriting the frozen payload or key", async () => {
  const f = fixture();
  f.setProviderStatus(503);
  await process(f);
  const job = f.tables.owner_email_notifications[0];
  const payload = JSON.stringify(job.payload), key = job.idempotency_key;
  f.tables.owner_email_preferences[0].emails = ["primary@example.test"];
  f.setNow(NOW + 60000);
  await process(f);
  assert.equal(f.sends.length, 1);
  assert.equal(job.status, "skipped");
  assert.equal(job.last_error, "recipients_changed");
  assert.equal(JSON.stringify(job.payload), payload);
  assert.equal(job.idempotency_key, key);
});

Deno.test("freeze failure never sends; disabled preferences and stale pending are skipped", async () => {
  const f = fixture();
  f.setFreezeFailure(true);
  await process(f);
  assert.equal(f.sends.length, 0);
  for (
    const change of [
      (f: ReturnType<typeof fixture>) => {
        f.tables.owner_email_preferences[0].enabled = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.tables.bookings.forEach((row) => row.status = "confirmed");
      },
      (f: ReturnType<typeof fixture>) => {
        f.tables.bookings.forEach((row) => row.email = "reserve@hold.internal");
      },
      (f: ReturnType<typeof fixture>) => {
        f.tables.bookings.forEach((row) => row.date = "2000-01-01");
      },
    ]
  ) {
    const current = fixture();
    change(current);
    await process(current);
    assert.equal(current.sends.length, 0);
    assert.equal(current.tables.owner_email_notifications[0].status, "skipped");
  }
});

Deno.test("only new and pending alerts exist; paid new bookings are allowed, cancellations skipped", () => {
  assert.equal(
    usableSavedRows([{ ...booking, status: "cancelled" }], {
      ...queue,
      event: "new_booking",
    }, NOW).length,
    0,
  );
  assert.equal(
    usableSavedRows([{ ...booking, payment_status: "paid" }], {
      ...queue,
      event: "pending",
    }, NOW).length,
    0,
  );
  assert.equal(
    usableSavedRows([{ ...booking, payment_status: "paid" }], {
      ...queue,
      entity_type: "open_play",
      event: "new_booking",
    }, NOW).length,
    1,
  );
  assert.equal(
    usableSavedRows(
      [{ ...booking, created_at: "2000-01-01T00:00:00Z" }],
      queue,
      NOW,
    ).length,
    1,
  );
  for (const event of ["confirmed", "cancelled"]) {
    assert.equal(
      usableSavedRows([booking], { ...queue, event }, NOW).length,
      0,
    );
  }
  const body = buildOwnerEmail({ ...queue, event: "new_booking" }, [booking], [
    "saved@example.test",
  ], env);
  assert.equal(body.subject, "[The Quadrant] New booking");
});

Deno.test("retry ceiling and provider idempotency window are enforced", () => {
  assert.equal(
    retryUpdate(
      { attempts: 5, first_attempt_at: new Date(NOW).toISOString() },
      "failure",
      NOW,
    ).status,
    "failed",
  );
  assert.equal(
    retryUpdate(
      {
        attempts: 1,
        first_attempt_at: new Date(NOW - 23 * 3600000 + 1000).toISOString(),
      },
      "failure",
      NOW,
    ).status,
    "failed",
  );
  assert.equal(
    retryUpdate(
      { attempts: 1, first_attempt_at: new Date(NOW).toISOString() },
      "failure",
      NOW,
      false,
    ).status,
    "failed",
  );
});

Deno.test("provider errors never expose response bodies and carry an abort signal", async () => {
  const result = await sendFrozenEmail("{}", "stable", {
    db: null,
    env,
    fetcher: async (_url, options) => {
      assert(options?.signal);
      throw new Error("private-secret");
    },
  });
  assert.deepEqual(result, { code: "provider_network_error", retryable: true });
});

Deno.test("provider timeout aborts a stalled send", async () => {
  let aborted = false;
  const result = await sendFrozenEmail("{}", "stable", {
    db: null,
    env,
    fetcher: (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
  }, 1);
  assert(aborted);
  assert.deepEqual(result, { code: "provider_timeout", retryable: true });
});
