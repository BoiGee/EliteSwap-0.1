// OGateway callback. The signature is checked, but the payment is only confirmed after its
// status, currency and amount are read back from OGateway's API (settlePayment), so a forged
// or replayed callback can't unlock anything.
import { createClient } from "npm:@supabase/supabase-js@2";
import { settlePayment, verifyWebhookSignature } from "../_shared/ogateway.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await req.text();
  const signature = req.headers.get("x-ogateway-signature");
  if (!(await verifyWebhookSignature(raw, signature))) {
    console.warn("[ogateway-webhook] bad or missing signature", { hasSignature: !!signature });
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: { id?: string } = {};
  try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  const ogId = payload.id ? String(payload.id) : null;
  if (!ogId) return json({ received: true, ignored: "no id" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: payment } = await admin.from("payments").select("id").eq("provider_reference", ogId).maybeSingle();
  if (!payment) return json({ received: true, ignored: "unknown payment" });

  try {
    const result = await settlePayment(admin, payment.id);
    console.log("[ogateway-webhook]", payment.id, result);
    return json({ received: true, result: result.state });
  } catch (e) {
    console.error("[ogateway-webhook] settle failed", payment.id, (e as Error).message);
    // Non-2xx makes OGateway retry; the 2-minute reconcile also picks it up.
    return json({ error: "Internal server error" }, 500);
  }
});
