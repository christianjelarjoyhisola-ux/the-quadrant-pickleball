import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendTelegram,
  validChat,
  verifyTelegramWebhookSecret,
} from "../_shared/owner-telegram.ts";

// /start reveals only this chat's ID. Booking access is granted exclusively by
// the authenticated owner's saved Admin settings, never by a public setup code.
Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  if (req.method !== "POST") return json({ ok: false }, 405);
  const env = (name: string) => (Deno.env.get(name) || "").trim();
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  const expected = env("TELEGRAM_WEBHOOK_SECRET");
  const authorized = await verifyTelegramWebhookSecret(secret, expected);
  if (!authorized) return json({ ok: false }, 401);
  try {
    const update = await req.json();
    // Ignore edits and channel posts to avoid duplicate replies to the same command.
    const message = update.message, chat = validChat(message?.chat?.id);
    const command = String(message?.text || "").trim().split(/\s+/)[0].split(
      "@",
    )[0].toLowerCase();
    if (!chat || !["/start", "/status", "/stop"].includes(command)) {
      return json({ ok: true });
    }
    if (!env("TELEGRAM_BOT_TOKEN")) return json({ ok: false }, 503);
    let text =
      `The Quadrant\nChat ID: ${chat}\nIn Admin → Telegram Notifications, save this chat ID and select Pending and/or Automatically confirmed alerts. Starting this bot alone does not enable booking alerts.`;
    if (command === "/stop") {
      const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SERVICE_ROLE_KEY");
      if (!key || !env("SUPABASE_URL")) return json({ ok: false }, 503);
      const db = createClient(env("SUPABASE_URL"), key, {
        auth: { persistSession: false },
        global: {
          fetch: (input, options) =>
            fetch(input, { ...options, signal: AbortSignal.timeout(15000) }),
        },
      });
      const { error } = await db.from("owner_telegram_preferences").update({
        enabled: false,
      }).eq("chat_id", chat);
      if (error) return json({ ok: false }, 503);
      text =
        "The Quadrant booking alerts are disabled for this chat. You can enable them again from Admin → Telegram Notifications.";
    }
    // A failed reply must not cause Telegram to retry a possibly delivered message.
    await sendTelegram({ chat_id: chat, text }, { db: null, env });
    return json({ ok: true });
  } catch {
    return json({ ok: false }, 400);
  }
});
