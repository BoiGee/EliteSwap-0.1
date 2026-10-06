// Scheduled (cron, every 2 min) reconciler for $10 trial purchases:
// 1. re-checks USDT purchases whose customer already submitted a tx hash. The checkout page
//    only verifies while it's open, so a customer who left before the transfer had enough
//    confirmations used to be expired here with a valid payment on chain;
// 2. sends pending Mobile Money purchases that carry a reference to the admin review queue;
// 3. expires purchases idle for 24h that have no proof of payment, so the 2-attempt cap recovers;
// 4. emails customers whose trial was confirmed (by any path) but who haven't been told;
// 5. nudges users who started a purchase but never submitted a reference/tx hash.
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyAdminTrialConfirmed, sendTrialActivatedEmail, verifyTrialUsdt } from "../_shared/trial-usdt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const DAY_MS = 24 * 60 * 60 * 1000;
// Supabase allows 30 calls to other edge functions per minute per request chain; these caps keep
// one run's pushes and emails well under that (the cron runs every 2 minutes anyway).
const RECHECK_LIMIT = 10;
const EMAIL_LIMIT = 10;

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

  const now = Date.now();
  const since = new Date(now - DAY_MS).toISOString();
  const userContact = async (userId: string) => {
    const { data } = await admin.auth.admin.getUserById(userId);
    return { email: data?.user?.email ?? null, name: ((data?.user?.user_metadata as any)?.display_name as string) || null };
  };

  // 1. Re-check USDT purchases that carry a customer-submitted tx hash.
  let rechecked = 0, autoConfirmed = 0, autoRejected = 0, flaggedUsdt = 0;
  const { data: withHash, error: hashErr } = await admin
    .from("trial_purchases")
    .select("id,user_id,payment_method,usdt_network,amount_usd,provider_reference,updated_at")
    .eq("status", "pending")
    .eq("payment_method", "usdt")
    .eq("needs_admin_review", false)
    .not("provider_reference", "is", null)
    .order("updated_at", { ascending: true })
    .limit(RECHECK_LIMIT);
  if (hashErr) console.error("[reconcile-trial-purchases] recheck query error", hashErr.message);

  for (const p of withHash ?? []) {
    rechecked++;
    const hash = String(p.provider_reference).trim();
    const { data: reused } = await admin
      .from("trial_purchases")
      .select("id")
      .eq("provider_reference", hash)
      .neq("id", p.id)
      .eq("status", "confirmed")
      .limit(1);
    if (reused?.length) {
      await admin.from("trial_purchases").update({ needs_admin_review: true }).eq("id", p.id).eq("status", "pending");
      flaggedUsdt++;
      continue;
    }

    const verdict = await verifyTrialUsdt(p.usdt_network, hash, Number(p.amount_usd));
    if (verdict.ok) {
      // Same steps as verify-trial-payment's success path; step 4 sends the customer email.
      const { error: upErr } = await admin
        .from("trial_purchases")
        .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
        .eq("id", p.id)
        .eq("status", "pending");
      if (upErr) {
        console.error("[reconcile-trial-purchases] confirm failed", p.id, upErr.message);
        continue;
      }
      const { error: assignErr } = await admin.rpc("assign_trial_key_from_purchase", { p_purchase_id: p.id });
      if (assignErr) {
        // Left confirmed without a key: the admin tab shows an "Assign key" button for it.
        console.error("[reconcile-trial-purchases] key assignment failed", p.id, assignErr.message);
        continue;
      }
      autoConfirmed++;
      const contact = await userContact(p.user_id);
      await notifyAdminTrialConfirmed(admin, p, contact.email || contact.name || "a user");
      continue;
    }

    // Give the customer a day from their last activity to finish confirming or correct the hash.
    if (new Date(p.updated_at).getTime() > now - DAY_MS) continue;
    const nothingReachedUs = verdict.reason === "tx_not_found" || (verdict.reason === "underpaid" && !verdict.usdt);
    if (nothingReachedUs) {
      await admin.from("trial_purchases").update({ status: "failed" }).eq("id", p.id).eq("status", "pending");
      autoRejected++;
    } else {
      // Part-payment, still unconfirmed after a day, or the chain lookup failing: a person decides.
      await admin.from("trial_purchases").update({ needs_admin_review: true }).eq("id", p.id).eq("status", "pending");
      flaggedUsdt++;
    }
  }

  // 2. A pending Mobile Money purchase with a reference can only be checked by an admin.
  const { data: momoFlagged, error: momoErr } = await admin
    .from("trial_purchases")
    .update({ needs_admin_review: true })
    .eq("status", "pending")
    .eq("payment_method", "momo_manual")
    .eq("needs_admin_review", false)
    .not("provider_reference", "is", null)
    .select("id");
  if (momoErr) console.error("[reconcile-trial-purchases] momo review flag error", momoErr.message);

  // 3. Expire purchases idle for 24h that carry no proof of payment. Rows flagged
  // needs_admin_review are never auto-failed (an admin must decide), and a submitted USDT hash
  // or Mobile Money reference is handled above. Paystack references are created at checkout,
  // so they aren't proof of payment.
  const { data: expired, error: expErr } = await admin
    .from("trial_purchases")
    .update({ status: "failed" })
    .eq("status", "pending")
    .eq("needs_admin_review", false)
    .in("payment_method", ["paystack", "usdt", "momo_manual"])
    .lt("updated_at", since)
    .or("payment_method.eq.paystack,provider_reference.is.null")
    .select("id");

  if (expErr) {
    console.error("[reconcile-trial-purchases] expiry error", expErr.message);
    return json({ code: "DB_ERROR", message: expErr.message }, 500);
  }

  // 4. Tell customers whose trial is confirmed with a key but who haven't been emailed.
  let emailed = 0;
  const { data: toEmail, error: emailQErr } = await admin
    .from("trial_purchases")
    .select("id,user_id,payment_method,usdt_network,amount_usd,provider_reference")
    .eq("status", "confirmed")
    .not("assigned_key_id", "is", null)
    .is("activation_emailed_at", null)
    .order("confirmed_at", { ascending: true })
    .limit(EMAIL_LIMIT);
  if (emailQErr) console.error("[reconcile-trial-purchases] activation email query error", emailQErr.message);

  for (const p of toEmail ?? []) {
    const contact = await userContact(p.user_id);
    // No address on file (e.g. account deleted): mark it so it isn't retried every 2 minutes.
    const sent = contact.email ? await sendTrialActivatedEmail(admin, p, contact.email, contact.name) : true;
    if (!sent) continue;
    await admin.from("trial_purchases").update({ activation_emailed_at: new Date().toISOString() }).eq("id", p.id);
    if (contact.email) emailed++;
  }

  // 5a. USDT nudge: pending USDT rows older than 10 min with NO tx hash submitted
  // get a one-time in-app notification prompting them to paste the TXID.
  let nudged = 0;
  try {
    const nudgeCutoff = new Date(now - 10 * 60 * 1000).toISOString();
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
        title: "Finish your trial: paste your USDT transaction hash",
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

  // 5b. MoMo nudge: pending manual-MoMo rows older than 10 min with NO
  // reference submitted get a one-time in-app reminder to paste it.
  let nudgedMomo = 0;
  try {
    const nudgeCutoff = new Date(now - 10 * 60 * 1000).toISOString();
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
        title: "Finish your trial: paste your Mobile Money transaction ID",
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
    rechecked,
    auto_confirmed: autoConfirmed,
    auto_rejected: autoRejected,
    flagged_usdt: flaggedUsdt,
    flagged_momo: momoFlagged?.length ?? 0,
    expired: expired?.length ?? 0,
    emailed,
    nudged_usdt: nudged,
    nudged_momo: nudgedMomo,
  });
});
