import { activeTelegramChatIds, sendTelegramHtml } from "../_shared/telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type BookingPayload = {
  type?: "booking" | "booking_update";
  bookingRef: string;
  fullName: string;
  contactNumber: string;
  courtName: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  total: number;
  downpayment: number;
  playerCount?: number | null;
  playerSummary?: string;
  extraPlayerFee?: number;
  paymentMethod: string;
  paymentStatus?: string;
  bookingStatus?: string;
  event?: string;
  note?: string;
  gcashRef?: string | null;
};

type BookingUpdatePayload = BookingPayload & {
  type: "booking_update";
  event: string;
};

type OpenPlayPayload = {
  type: "open_play";
  fullName: string;
  courtName: string;
  date: string;
  timeLabel: string;
  paymentType: string;
  amount: number;
};

type Payload = BookingPayload | BookingUpdatePayload | OpenPlayPayload;

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtDate(d: string): string {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-PH", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtPHP(n: number): string {
  return "PHP " + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 });
}

function adminUrl(): string {
  return Deno.env.get("APP_ADMIN_URL") || "https://the-quadrant.pages.dev/admin.html";
}

function paymentMethodLabel(method?: string): string {
  const labels: Record<string, string> = {
    gcash: "GCash",
    bdopay: "BDO Pay",
    maya: "Maya",
    gotyme: "GoTyme",
    pnb: "PNB",
    cash: "Cash",
  };
  return labels[String(method || "cash").toLowerCase()] || String(method || "Cash");
}

function eventLabel(event?: string): string {
  const labels: Record<string, string> = {
    new_booking: "New booking",
    booking_confirmed: "Booking confirmed",
    booking_rescheduled: "Booking rescheduled",
    booking_cancelled: "Booking cancelled",
    payment_verified: "Payment verified",
    payment_rejected: "Payment rejected",
    payment_review_needed: "Payment needs review",
    admin_booking_created: "Admin booking created",
  };
  return labels[String(event || "").toLowerCase()] || String(event || "Booking update");
}

function buildBookingMessage(p: BookingPayload): string {
  const method = paymentMethodLabel(p.paymentMethod);
  const paymentRef = p.gcashRef ? `\nPayment ref: <code>${esc(p.gcashRef)}</code>` : "";
  const paidLine = p.downpayment >= p.total
    ? `Full payment: <b>${fmtPHP(p.downpayment)}</b>`
    : `Required payment: <b>${fmtPHP(p.downpayment)}</b>`;
  const playerValue = p.playerSummary ? esc(p.playerSummary) : p.playerCount == null ? "" : String(Number(p.playerCount));
  const playerLine = playerValue
    ? `Players: <b>${playerValue}</b>${Number(p.extraPlayerFee || 0) > 0 ? ` (extra-player fee: <b>${fmtPHP(Number(p.extraPlayerFee))}</b>)` : ""}\n`
    : "";

  return (
    `<b>NEW BOOKING</b>\n` +
    `------------------\n` +
    `<b>${esc(p.fullName)}</b>\n` +
    `${esc(p.contactNumber)}\n\n` +
    `<b>${esc(p.courtName)}</b>\n` +
    `${fmtDate(p.date)}\n` +
    `${esc(p.startTime)} - ${esc(p.endTime)} (${p.duration} hr${p.duration !== 1 ? "s" : ""})\n\n` +
    playerLine +
    `Payment: <b>${esc(method)}</b>${paymentRef}\n` +
    `Total: ${fmtPHP(p.total)}\n` +
    `${paidLine}\n\n` +
    `Booking ref: <code>${esc(p.bookingRef)}</code>\n` +
    `------------------\n` +
    `<a href="${adminUrl()}">Open admin panel to verify and confirm.</a>`
  );
}

function buildBookingUpdateMessage(p: BookingUpdatePayload): string {
  const method = paymentMethodLabel(p.paymentMethod);
  const paymentRef = p.gcashRef ? `\nPayment ref: <code>${esc(p.gcashRef)}</code>` : "";
  const paymentState = p.paymentStatus ? `\nPayment status: <b>${esc(p.paymentStatus)}</b>` : "";
  const bookingState = p.bookingStatus ? `\nBooking status: <b>${esc(p.bookingStatus)}</b>` : "";
  const noteLine = p.note ? `\nNote: ${esc(p.note)}\n` : "\n";
  const playerValue = p.playerSummary ? esc(p.playerSummary) : p.playerCount == null ? "" : String(Number(p.playerCount));
  const playerLine = playerValue
    ? `Players: <b>${playerValue}</b>${Number(p.extraPlayerFee || 0) > 0 ? ` (extra-player fee: <b>${fmtPHP(Number(p.extraPlayerFee))}</b>)` : ""}\n`
    : "";

  return (
    `<b>${esc(eventLabel(p.event).toUpperCase())}</b>\n` +
    `------------------\n` +
    `Booking ref: <code>${esc(p.bookingRef)}</code>\n` +
    `<b>${esc(p.fullName)}</b>\n` +
    `${esc(p.contactNumber)}\n\n` +
    `<b>${esc(p.courtName)}</b>\n` +
    `${fmtDate(p.date)}\n` +
    `${esc(p.startTime)} - ${esc(p.endTime)} (${p.duration} hr${p.duration !== 1 ? "s" : ""})\n\n` +
    playerLine +
    `Payment: <b>${esc(method)}</b>${paymentRef}\n` +
    `Total: ${fmtPHP(p.total)}\n` +
    `Paid / required: <b>${fmtPHP(p.downpayment)}</b>` +
    paymentState +
    bookingState +
    noteLine +
    `------------------\n` +
    `<a href="${adminUrl()}">Open admin panel.</a>`
  );
}

function buildOpenPlayMessage(p: OpenPlayPayload): string {
  return (
    `<b>OPEN PLAY SIGN-UP</b>\n` +
    `------------------\n` +
    `<b>${esc(p.fullName)}</b>\n\n` +
    `<b>${esc(p.courtName)}</b>\n` +
    `${fmtDate(p.date)}\n` +
    `${esc(p.timeLabel)}\n\n` +
    `Payment: <b>${esc(p.paymentType)}</b> - ${fmtPHP(p.amount)}\n` +
    `------------------\n` +
    `<a href="${adminUrl()}">View Open Play registrations.</a>`
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

    if (!botToken) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "Telegram not configured" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as Payload;

    let message: string;
    if (body.type === "open_play") {
      if (!body.fullName) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      message = buildOpenPlayMessage(body);
    } else if (body.type === "booking_update") {
      const b = body as BookingUpdatePayload;
      if (!b.bookingRef || !b.fullName || !b.event) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      message = buildBookingUpdateMessage(b);
    } else {
      const b = body as BookingPayload;
      if (!b.bookingRef || !b.fullName) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      message = buildBookingMessage(b);
    }

    const chatIds = await activeTelegramChatIds();
    if (chatIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "No active Telegram chats" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const results = await sendTelegramHtml(message);
    const failed = results.filter((result) => !result.ok);

    return new Response(JSON.stringify({ ok: true, sent: chatIds.length, failed: failed.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
