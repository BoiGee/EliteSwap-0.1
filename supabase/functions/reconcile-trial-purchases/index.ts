// Scheduled (cron) reconciler for $10 trial purchases.
// Neither remaining payment method (USDT, manual Mobile Money) can be
// auto-verified here — USDT confirmation happens in verify-trial-payment via
// on-chain lookup, and manual MoMo always requires an admin's manual
// confirm/reject. This sweep instead: (1) expires ancient pending purchases
// (>24h) so the user's 2-attempt cap recovers, and (2) nudges users who
// started a purchase but never submitted a reference/tx hash.
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

  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const bearer = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (bearer !== SERVICE_ROLE) {
    return json({ code: "UNAUTHORIZED", message: "Unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Expire ancient pending purchases (>24h) — USDT and manual MoMo (plus any
  // lingering legacy 'paystack' rows). Excludes rows flagged
  // needs_admin_review: those require an admin's manual confirm/reject and
  // must never be silently auto-failed by this sweep — that would bypass the
  // same "admin must confirm" policy the main crypto-payment flow enforces
  // for the identical scenario.
  const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: expired, error: expErr } = await admin
    .from("trial_purchases")
    .update({ status: "failed" })
    .eq("status", "pending")
    .eq("needs_admin_review", false)
    .in("payment_method", ["paystack", "usdt", "momo_manual"])
    .lt("created_at", expiredAt)
    .select("id");

  if (expErr) {
    console.error("[reconcile-trial-purchases] expiry error", expErr.message);
    return json({ code: "DB_ERROR", message: expErr.message }, 500);
  }

  // USDT nudge: pending USDT rows older than 10 min with NO tx hash submitted
  // get a one-time in-app notification prompting them to paste the TXID.
  let nudged = 0;
  try {
    const nudgeCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: nudgeCandidates } = await admin
      .from("trial_purchases")
      .select("id,user_id,usdt_network,created_at")
      .eq("status", "pending")
      .eq("payment_method", "usdt")
      .is("provider_reference", null)
      .lt("created_at", nudgeCutoff)
      .gt("created_at", since)
      .limit(50);

    for (const p of nudgeCandidates ?? []) {
      // De-dupe: skip if we already sent this reminder for this purchase.
      const { data: existing } = await admin
        .from("app_notifications")
        .select("id")
        .eq("user_id", p.user_id)
        .eq("kind", "trial_txid_reminder")
        .eq("target_id", p.id)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const { error: nErr } = await admin.from("app_notifications").insert({
        user_id: p.user_id,
        category: "billing",
        kind: "trial_txid_reminder",
        severity: "warning",
        title: "Finish your trial — paste your USDT transaction hash",
        body: "We haven't received the transaction hash for your $10 trial. Open the trial dialog and paste your TXID so we can auto-confirm it.",
        href: `/dashboard?resume_trial=${p.id}`,
        target_kind: "trial_purchase",
        target_id: p.id,
        data: { network: p.usdt_network },
      });
      if (!nErr) nudged++;
    }
  } catch (e) {
    console.warn("[reconcile-trial-purchases] nudge error", e);
  }

  // MoMo nudge: pending manual-MoMo rows older than 10 min with NO
  // reference submitted get a one-time in-app reminder to paste it.
  let nudgedMomo = 0;
  try {
    const nudgeCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: nudgeCandidates } = await admin
      .from("trial_purchases")
      .select("id,user_id,amount_local,created_at")
      .eq("status", "pending")
      .eq("payment_method", "momo_manual")
      .is("provider_reference", null)
      .lt("created_at", nudgeCutoff)
      .gt("created_at", since)
      .limit(50);

    for (const p of nudgeCandidates ?? []) {
      const { data: existing } = await admin
        .from("app_notifications")
        .select("id")
        .eq("user_id", p.user_id)
        .eq("kind", "trial_momo_reference_reminder")
        .eq("target_id", p.id)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      const { error: nErr } = await admin.from("app_notifications").insert({
        user_id: p.user_id,
        category: "billing",
        kind: "trial_momo_reference_reminder",
        severity: "warning",
        title: "Finish your trial — paste your Mobile Money transaction ID",
        body: "We haven't received the transaction ID for your $10 trial. Open the trial dialog and paste it so we can review your payment.",
        href: `/dashboard?resume_trial=${p.id}`,
        target_kind: "trial_purchase",
        target_id: p.id,
        data: { amount_local: p.amount_local },
      });
      if (!nErr) nudgedMomo++;
    }
  } catch (e) {
    console.warn("[reconcile-trial-purchases] momo nudge error", e);
  }

  return json({
    expired: expired?.length ?? 0,
    nudged_usdt: nudged,
    nudged_momo: nudgedMomo,
  });
});

