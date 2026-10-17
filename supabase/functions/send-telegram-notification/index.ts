// Retired endpoint: old clients may still call it, but no Telegram messages are sent.
Deno.serve((req) =>
  new Response(
    JSON.stringify({
      ok: true,
      retired: true,
      skipped: true,
      reason: "Owner alerts have moved to private email notifications.",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    },
  )
);
