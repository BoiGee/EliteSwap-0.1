// Scheduled reconciler for payments stuck in pending_key_assignment=true.
// Cause: pool for the plan was empty when the payment was confirmed.
// This function retries public.issue_api_key_for_payment for every stuck row
// (cheap — the RPC no-ops if a key already exists or the pool is still empty),
// and pushes an admin alert once per payment when the wait exceeds 15 min so
// the operator can top up the pool. Idempotent; safe to run every 5 min.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Require an exact match against the literal service-role key. verify_jwt is
  // off at the gateway, so we must gate this here — otherwise anyone could
  // trigger the RPC + admin push fan-out on demand.
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  // Constant-time compare to avoid leaking secret bytes via timing.
  const expected = SERVICE_ROLE;
  let ok = bearer.length === expected.length && expected.length > 0;
  if (ok) {
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= bearer.charCodeAt(i) ^ expected.charCodeAt(i);
    ok = diff === 0;
  }
  if (!ok) {
    return json({ error: "Forbidden" }, 403);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    SERVICE_ROLE,
    { auth: { persistSession: false } },
  );

  // Grab up to 100 stuck payments, oldest first.
  const { data: stuck, error } = await admin
    .from("payments")
    .select("id,user_id,plan_id,updated_at,created_at")
    .eq("status", "confirmed")
    .eq("pending_key_assignment", true)
    .order("updated_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("[retry-pending-key-assignments] fetch", error.message);
    return json({ code: "DB_ERROR", message: error.message }, 500);
  }

  const results = { total: stuck?.length ?? 0, issued: 0, still_stuck: 0, alerted: 0 };
  const ALERT_AFTER_MS = 15 * 60 * 1000;

  for (const p of stuck ?? []) {
    try {
      const { data: keyId, error: rpcErr } = await admin.rpc(
        "issue_api_key_for_payment",
        { p_payment_id: p.id },
      );
      if (rpcErr) {
        console.warn("[retry-pending-key-assignments] rpc", p.id, rpcErr.message);
        results.still_stuck++;
        continue;
      }
      if (keyId) {
        results.issued++;
        continue;
      }
      // Still no key — check age; alert once via a piggyback record.
      results.still_stuck++;
      const ageMs = Date.now() - new Date(p.updated_at ?? p.created_at).getTime();
      if (ageMs < ALERT_AFTER_MS) continue;

      // Claim an alert slot in payment_verification_attempts (unique-index-safe idempotency).
      const claim = await admin
        .from("payment_verification_attempts")
        .insert({
          payment_id: p.id,
          outcome: "skipped",
          reason: "pool_exhausted_admin_notified",
          raw: { plan_id: p.plan_id, age_ms: ageMs, claim: true },
        })
        .select("id")
        .maybeSingle();
      if (claim.error) {
        // 23505 duplicate → already alerted; skip.
        if ((claim.error as any).code !== "23505") {
          console.warn("[retry-pending-key-assignments] claim", claim.error);
        }
        continue;
      }
      results.alerted++;
      admin.functions.invoke("send-admin-push", {
        body: {
          event: "pool_exhausted",
          title: "API key pool exhausted",
          body: `Payment ${p.id.slice(0, 8)}… waiting for a key • plan ${p.plan_id?.slice(0, 8) ?? "?"} • ${Math.round(ageMs / 60000)}m`,
          url: "/admin",
          tag: `pool-exhausted-${p.id}`,
        },
      }).catch((e) => console.warn("[retry-pending-key-assignments] push", e));
    } catch (e) {
      console.warn("[retry-pending-key-assignments] loop", p.id, e);
      results.still_stuck++;
    }
  }

  return json({ ok: true, ...results });
});
