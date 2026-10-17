// Acknowledge old webhook deliveries without recording chats or contacting Telegram.
Deno.serve(() =>
  new Response(JSON.stringify({ ok: true, retired: true, skipped: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
);
