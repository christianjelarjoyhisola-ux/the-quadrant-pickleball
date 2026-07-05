import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SyncPayload = {
  bookingRef?: string;
};

type PaymentSessionRow = {
  id: string;
  booking_ref: string;
  provider_reference: string | null;
  status: string | null;
};

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  payment_status: string | null;
};

function openPlayIdFromRef(ref: string) {
  const match = String(ref || "").match(/^OP-(\d+)$/i);
  return match ? match[1] : "";
}

function extractErrMsg(err: unknown) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

function cleanEnvValue(value: string | null | undefined) {
  return String(value || "").trim().replace(/^['"]+|['"]+$/g, "").trim();
}

function paymongoAuthHeader(secretKey: string) {
  return `Basic ${btoa(`${cleanEnvValue(secretKey)}:`)}`;
}

function normalizeStatus(input?: string) {
  const v = (input || "").toLowerCase();
  if (["paid", "succeeded", "success", "completed"].includes(v)) return "paid";
  if (["failed", "canceled", "cancelled", "expired"].includes(v)) return "failed";
  return "pending";
}

function isoFromPayMongoTimestamp(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return new Date(asNumber * 1000).toISOString();
    }
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

function firstPaymentAttrs(attrs: Record<string, unknown>) {
  const payments = Array.isArray(attrs.payments) ? attrs.payments : [];
  const latest = payments[0] as { attributes?: Record<string, unknown> } | undefined;
  return latest?.attributes || {};
}

function paymentStateFromPayMongo(json: Record<string, unknown>) {
  const data = (json.data || {}) as Record<string, unknown>;
  const attrs = (data.attributes || {}) as Record<string, unknown>;
  const intent = (attrs.payment_intent || {}) as { attributes?: Record<string, unknown> };
  const intentAttrs = intent?.attributes || {};
  const paymentAttrs = firstPaymentAttrs(attrs);

  const intentStatus = String(intentAttrs.status || attrs.status || "");
  const paymentStatus = String(paymentAttrs.status || "");
  const normalized = normalizeStatus(paymentStatus || intentStatus);
  const explicitPaidAt =
    isoFromPayMongoTimestamp(paymentAttrs.paid_at) ||
    isoFromPayMongoTimestamp(attrs.paid_at) ||
    isoFromPayMongoTimestamp(intentAttrs.paid_at) ||
    isoFromPayMongoTimestamp(attrs.updated_at);
  const paidAt = explicitPaidAt || (normalized === "paid" ? new Date().toISOString() : null);

  return { attrs, normalized, paidAt };
}

async function fetchPayMongoCheckout(secretKey: string, sessionId: string) {
  const res = await fetch(`https://api.paymongo.com/v2/checkout_sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: {
      Authorization: paymongoAuthHeader(secretKey),
      "Content-Type": "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayMongo lookup failed ${res.status}: ${extractErrMsg(json)}`);
  return json as Record<string, unknown>;
}

async function fetchPayMongoPaymentIntent(secretKey: string, paymentIntentId: string) {
  const res = await fetch(`https://api.paymongo.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    method: "GET",
    headers: {
      Authorization: paymongoAuthHeader(secretKey),
      "Content-Type": "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayMongo lookup failed ${res.status}: ${extractErrMsg(json)}`);
  return json as Record<string, unknown>;
}

async function fetchPayMongoPaymentState(secretKey: string, providerReference: string) {
  if (providerReference.startsWith("pi_")) {
    return fetchPayMongoPaymentIntent(secretKey, providerReference);
  }
  return fetchPayMongoCheckout(secretKey, providerReference);
}

async function updateBookingPayment(db: any, booking: BookingRow, normalized: string, paidAt: string | null) {
  const bookingUpdate: Record<string, unknown> = {
    payment_status: normalized,
  };
  if (normalized === "paid") {
    bookingUpdate.status = "confirmed";
    if (paidAt) bookingUpdate.paid_at = paidAt;
  }
  if (normalized === "failed") bookingUpdate.status = "cancelled";

  const query = db.from("bookings").update(bookingUpdate);
  if (booking.booking_group_ref) {
    const { error } = await query.eq("booking_group_ref", booking.booking_group_ref).neq("status", "cancelled");
    if (error) throw error;
  } else {
    const { error } = await query.eq("ref", booking.ref);
    if (error) throw error;
  }
}

async function updateOpenPlayPayment(db: any, registrationId: string, normalized: string) {
  const status = normalized === "paid" ? "paid" : normalized === "failed" ? "rejected" : "pending";
  const { error } = await db
    .from("open_play_registrations")
    .update({ payment_status: status })
    .eq("id", registrationId);
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const body = (await req.json()) as SyncPayload;
    const bookingRef = String(body.bookingRef || "").trim();
    if (!bookingRef) {
      return new Response(JSON.stringify({ error: "bookingRef is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SERVICE_ROLE_KEY") ||
      "";
    const secretKey = cleanEnvValue(Deno.env.get("PAYMONGO_SECRET_KEY"));
    if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    if (!secretKey) throw new Error("Missing PAYMONGO_SECRET_KEY");

    const db = createClient(supabaseUrl, serviceRoleKey);
    const openPlayRegistrationId = openPlayIdFromRef(bookingRef);

    let booking: BookingRow | null = null;
    let openPlayStatus = "pending";
    if (openPlayRegistrationId) {
      const { data: reg, error: regErr } = await db
        .from("open_play_registrations")
        .select("id,payment_status")
        .eq("id", openPlayRegistrationId)
        .maybeSingle();
      if (regErr) throw regErr;
      if (!reg) {
        return new Response(JSON.stringify({ error: "Open Play registration not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      openPlayStatus = String(reg.payment_status || "pending");
    } else {
      const { data: bookingData, error: bookingErr } = await db
        .from("bookings")
        .select("ref,booking_group_ref,payment_status")
        .eq("ref", bookingRef)
        .maybeSingle();
      if (bookingErr) throw bookingErr;
      if (!bookingData) {
        return new Response(JSON.stringify({ error: "Booking not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      booking = bookingData as BookingRow;
    }

    const { data: session, error: sessionErr } = await db
      .from("payment_sessions")
      .select("id,booking_ref,provider_reference,status")
      .eq("booking_ref", bookingRef)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sessionErr) throw sessionErr;
    if (!session?.provider_reference) {
      return new Response(JSON.stringify({ ok: true, paid: false, status: openPlayRegistrationId ? openPlayStatus : booking?.payment_status || "pending", reason: "No PayMongo session yet" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const paymongo = await fetchPayMongoPaymentState(secretKey, (session as PaymentSessionRow).provider_reference || "");
    const { normalized, paidAt } = paymentStateFromPayMongo(paymongo);

    const nowIso = new Date().toISOString();
    const paymentUpdate: Record<string, unknown> = {
      status: normalized,
      raw_webhook: paymongo,
      updated_at: nowIso,
    };
    if (normalized === "paid" && paidAt) paymentUpdate.paid_at = paidAt;

    const { error: paymentErr } = await db
      .from("payment_sessions")
      .update(paymentUpdate)
      .eq("id", (session as PaymentSessionRow).id);
    if (paymentErr) throw paymentErr;

    if (normalized === "paid" || normalized === "failed") {
      if (openPlayRegistrationId) await updateOpenPlayPayment(db, openPlayRegistrationId, normalized);
      else await updateBookingPayment(db, booking as BookingRow, normalized, paidAt);
    }

    return new Response(JSON.stringify({
      ok: true,
      paid: normalized === "paid",
      status: normalized,
      bookingRef,
      openPlayRegistrationId: openPlayRegistrationId || null,
      providerReference: (session as PaymentSessionRow).provider_reference,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: extractErrMsg(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
