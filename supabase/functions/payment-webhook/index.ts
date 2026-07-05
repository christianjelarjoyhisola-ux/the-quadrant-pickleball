import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, paymongo-signature, x-payment-signature",
};

type WebhookBody = {
  type?: string;
  event_type?: string;
  session_id?: string;
  booking_ref?: string;
  provider_reference?: string;
  status?: string;
  paid_at?: string;
  raw?: unknown;
  data?: {
    id?: string;
    type?: string;
    data?: {
      id?: string;
      type?: string;
      attributes?: Record<string, unknown>;
    };
    attributes?: {
      type?: string;
      data?: {
        id?: string;
        type?: string;
        attributes?: {
          status?: string;
          paid_at?: string;
          reference_number?: string;
          metadata?: Record<string, unknown>;
        };
      };
    };
  };
};

type SupabaseDb = ReturnType<typeof createClient<any>>;

type OpenPlayRegistrationEmailRow = {
  id: string | number;
  full_name?: string | null;
  email?: string | null;
  court_name?: string | null;
  date?: string | null;
  time_label?: string | null;
  payment_type?: string | null;
  amount?: number | string | null;
};

function normalizeStatus(input?: string) {
  const v = (input || "").toLowerCase();
  if (["paid", "succeeded", "success", "completed"].includes(v)) return "paid";
  if (["failed", "canceled", "cancelled", "expired"].includes(v)) return "failed";
  return "pending";
}

function isoFromPayMongoTimestamp(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return new Date(asNumber * 1000).toISOString();
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

async function verifySignature(req: Request, bodyText: string) {
  const secret = Deno.env.get("PAYMENT_WEBHOOK_SECRET");
  if (!secret) return true;

  const paymongoSig = req.headers.get("paymongo-signature") || req.headers.get("Paymongo-Signature") || "";
  if (paymongoSig) {
    const parts = Object.fromEntries(
      paymongoSig.split(",")
        .map((part) => part.trim().split("="))
        .filter((part) => part.length === 2)
        .map(([key, value]) => [key, value]),
    );
    const timestamp = parts.t || "";
    const candidates = [parts.te, parts.li].filter((value): value is string => !!value);
    if (!timestamp || candidates.length === 0) return false;

    const signedPayload = `${timestamp}.${bodyText}`;
    const expected = await hmacSha256Hex(secret, signedPayload);
    return candidates.some((candidate) => constantTimeEqual(candidate, expected));
  }

  const given = req.headers.get("x-payment-signature") || "";
  if (!given) return false;
  const expected = await hmacSha256Hex(secret, bodyText);
  return constantTimeEqual(given, expected);
}

async function hmacSha256Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i += 1) out |= left[i] ^ right[i];
  return out === 0;
}

function parseWebhook(body: WebhookBody) {
  // Generic payload support
  let sessionId = body.session_id || null;
  let bookingRef = body.booking_ref || null;
  let providerRef = body.provider_reference || null;
  let normalized = normalizeStatus(body.status);
  let paidAtIso = body.paid_at || new Date().toISOString();

  // PayMongo event payload support
  const evType =
    body?.data?.attributes?.type ||
    body?.data?.type ||
    body?.type ||
    "";
  const evData = body?.data?.attributes?.data || body?.data?.data;
  if (evData) {
    providerRef = evData.id || providerRef;
    const attrs = (evData.attributes || {}) as Record<string, unknown>;
    const payments = Array.isArray(attrs.payments) ? attrs.payments : [];
    const latestPayment = payments[0] as { attributes?: Record<string, unknown> } | undefined;
    const paymentAttrs = latestPayment?.attributes || {};
    const evStatus = String(attrs.status || paymentAttrs.status || "");
    const evRef = String(attrs.reference_number || "");
    const evMeta = (attrs.metadata || {}) as Record<string, unknown>;
    const paymentIntent = attrs.payment_intent as { id?: string; attributes?: Record<string, unknown> } | undefined;
    const intentRef =
      typeof attrs.payment_intent_id === "string" ? attrs.payment_intent_id :
      typeof attrs.payment_intent === "string" ? attrs.payment_intent :
      paymentIntent?.id ||
      "";
    const metaRef = typeof evMeta.booking_ref === "string" ? evMeta.booking_ref : "";
    if (!bookingRef) bookingRef = evRef || metaRef || null;
    if (intentRef) providerRef = intentRef;
    if (evStatus) normalized = normalizeStatus(evStatus);
    const paidAt = isoFromPayMongoTimestamp(paymentAttrs.paid_at) ||
      isoFromPayMongoTimestamp(attrs.paid_at) ||
      isoFromPayMongoTimestamp(paymentIntent?.attributes?.paid_at) ||
      isoFromPayMongoTimestamp(attrs.updated_at);
    if (paidAt) paidAtIso = paidAt;
    if (evType.toLowerCase().includes("paid")) normalized = "paid";
    if (evType.toLowerCase().includes("failed") || evType.toLowerCase().includes("expired")) normalized = "failed";
    if (!sessionId) sessionId = evData.id || null;
  }

  return { sessionId, bookingRef, providerRef, normalized, paidAtIso };
}

function openPlayIdFromRef(ref: string | null) {
  const match = String(ref || "").match(/^OP-(\d+)$/i);
  return match ? match[1] : "";
}

async function sendOpenPlayConfirmationEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  registrationId: string,
  bookingRef: string,
  db: SupabaseDb,
) {
  const { data: reg, error } = await db
    .from("open_play_registrations")
    .select("id,full_name,email,court_name,date,time_label,payment_type,amount")
    .eq("id", registrationId)
    .single<OpenPlayRegistrationEmailRow>();
  if (error || !reg?.email) return;

  const payload = {
    type: "open_play",
    bookingRef,
    email: reg.email,
    fullName: reg.full_name || "Open Play Player",
    courtName: reg.court_name || "Open Play Courts",
    date: reg.date,
    startTime: "",
    endTime: "",
    duration: 0,
    total: Number(reg.amount || 0),
    downpayment: Number(reg.amount || 0),
    timeLabel: reg.time_label || "",
    paymentType: reg.payment_type || "Open Play",
    paymentMethod: "qrph",
    idempotencyKey: `open-play-confirmation-${bookingRef}`,
  };

  const res = await fetch(`${supabaseUrl}/functions/v1/send-confirmation-email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Open Play confirmation email failed", res.status, text);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const rawText = await req.text();
    const valid = await verifySignature(req, rawText);
    if (!valid) return new Response("Invalid signature", { status: 401, headers: corsHeaders });

    const body = JSON.parse(rawText) as WebhookBody;
    const { sessionId, bookingRef, providerRef, normalized, paidAtIso } = parseWebhook(body);

    if (!sessionId && !bookingRef) {
      return new Response(JSON.stringify({ error: "Missing session_id or booking_ref" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SERVICE_ROLE_KEY") ||
      "";
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    const db = createClient(supabaseUrl, serviceRoleKey);

    const paymentUpdate: Record<string, unknown> = {
      status: normalized,
      provider_reference: providerRef,
      raw_webhook: body.raw ?? body,
      updated_at: new Date().toISOString(),
    };
    if (normalized === "paid") paymentUpdate.paid_at = paidAtIso;

    let bookingRefToUpdate = bookingRef;
    let localSessionId: string | null = null;

    if (sessionId) {
      // 1) Try local session id
      const { data: localRow } = await db.from("payment_sessions").select("id,booking_ref").eq("id", sessionId).single();
      if (localRow?.id) {
        localSessionId = localRow.id;
        if (!bookingRefToUpdate) bookingRefToUpdate = localRow.booking_ref || null;
      }
      // 2) Try provider reference
      if (!localSessionId) {
        const { data: providerRow } = await db.from("payment_sessions").select("id,booking_ref").eq("provider_reference", sessionId).single();
        if (providerRow?.id) {
          localSessionId = providerRow.id;
          if (!bookingRefToUpdate) bookingRefToUpdate = providerRow.booking_ref || null;
        }
      }
    }

    if (!localSessionId && providerRef) {
      const { data: providerRow2 } = await db.from("payment_sessions").select("id,booking_ref").eq("provider_reference", providerRef).single();
      if (providerRow2?.id) {
        localSessionId = providerRow2.id;
        if (!bookingRefToUpdate) bookingRefToUpdate = providerRow2.booking_ref || null;
      }
    }

    if (localSessionId) {
      await db.from("payment_sessions").update(paymentUpdate).eq("id", localSessionId);
    } else if (bookingRefToUpdate) {
      await db.from("payment_sessions").update(paymentUpdate).eq("booking_ref", bookingRefToUpdate);
    }

    if (bookingRefToUpdate) {
      const openPlayRegistrationId = openPlayIdFromRef(bookingRefToUpdate);
      if (openPlayRegistrationId) {
        await db
          .from("open_play_registrations")
          .update({ payment_status: normalized === "paid" ? "paid" : normalized === "failed" ? "rejected" : "pending" })
          .eq("id", openPlayRegistrationId);
        if (normalized === "paid") {
          await sendOpenPlayConfirmationEmail(
            supabaseUrl,
            serviceRoleKey,
            openPlayRegistrationId,
            bookingRefToUpdate,
            db,
          ).catch((emailErr) => {
            console.error("Open Play confirmation email error", emailErr);
          });
        }
      } else {
        const bookingUpdate: Record<string, unknown> = {
          payment_status: normalized,
        };
        if (normalized === "paid") {
          bookingUpdate.status = "confirmed";
          bookingUpdate.paid_at = paidAtIso;
        }
        if (normalized === "failed") bookingUpdate.status = "cancelled";
        const { data: bookingRow } = await db
          .from("bookings")
          .select("ref,booking_group_ref")
          .eq("ref", bookingRefToUpdate)
          .single();
        if (bookingRow?.booking_group_ref) {
          await db.from("bookings").update(bookingUpdate).eq("booking_group_ref", bookingRow.booking_group_ref);
        } else {
          await db.from("bookings").update(bookingUpdate).eq("ref", bookingRefToUpdate);
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, status: normalized }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
