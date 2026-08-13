import { telegramServiceClient } from "../_shared/telegram.ts";

type TelegramChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  text?: string;
  chat?: TelegramChat;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function reply(botToken: string, chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    console.error("Telegram webhook reply failed:", response.status, await response.text());
  }
}

function commandText(text = ""): { command: string; argument: string } {
  const trimmed = text.trim();
  const [rawCommand = "", ...rest] = trimmed.split(/\s+/);
  return {
    command: rawCommand.toLowerCase().replace(/@[^\s]+$/, ""),
    argument: rest.join(" ").trim(),
  };
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const suppliedSecret = (req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "").trim();
  const suppliedSecretHash = suppliedSecret ? await sha256(suppliedSecret) : "";
  if (!suppliedSecret || suppliedSecretHash !== "112b4b58f013ad1472958733b614900386aecefabc3dfd97c8fdefc14fe50648") {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const registrationCodeHash = "b03b5781ae8ac03035e80c5cd53a062296493fb61048ad1f244e0a6e2dccd941";
  const db = telegramServiceClient();
  if (!botToken || !db) return json({ ok: false, error: "Telegram server configuration incomplete" }, 500);

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
  const chat = message?.chat;
  if (!chat?.id) return json({ ok: true, ignored: true });

  const chatId = String(chat.id);
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await db
    .from("telegram_chat_subscriptions")
    .select("is_active, registered_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (existingError) {
    console.error("Telegram chat lookup failed:", existingError.message);
    return json({ ok: false, error: "Could not record chat" }, 500);
  }

  const { command, argument } = commandText(message?.text);
  let active = Boolean(existing?.is_active);
  let registeredAt = existing?.registered_at || null;
  let responseText = "Chat detected and recorded. Send /status to check notification access.";

  if (command === "/stop") {
    active = false;
    responseText = "Notifications are now disabled for this chat. The chat record has been retained for auditing.";
  } else if (command === "/start") {
    if (argument && await sha256(argument) === registrationCodeHash) {
      active = true;
      registeredAt = registeredAt || now;
      responseText = "Setup complete. This chat will now receive The Quadrant booking notifications.";
    } else if (active) {
      responseText = "This chat is already registered for The Quadrant booking notifications.";
    } else {
      responseText = `Chat ID ${chatId} was recorded, but alerts are not active. Ask the owner for the private setup link or code.`;
    }
  } else if (command === "/status") {
    responseText = active
      ? `Chat ID ${chatId} is active and will receive booking notifications.`
      : `Chat ID ${chatId} is recorded but pending. Use /start YOUR_SETUP_CODE to activate it.`;
  }

  const { error: upsertError } = await db.from("telegram_chat_subscriptions").upsert({
    chat_id: chatId,
    chat_type: chat.type || "private",
    title: chat.title || null,
    username: chat.username || null,
    first_name: chat.first_name || null,
    last_name: chat.last_name || null,
    is_active: active,
    registered_at: registeredAt,
    last_seen_at: now,
    updated_at: now,
  }, { onConflict: "chat_id" });

  if (upsertError) {
    console.error("Telegram chat upsert failed:", upsertError.message);
    return json({ ok: false, error: "Could not record chat" }, 500);
  }

  await reply(botToken, chatId, responseText);
  return json({ ok: true, chatRecorded: true, active });
});
