Deno.serve(() =>
  new Response(
    JSON.stringify({
      ok: false,
      retired: true,
      error: "Owner email alerts have been replaced by Telegram. Reload Admin.",
    }),
    {
      status: 410,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type, x-notification-secret",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    },
  )
);
