// Opens an OGateway checkout (Mobile Money or card, in GHS) for a plan.
// The payment row is created with the customer's own session so the existing triggers price
// the plan, check the discount code and snapshot partner commission, as for crypto.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createCheckout, OgError, usdToGhsRate } from "../_shared/ogateway.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ code: "UNAUTHORIZED", message: "Sign in required" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const body = await req.json().catch(() => ({}));
  const planId = String(body?.plan_id ?? "");
  const discountCode = body?.discount_code ? String(body.discount_code).slice(0, 64) : null;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) return json({ code: "BAD_REQUEST", message: "Choose a plan to pay for" }, 400);

  const { data: payment, error: createErr } = await userClient.rpc("create_gateway_payment", {
    p_plan_id: planId,
    p_discount_code: discountCode,
  });
  if (createErr || !payment) {
    return json({ code: "CANNOT_CREATE", message: createErr?.message ?? "Couldn't start the payment" }, 400);
  }

  try {
    const rate = await usdToGhsRate();
    // Rounded up to the next 10 pesewas so the customer never pays less than the plan price.
    const amountGhs = Math.ceil(Number(payment.amount_usd) * rate * 10) / 10;
    const callbackURL = `${SUPABASE_URL}/functions/v1/ogateway-webhook`;
    const checkout = await createCheckout(admin, amountGhs, callbackURL);
    if (!checkout?.id || !checkout?.checkout_url) throw new OgError("OGateway didn't return a checkout link", 502, checkout);

    const { error: upErr } = await admin
      .from("payments")
      .update({ provider_reference: checkout.id, tx_hash: checkout.id, amount_local: amountGhs, fx_rate: rate })
      .eq("id", payment.id);
    if (upErr) throw new OgError(`Couldn't save the checkout: ${upErr.message}`, 500, null);

    return json({
      payment_id: payment.id,
      checkout_url: checkout.checkout_url,
      amount_ghs: amountGhs,
      amount_usd: Number(payment.amount_usd),
      fx_rate: rate,
    });
  } catch (e) {
    // Don't leave a pending row behind for a checkout that never opened.
    await admin.rpc("close_gateway_payment", { p_payment_id: payment.id });
    const err = e as OgError;
    console.error("[create-plan-checkout]", err.message, err.body ?? "");
    return json({ code: "GATEWAY_ERROR", message: err.message ?? "Payment provider unavailable" }, err.status && err.status < 500 ? 400 : 502);
  }
});
