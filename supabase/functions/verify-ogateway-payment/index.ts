// Checks OGateway payments against OGateway's API.
//  - Customer: { payment_id } for their own payment. The dashboard polls this after checkout,
//    so confirmation doesn't depend on the webhook arriving.
//  - Cron (service role): { mode: "cron" } re-checks every pending OGateway payment.
import { createClient } from "npm:@supabase/supabase-js@2";
import { OgError, ogRequest, settlePayment } from "../_shared/ogateway.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const body = await req.json().catch(() => ({}));

  // Connectivity check (service role): can this server reach OGateway with the configured key?
  if (body?.mode === "ping") {
    if (bearer !== SERVICE) return json({ error: "Forbidden" }, 403);
    const ip = await fetch("https://api.ipify.org?format=json").then((r) => r.json()).catch(() => null);
    try {
      const balance = await ogRequest(admin, "GET", "/balance");
      return json({ ok: true, egress_ip: ip?.ip ?? null, transport: Deno.env.get("OGATEWAY_TRANSPORT") ?? "direct", balance });
    } catch (e) {
      const err = e as OgError;
      return json({ ok: false, egress_ip: ip?.ip ?? null, transport: Deno.env.get("OGATEWAY_TRANSPORT") ?? "direct", status: err.status, message: err.message, body: err.body });
    }
  }

  if (body?.mode === "cron") {
    if (bearer !== SERVICE) return json({ error: "Forbidden" }, 403);
    const { data: rows } = await admin
      .from("payments")
      .select("id")
      .eq("payment_method", "ogateway")
      .eq("status", "pending")
      .not("provider_reference", "is", null)
      .order("created_at", { ascending: true })
      .limit(25);
    const results: Array<{ id: string; state: string }> = [];
    for (const r of rows ?? []) {
      try {
        results.push({ id: r.id, state: (await settlePayment(admin, r.id)).state });
      } catch (e) {
        results.push({ id: r.id, state: `error: ${(e as Error).message}` });
      }
    }
    return json({ checked: results.length, results });
  }

  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data: ud } = await userClient.auth.getUser(bearer);
  if (!ud?.user) return json({ code: "UNAUTHORIZED", message: "Sign in required" }, 401);
  const paymentId = String(body?.payment_id ?? "");
  const { data: own } = await admin.from("payments").select("id,user_id").eq("id", paymentId).maybeSingle();
  if (!own || own.user_id !== ud.user.id) return json({ code: "NOT_FOUND", message: "Payment not found" }, 404);

  try {
    return json(await settlePayment(admin, paymentId));
  } catch (e) {
    return json({ state: "error", message: (e as Error).message }, 502);
  }
});
