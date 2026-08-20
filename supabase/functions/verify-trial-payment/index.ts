// Verify a trial purchase and assign a key on success.
// Body: { purchase_id?: string, reference?: string, tx_hash?: string }
import { createClient } from "npm:@supabase/supabase-js@2";
import { isOffchainRef } from "../_shared/offchain-ref.ts";

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

const USDT_BSC_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RECEIVE_BSC = "0x15a62f46355f03b66c30e88dad4564dd69a3aab7";
const RECEIVE_TRON_HEX = "83ec7369d1eb28b7959014d6b20cb233dd22e5af";
const USDT_TRON_HEX = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
// Confirmation thresholds mirror verify-crypto-payment: closes 0-conf replay
// window by refusing to grant a trial key until the tx is deeply finalized.
const MIN_CONFIRMS_BSC = 6;
const MIN_CONFIRMS_TRON = 19;

async function bscRpc(method: string, params: unknown[]) {
  const r = await fetch("https://bsc-dataseed.binance.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function hexToNum(hex: string): number {
  return parseInt(hex, 16);
}

async function verifyUsdtBep20(hash: string, expectedUsd: number): Promise<{ ok: boolean; reason: string; usdt?: number; confirmations?: number }> {
  try {
    const [receipt, tipHex] = await Promise.all([
      bscRpc("eth_getTransactionReceipt", [hash]),
      bscRpc("eth_blockNumber", []),
    ]);
    if (!receipt || receipt.status !== "0x1") return { ok: false, reason: "tx_not_found" };
    const confirmations = hexToNum(tipHex) - hexToNum(receipt.blockNumber) + 1;
    let total = 0n;
    for (const log of receipt.logs ?? []) {
      if ((log.address ?? "").toLowerCase() !== USDT_BSC_CONTRACT) continue;
      if (log.topics?.[0] !== TRANSFER_TOPIC) continue;
      const to = "0x" + (log.topics[2] ?? "").slice(-40).toLowerCase();
      if (to !== RECEIVE_BSC) continue;
      total += BigInt(log.data ?? "0x0");
    }
    const usdt = Number(total) / 1e18;
    if (usdt < expectedUsd * 0.95) return { ok: false, reason: "underpaid", usdt, confirmations };
    if (confirmations < MIN_CONFIRMS_BSC) return { ok: false, reason: "low_confirmations", usdt, confirmations };
    return { ok: true, reason: "ok", usdt, confirmations };
  } catch (e) {
    return { ok: false, reason: "fetch_error: " + String(e) };
  }
}

async function verifyUsdtTrc20(hash: string, expectedUsd: number): Promise<{ ok: boolean; reason: string; usdt?: number; confirmations?: number }> {
  try {
    const [infoR, tipR] = await Promise.all([
      fetch("https://api.trongrid.io/wallet/gettransactioninfobyid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: hash.replace(/^0x/, "") }),
      }),
      fetch("https://api.trongrid.io/wallet/getnowblock"),
    ]);
    const info = await infoR.json();
    const tipJ = await tipR.json().catch(() => ({}));
    const tipBlock = tipJ?.block_header?.raw_data?.number ?? 0;
    if (!info?.id) return { ok: false, reason: "tx_not_found" };
    const confirmations = tipBlock && info.blockNumber ? tipBlock - info.blockNumber + 1 : 0;
    let total = 0n;
    for (const log of info.log ?? []) {
      if ((log.address ?? "").toLowerCase() !== USDT_TRON_HEX) continue;
      const topics: string[] = log.topics ?? [];
      if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC.slice(2)) continue;
      const to = (topics[2] ?? "").slice(-40).toLowerCase();
      if (to !== RECEIVE_TRON_HEX) continue;
      total += BigInt("0x" + (log.data ?? "0"));
    }
    const usdt = Number(total) / 1e6;
    if (usdt < expectedUsd * 0.95) return { ok: false, reason: "underpaid", usdt, confirmations };
    if (confirmations < MIN_CONFIRMS_TRON) return { ok: false, reason: "low_confirmations", usdt, confirmations };
    return { ok: true, reason: "ok", usdt, confirmations };
  } catch (e) {
    return { ok: false, reason: "fetch_error: " + String(e) };
  }
}


async function sendTrialEmails(admin: any, purchase: any, userEmail: string | null | undefined, displayName: string | null | undefined) {
  const methodLabel =
    purchase.payment_method === "momo_manual"
      ? "Mobile Money (manual, GHS)"
      : purchase.payment_method === "paystack"
      ? "Card or Mobile Money (GHS) — legacy"
      : purchase.usdt_network === "USDT-TRC20" ? "USDT (TRC-20)" : "USDT (BEP-20)";
  const ref = purchase.provider_reference || purchase.id;
  // User confirmation
  if (userEmail) {
    try {
      await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "trial-activated",
          recipientEmail: userEmail,
          idempotencyKey: `trial-activated-${purchase.id}`,
          templateData: {
            displayName: displayName ?? undefined,
            method: methodLabel,
            amountUsd: Number(purchase.amount_usd) || 10,
            durationMinutes: 4,
            reference: ref,
            studioUrl: "https://eliteswap.online/studio",
          },
        },
      });
    } catch (e) {
      console.error("[verify-trial-payment] user email failed", e);
    }
  }
  // Admin push notification (fire-and-forget) — mirrors the payments push path.
  try {
    const who = userEmail || displayName || "a user";
    await admin.functions.invoke("send-admin-push", {
      body: {
        event: "auto_confirmed",
        title: "Trial payment confirmed",
        body: `$${Number(purchase.amount_usd) || 10} • ${who} • $10 Trial (4 min)`.trim(),
        url: "/admin",
        tag: `trial-${purchase.id}`,
      },
    });
  } catch (e) {
    console.warn("[verify-trial-payment] push failed", e);
  }
}

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

      // Off-chain (Binance internal transfer) short-circuit — mirrors the
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

      let verdict: { ok: boolean; reason: string; usdt?: number; confirmations?: number };
      try {
        verdict =
          purchase.usdt_network === "USDT-TRC20"
            ? await verifyUsdtTrc20(txHash, Number(purchase.amount_usd))
            : await verifyUsdtBep20(txHash, Number(purchase.amount_usd));
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
      await sendTrialEmails(admin, { ...purchase, provider_reference: txHash }, ud.user.email, (ud.user.user_metadata as any)?.display_name || null);
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
