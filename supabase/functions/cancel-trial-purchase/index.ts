// Cancel a user's own pending USDT trial purchase (they never paid).
// Marks status='failed' so it frees the "resume pending" UX and doesn't
// count as a confirmed use toward the 2-trial cap.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ code: "UNAUTHORIZED", message: "Sign in required" }, 401);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: ud, error: ue } = await userClient.auth.getUser(token);
    if (ue || !ud?.user) return json({ code: "UNAUTHORIZED", message: "Invalid session" }, 401);
    const userId = ud.user.id;

    const body = await req.json().catch(() => ({}));
    const purchaseId = String(body?.purchase_id || "");
    if (!purchaseId) return json({ code: "BAD_REQUEST", message: "purchase_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

    // Only allow cancelling own pending USDT purchase with no tx hash submitted yet.
    const { data: row, error: rErr } = await admin
      .from("trial_purchases")
      .select("id,user_id,status,payment_method,provider_reference,assigned_key_id")
      .eq("id", purchaseId)
      .maybeSingle();

    if (rErr) return json({ code: "DB_ERROR", message: rErr.message }, 500);
    if (!row) return json({ code: "NOT_FOUND", message: "Purchase not found" }, 404);
    if (row.user_id !== userId) return json({ code: "FORBIDDEN", message: "Not your purchase" }, 403);
    if (row.status !== "pending") return json({ code: "INVALID_STATE", message: `Cannot cancel a ${row.status} purchase` }, 409);
    if (row.payment_method !== "usdt") return json({ code: "INVALID_METHOD", message: "Only USDT purchases can be self-cancelled" }, 409);
    if (row.provider_reference) return json({ code: "TXID_SUBMITTED", message: "A transaction hash was already submitted — contact support instead" }, 409);
    if (row.assigned_key_id) return json({ code: "ALREADY_FULFILLED", message: "Already fulfilled" }, 409);

    const { error: uErr } = await admin
      .from("trial_purchases")
      .update({ status: "failed" })
      .eq("id", purchaseId)
      .eq("status", "pending");
    if (uErr) return json({ code: "UPDATE_FAILED", message: uErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    console.error("[cancel-trial-purchase]", e);
    return json({ code: "ERROR", message: "Unexpected error" }, 500);
  }
});
