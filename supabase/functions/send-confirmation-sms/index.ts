const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SMS_ENDPOINT = "https://smsapiph.onrender.com/api/v1/send/sms";
const SMS_LIMIT = 155;

type BookingItem = {
  courtName?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
};

type Payload = {
  bookingRef: string;
  contactNumber?: string;
  phone?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  timeLabel?: string;
  bookingItems?: BookingItem[];
};

function normalizePhNumber(value: unknown): string {
  const raw = String(value ?? "").trim();
  const compact = raw.replace(/[\s\-().]/g, "");
  if (/^\+639\d{9}$/.test(compact)) return compact;
  if (/^09\d{9}$/.test(compact)) return `+63${compact.slice(1)}`;
  if (/^639\d{9}$/.test(compact)) return `+${compact}`;
  return "";
}

function shortDate(value: string): string {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}

function compactTime(value: string): string {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/:00/g, "")
    .toUpperCase();
}

function scheduleText(p: Payload): string {
  const items = Array.isArray(p.bookingItems) && p.bookingItems.length ? p.bookingItems : [];
  const first = items[0] || p;
  const dates = [...new Set(items.map((item) => item.date).filter(Boolean))];
  const date = dates.length === 1 ? dates[0] : first.date;
  const datePart = date ? shortDate(date) : "";
  const timePart = p.timeLabel
    ? p.timeLabel
    : first.startTime && first.endTime
      ? `${compactTime(first.startTime)}-${compactTime(first.endTime)}`
      : "";
  return [datePart, timePart].filter(Boolean).join(" ");
}

function enforceLimit(message: string, limit = SMS_LIMIT): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit).replace(/\s+\S*$/, "").trim();
}

function buildMessage(p: Payload): string {
  const ref = String(p.bookingRef || "").trim();
  const schedule = scheduleText(p);
  const withSchedule = `THE QUADRANT: See you on court! Booking confirmed. Ref: ${ref}. ${schedule}. Show this ref at check-in.`;
  if (enforceLimit(withSchedule) === withSchedule.replace(/\s+/g, " ").trim()) return withSchedule;

  const refOnly = `THE QUADRANT: See you on court! Booking confirmed. Ref: ${ref}. Show this ref at check-in.`;
  return enforceLimit(refOnly);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("SMS_API_PH_API_KEY") || "";
    if (!apiKey) throw new Error("SMS_API_PH_API_KEY is not configured");

    const body = (await req.json()) as Payload;
    const recipient = normalizePhNumber(body.contactNumber || body.phone);
    if (!recipient || !body.bookingRef) {
      return new Response(JSON.stringify({ error: "Missing valid contactNumber or bookingRef" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const message = enforceLimit(buildMessage(body));
    const res = await fetch(SMS_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient, message }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`SMS API PH error ${res.status}: ${JSON.stringify(json)}`);

    return new Response(JSON.stringify({ ok: true, message, length: message.length, response: json }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
