// Paystack webhook receiver. Validates x-paystack-signature (HMAC SHA512)
// and marks the matching trial_purchase confirmed + assigns key.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHmac } from "node:crypto";
import { sendTrialActivationEmails } from "../_shared/trial-notify.ts";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-paystack-signature",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!PAYSTACK_SECRET) return new Response("misconfig", { status: 500 });

  const raw = await req.text();
  const sig = req.headers.get("x-paystack-signature") || "";
  const expected = createHmac("sha512", PAYSTACK_SECRET).update(raw).digest("hex");
  if (sig !== expected) {
    console.warn("[paystack-webhook] bad signature");
    return new Response("invalid signature", { status: 401 });
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const ref = evt?.data?.reference;
  if (!ref) return new Response("ok", { status: 200 });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: purchase } = await admin
    .from("trial_purchases")
    .select("*")
    .eq("provider_reference", ref)
    .maybeSingle();
  if (!purchase) return new Response("ok", { status: 200 });

  if (evt.event === "charge.success" && purchase.status !== "confirmed") {
    await admin
      .from("trial_purchases")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", purchase.id);
    const { error } = await admin.rpc("assign_trial_key_from_purchase", { p_purchase_id: purchase.id });
    if (error) console.error("[paystack-webhook] assign failed", error.message);

    // Fetch buyer email + name and send emails via shared helper
    try {
      const { data: userRow } = await admin.auth.admin.getUserById(purchase.user_id);
      const userEmail = userRow?.user?.email || evt?.data?.customer?.email || null;
      const displayName =
        ((userRow?.user?.user_metadata as any)?.display_name as string | undefined) ||
        evt?.data?.customer?.first_name || null;
      await sendTrialActivationEmails(admin, purchase, userEmail, displayName);
    } catch (e) {
      console.error("[paystack-webhook] email send failed", e);
    }

  } else if (evt.event === "charge.failed" && purchase.status === "pending") {
    await admin.from("trial_purchases").update({ status: "failed" }).eq("id", purchase.id);
    admin.functions.invoke("send-admin-push", {
      body: {
        event: "trial_failed",
        title: "Trial payment failed",
        body: `Paystack ref ${ref} — ${evt?.data?.gateway_response ?? "declined"}`,
        url: "/admin",
        tag: `trial-fail-${purchase.id}`,
      },
    }).catch((e) => console.warn("[paystack-webhook] push failed", e));
  }

  return new Response("ok", { status: 200, headers: corsHeaders });
});
