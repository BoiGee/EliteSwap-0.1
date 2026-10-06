// Verify a trial purchase and assign a key on success.
// Body: { purchase_id?: string, reference?: string, tx_hash?: string }
import { createClient } from "npm:@supabase/supabase-js@2";
import { isOffchainRef } from "../_shared/offchain-ref.ts";
import { notifyAdminTrialConfirmed, sendTrialActivatedEmail, verifyTrialUsdt, type UsdtVerdict } from "../_shared/trial-usdt.ts";

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
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: ud } = await userClient.auth.getUser(token);
    if (!ud?.user) return json({ code: "UNAUTHORIZED" }, 401);
    const userId = ud.user.id;

    const body = await req.json().catch(() => ({}));
    const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

    let query = admin.from("trial_purchases").select("*").eq("user_id", userId);
    if (body?.purchase_id) query = query.eq("id", body.purchase_id);
    else if (body?.reference) query = query.eq("provider_reference", body.reference);
    else return json({ code: "BAD_REQUEST", message: "purchase_id or reference required" }, 400);

    const { data: purchase } = await query.maybeSingle();
    if (!purchase) return json({ code: "NOT_FOUND", message: "Purchase not found" }, 404);

    if (purchase.status === "confirmed" && purchase.assigned_key_id) {
      return json({ status: "confirmed", purchase_id: purchase.id });
    }

    // ----- USDT -----
    if (purchase.payment_method === "usdt") {
      const txHash = String(body?.tx_hash || "").trim();
      if (!txHash) return json({ status: "pending", purchase_id: purchase.id });

      // Replay protection: don't accept a hash already used by another purchase
      const { data: replay } = await admin
        .from("trial_purchases")
        .select("id")
        .eq("provider_reference", txHash)
        .neq("id", purchase.id)
        .limit(1);
      if (replay && replay.length) {
        return json({ code: "REPLAY", message: "Transaction hash already used" }, 409);
      }

      // Persist the submitted hash immediately (as provider_reference) so the
      // admin panel and reconcile-trial-purchases cron can see & retry it,
      // even before the on-chain verdict comes back or if the RPC fails.
      // Ignored on unique-violation (already stored).
      if (!purchase.provider_reference) {
        await admin
          .from("trial_purchases")
          .update({ provider_reference: txHash })
          .eq("id", purchase.id)
          .is("provider_reference", null);
      }

      // Off-chain (Binance internal transfer) short-circuit, mirrors the
      // main crypto-payment verifier. Merchant USDT addresses are Binance
      // deposit addresses; a Binance-to-Binance internal transfer never hits
      // a public chain, so no explorer will ever find this "hash". Detect it
      // by shape before wasting an explorer call, flag the purchase for
      // admin review (so the 24h reconcile sweep won't silently fail it),
      // and notify admin once. Admin verifies in Binance -> Deposit History
      // and confirms/rejects via the existing trial-purchase admin UI.
      if (isOffchainRef(purchase.usdt_network || purchase.currency || "", txHash)) {
        if (!purchase.needs_admin_review) {
          await admin
            .from("trial_purchases")
            .update({ needs_admin_review: true })
            .eq("id", purchase.id);
          try {
            await admin.functions.invoke("send-admin-push", {
              body: {
                event: "trial_binance_offchain_review",
                title: "Trial payment needs manual review",
                body: `$${Number(purchase.amount_usd) || 10} • suspected Binance off-chain transfer • ${purchase.usdt_network || "USDT"}`,
                url: "/admin",
                tag: `trial-offchain-${purchase.id}`,
              },
            });
          } catch (e) {
            console.warn("[verify-trial-payment] offchain notify failed", e);
          }
        }
        return json({
          status: "pending",
          reason: "offchain_suspected_binance",
          hash_saved: true,
          needs_admin_review: true,
        });
      }

      let verdict: UsdtVerdict;
      try {
        verdict = await verifyTrialUsdt(purchase.usdt_network, txHash, Number(purchase.amount_usd));
      } catch (e) {
        console.error("[verify-trial-payment] chain rpc failed", e);
        return json({ status: "pending", reason: "rpc_error", hash_saved: true });
      }

      if (!verdict.ok) {
        return json({ status: "pending", reason: verdict.reason, on_chain_usdt: verdict.usdt ?? null, confirmations: verdict.confirmations ?? null, hash_saved: true });
      }

      await admin
        .from("trial_purchases")
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          provider_reference: txHash,
        })
        .eq("id", purchase.id);

      const { data: assignRows, error: assignErr } = await admin.rpc(
        "assign_trial_key_from_purchase",
        { p_purchase_id: purchase.id },
      );
      if (assignErr) return json({ code: "ASSIGN_ERROR", message: assignErr.message }, 500);
      const row = Array.isArray(assignRows) ? assignRows[0] : assignRows;
      const confirmedPurchase = { ...purchase, provider_reference: txHash };
      const displayName = (ud.user.user_metadata as any)?.display_name || null;
      if (await sendTrialActivatedEmail(admin, confirmedPurchase, ud.user.email, displayName)) {
        await admin.from("trial_purchases").update({ activation_emailed_at: new Date().toISOString() }).eq("id", purchase.id);
      }
      await notifyAdminTrialConfirmed(admin, confirmedPurchase, ud.user.email || displayName || "a user");
      return json({ status: "confirmed", purchase_id: purchase.id, api_key: row?.api_key, expires_at: row?.expires_at });
    }

    // ----- Manual Mobile Money (GHS) -----
    // There's no API to verify a manual MoMo transfer, so this never
    // auto-confirms: save the pasted reference, flag for admin review (same
    // as the USDT off-chain/Binance-internal path above), and let an admin
    // confirm/reject via admin_manage_trial_purchase in TrialPurchaseManager.
    if (purchase.payment_method === "momo_manual") {
      const txHash = String(body?.tx_hash || "").trim();
      if (!txHash) return json({ status: "pending", purchase_id: purchase.id });

      // Replay protection: don't accept a reference already used elsewhere.
      const { data: replay } = await admin
        .from("trial_purchases")
        .select("id")
        .eq("provider_reference", txHash)
        .neq("id", purchase.id)
        .limit(1);
      if (replay && replay.length) {
        return json({ code: "REPLAY", message: "Transaction reference already used" }, 409);
      }

      if (!purchase.provider_reference) {
        await admin
          .from("trial_purchases")
          .update({ provider_reference: txHash })
          .eq("id", purchase.id)
          .is("provider_reference", null);
      }

      if (!purchase.needs_admin_review) {
        await admin
          .from("trial_purchases")
          .update({ needs_admin_review: true })
          .eq("id", purchase.id);
        try {
          await admin.functions.invoke("send-admin-push", {
            body: {
              event: "trial_momo_manual_review",
              title: "Trial payment needs manual review",
              body: `${Number(purchase.amount_local) || 150} GHS • Mobile Money reference ${txHash}`,
              url: "/admin",
              tag: `trial-momo-${purchase.id}`,
            },
          });
        } catch (e) {
          console.warn("[verify-trial-payment] momo manual notify failed", e);
        }
      }

      return json({
        status: "pending",
        reason: "manual_review",
        hash_saved: true,
        needs_admin_review: true,
      });
    }

    return json({ status: "pending" });
  } catch (e) {
    console.error("[verify-trial-payment] uncaught", e);
    return json({ code: "ERROR", message: String(e) }, 500);
  }
});
