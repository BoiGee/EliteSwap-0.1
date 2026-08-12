// Scheduled (cron) reconciler for Paystack $10 trial purchases.
// For every pending Paystack purchase older than 60s and younger than 24h,
// we directly query Paystack's transaction/verify API. If the payment is
// successful we mark the purchase confirmed, assign a trial key via RPC,
// and fire the same user+admin emails the webhook would have. Purchases
// older than 24h that are still pending are marked failed so the user's
// 2-attempt cap recovers. This makes confirmation independent of webhook
// delivery and the user returning to the dashboard.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTrialActivationEmails } from "../_shared/trial-notify.ts";

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

  const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!PAYSTACK_SECRET) return json({ code: "MISCONFIG", message: "PAYSTACK_SECRET_KEY missing" }, 500);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff = new Date(Date.now() - 60 * 1000).toISOString();

  const { data: pending, error: pErr } = await admin
    .from("trial_purchases")
    .select("*")
    .eq("status", "pending")
    .eq("payment_method", "paystack")
    .not("provider_reference", "is", null)
    .gt("created_at", since)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(50);

  if (pErr) {
    console.error("[reconcile-trial-purchases] fetch error", pErr.message);
    return json({ code: "DB_ERROR", message: pErr.message }, 500);
  }

  // Also expire ancient pending ones (>24h) — both Paystack and USDT.
  // Excludes rows flagged needs_admin_review: those are suspected Binance
  // off-chain/internal transfers (see verify-trial-payment) that require an
  // admin's manual confirm/reject, and must never be silently auto-failed by
  // this sweep — that would bypass the same "admin must confirm" policy the
  // main crypto-payment flow enforces for the identical scenario.
  const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: expired } = await admin
    .from("trial_purchases")
    .update({ status: "failed" })
    .eq("status", "pending")
    .eq("needs_admin_review", false)
    .in("payment_method", ["paystack", "usdt"])
    .lt("created_at", expiredAt)
    .select("id");

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const purchase of pending ?? []) {
    const ref = purchase.provider_reference as string;
    try {
      const r = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } },
      );
      const j = await r.json();
      const tx = j?.data;
      if (!j?.status || !tx) {
        stillPending++;
        continue;
      }
      if (tx.status === "success") {
        // Re-check current row to avoid double-confirming if webhook landed in parallel
        const { data: fresh } = await admin
          .from("trial_purchases")
          .select("id,status,assigned_key_id,user_id,provider_reference,payment_method,usdt_network,amount_usd")
          .eq("id", purchase.id)
          .maybeSingle();
        if (!fresh || fresh.status === "confirmed") {
          continue;
        }

        const { error: updErr } = await admin
          .from("trial_purchases")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
          .eq("id", purchase.id)
          .eq("status", "pending");
        if (updErr) {
          errors.push({ id: purchase.id, reason: "update_failed: " + updErr.message });
          continue;
        }

        const { error: assignErr } = await admin.rpc(
          "assign_trial_key_from_purchase",
          { p_purchase_id: purchase.id },
        );
        if (assignErr) {
          errors.push({ id: purchase.id, reason: "assign_failed: " + assignErr.message });
          // still send emails; key fulfillment trigger will catch up when pool refills
        }

        let userEmail: string | null = null;
        let displayName: string | null = null;
        try {
          const { data: userRow } = await admin.auth.admin.getUserById(purchase.user_id);
          userEmail = userRow?.user?.email ?? null;
          displayName = ((userRow?.user?.user_metadata as any)?.display_name as string) ?? null;
        } catch (_) { /* ignore */ }

        await sendTrialActivationEmails(admin, purchase, userEmail, displayName);
        confirmed++;
      } else if (tx.status === "failed" || tx.status === "abandoned") {
        await admin
          .from("trial_purchases")
          .update({ status: "failed" })
          .eq("id", purchase.id)
          .eq("status", "pending");
        failed++;
      } else {
        stillPending++;
      }
    } catch (e) {
      errors.push({ id: purchase.id, reason: String(e) });
    }
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

  return json({
    scanned: pending?.length ?? 0,
    confirmed,
    failed,
    stillPending,
    expired: expired?.length ?? 0,
    nudged,
    errors,
  });
});

