import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type TelegramSendResult = {
  chatId: string;
  ok: boolean;
  error?: string;
};

export function telegramServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SERVICE_ROLE_KEY") ||
    "";
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function activeTelegramChatIds(): Promise<string[]> {
  const ids = new Set<string>();
  const db = telegramServiceClient();

  if (db) {
    const { data, error } = await db
      .from("telegram_chat_subscriptions")
      .select("chat_id")
      .eq("is_active", true);
    if (error) console.error("Could not load Telegram chat subscriptions:", error.message);
    for (const row of data || []) {
      const id = String(row.chat_id || "").trim();
      if (id) ids.add(id);
    }
  }

  // Keep manually configured recipients working during migration.
  const legacyIds = (Deno.env.get("TELEGRAM_CHAT_ID") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of legacyIds) ids.add(id);

  return [...ids];
}

export async function sendTelegramHtml(
  message: string,
  options: { disableWebPagePreview?: boolean } = {},
): Promise<TelegramSendResult[]> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  if (!botToken) return [];
  const chatIds = await activeTelegramChatIds();

  return await Promise.all(chatIds.map(async (chatId) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: options.disableWebPagePreview ?? true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
      return { chatId, ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Telegram send failed for chat ${chatId}:`, msg);
      return { chatId, ok: false, error: msg };
    }
  }));
}

