import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleOwnerEmail, ownerEmailCors } from "../_shared/owner-email.ts";

Deno.serve(async (req) => {
  const env = (name: string) => (Deno.env.get(name) || "").trim();
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SERVICE_ROLE_KEY");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: ownerEmailCors });
  }
  if (!url || !key) {
    return new Response(
      JSON.stringify({ ok: false, error: "Server configuration incomplete" }),
      {
        status: 503,
        headers: { ...ownerEmailCors, "Content-Type": "application/json" },
      },
    );
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, options = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(input, {
            ...options,
            signal: controller.signal,
          });
          // Consume under the deadline so a stalled body cannot hold a queue lease indefinitely.
          const bytes = await response.arrayBuffer();
          return new Response(
            [204, 205, 304].includes(response.status) ? null : bytes,
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
        } finally {
          clearTimeout(timer);
        }
      },
    },
  });
  return handleOwnerEmail(req, { db, env });
});
