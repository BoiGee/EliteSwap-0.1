// Verify a crypto payment on-chain by its tx_hash and auto-confirm if everything matches.
// Safety: never rejects, never modifies anything besides flipping pending_review -> confirmed
// via the dedicated SECURITY DEFINER RPC (auto_confirm_payment_from_verifier).
// Triggered by:
//   - client kick: POST { paymentId } right after the user submits a tx hash
//   - cron: POST { mode: "cron" } every ~2 minutes
//
// Receive addresses & confirmation thresholds mirror src/components/CryptoPayment.tsx.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ---------- chain constants ----------
const RECEIVE = {
  BTC: "1EuGLFCfRVd2p4VwpjWHhBKtZbMc8Wbcv7",
  BSC: "0x15a62f46355f03b66c30e88dad4564dd69a3aab7".toLowerCase(),
  TRON: "TMzkn5dm1Ehzg5KUF8uNcB1N9Y5FjzadF8",
} as const;

const MIN_CONFIRMS = { BTC: 2, BSC: 6, TRON: 19 } as const;

const USDT_BSC_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------- helpers ----------

// Detect references that can never appear on a public blockchain:
//   - Binance internal transfers between two Binance accounts
//   - Cash App / Strike / exchange withdrawal IDs
// These look nothing like real on-chain tx hashes, so we can rule them out
// by shape before calling any explorer. Returns true => skip on-chain checks
// and route the payment straight to admin manual review.
function isOffchainRef(currency: string, raw: string): boolean {
  const h = (raw || "").trim();
  if (!h) return false;
  // Obvious off-chain markers anywhere in the string.
  if (/off[\s-]?chain|binance|internal|withdrawal/i.test(h)) return true;
  // Strip a leading 0x for length/charset checks on EVM/Tron-style hashes.
  const core = h.replace(/^0x/i, "");
  // Real on-chain hashes are always exactly 64 hex chars (BTC, BSC, TRON).
  const isHex64 = /^[0-9a-fA-F]{64}$/.test(core);
  if (isHex64) return false;
  // BSC must have the 0x prefix on top of being 64 hex.
  if ((currency === "BNB" || currency === "USDT-BEP20") && !/^0x[0-9a-fA-F]{64}$/.test(h)) {
    return true;
  }
  // BTC / TRON: must be 64 hex (no prefix). Anything else is off-chain.
  if ((currency === "BTC" || currency === "USDT-TRC20") && !isHex64) {
    return true;
  }
  return false;
}

async function logAttempt(opts: {
  paymentId: string;
  outcome: string;
  reason: string;
  confirmations?: number | null;
  on_chain_amount?: number | null;
  expected_amount_usd?: number | null;
  raw?: unknown;
}) {
  try {
    await admin.from("payment_verification_attempts").insert({
      payment_id: opts.paymentId,
      outcome: opts.outcome,
      reason: opts.reason,
      confirmations: opts.confirmations ?? null,
      on_chain_amount: opts.on_chain_amount ?? null,
      expected_amount_usd: opts.expected_amount_usd ?? null,
      raw: opts.raw ? (opts.raw as any) : null,
    });
  } catch (e) {
    console.warn("logAttempt failed", e);
  }
}

async function fetchUsdPrices(): Promise<{ btc: number | null; bnb: number | null }> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,binancecoin&vs_currencies=usd",
    );
    if (!r.ok) return { btc: null, bnb: null };
    const j = await r.json();
    return { btc: j?.bitcoin?.usd ?? null, bnb: j?.binancecoin?.usd ?? null };
  } catch {
    return { btc: null, bnb: null };
  }
}

type VerdictReason =
  | "ok"
  | "tx_not_found"
  | "low_confirmations"
  | "wrong_address"
  | "currency_mismatch"
  | "underpaid"
  | "rate_unavailable"
  | "tx_too_old"
  | "fetch_error"
  | "unsupported_currency"
  | "replay";

interface Verdict {
  ok: boolean;
  reason: VerdictReason;
  confirmations?: number;
  receivedUsd?: number; // USD value of what we actually received at to-address
  raw?: unknown;
}

// ---------- BTC ----------
async function verifyBtc(
  hash: string,
  expectedUsd: number,
  btcUsd: number | null,
  paymentCreatedAt: string,
): Promise<Verdict> {
  if (btcUsd === null) return { ok: false, reason: "rate_unavailable" };
  let tx: any, tip: number;
  try {
    const [txR, tipR] = await Promise.all([
      fetch(`https://blockstream.info/api/tx/${hash}`),
      fetch(`https://blockstream.info/api/blocks/tip/height`),
    ]);
    if (txR.status === 404) return { ok: false, reason: "tx_not_found" };
    if (!txR.ok || !tipR.ok) return { ok: false, reason: "fetch_error" };
    tx = await txR.json();
    tip = Number(await tipR.text());
  } catch {
    return { ok: false, reason: "fetch_error" };
  }
  const blockHeight: number | undefined = tx?.status?.block_height;
  const confirmations = blockHeight ? tip - blockHeight + 1 : 0;

  const blockTime = tx?.status?.block_time
    ? new Date(tx.status.block_time * 1000)
    : null;
  if (
    blockTime &&
    Math.abs(blockTime.getTime() - new Date(paymentCreatedAt).getTime()) >
      7 * 86400 * 1000
  ) {
    return { ok: false, reason: "tx_too_old", confirmations, raw: tx };
  }

  // Sum outputs to our address (sats)
  let sats = 0;
  let toAddrSeen = false;
  for (const v of tx?.vout ?? []) {
    if (v?.scriptpubkey_address === RECEIVE.BTC) {
      toAddrSeen = true;
      sats += Number(v.value ?? 0);
    }
  }
  if (!toAddrSeen) return { ok: false, reason: "wrong_address", confirmations, raw: tx };

  const btcAmount = sats / 1e8;
  const receivedUsd = btcAmount * btcUsd;

  if (confirmations < MIN_CONFIRMS.BTC) {
    return { ok: false, reason: "low_confirmations", confirmations, receivedUsd, raw: tx };
  }
  if (receivedUsd < expectedUsd * 0.99) {
    return { ok: false, reason: "underpaid", confirmations, receivedUsd, raw: tx };
  }
  return { ok: true, reason: "ok", confirmations, receivedUsd, raw: tx };
}

// ---------- BSC (BNB + USDT-BEP20) ----------
async function bscRpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch("https://bsc-dataseed.binance.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`bsc rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`bsc rpc: ${j.error.message}`);
  return j.result;
}

function hexToNum(hex: string): number {
  return parseInt(hex, 16);
}
function hexToBig(hex: string): bigint {
  return BigInt(hex);
}

async function verifyBsc(
  hash: string,
  currency: "BNB" | "USDT-BEP20",
  expectedUsd: number,
  bnbUsd: number | null,
  paymentCreatedAt: string,
): Promise<Verdict> {
  let tx: any, receipt: any, tipHex: string;
  try {
    [tx, receipt, tipHex] = await Promise.all([
      bscRpc("eth_getTransactionByHash", [hash]),
      bscRpc("eth_getTransactionReceipt", [hash]),
      bscRpc("eth_blockNumber", []),
    ]);
  } catch (e) {
    return { ok: false, reason: "fetch_error", raw: String(e) };
  }
  if (!tx || !receipt) return { ok: false, reason: "tx_not_found" };
  if (receipt.status !== "0x1") return { ok: false, reason: "tx_not_found", raw: receipt };

  const tip = hexToNum(tipHex);
  const blockNum = hexToNum(receipt.blockNumber);
  const confirmations = tip - blockNum + 1;

  // Tx age check via block timestamp
  try {
    const block = await bscRpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    const ts = hexToNum(block.timestamp) * 1000;
    if (Math.abs(ts - new Date(paymentCreatedAt).getTime()) > 7 * 86400 * 1000) {
      return { ok: false, reason: "tx_too_old", confirmations, raw: tx };
    }
  } catch { /* non-fatal */ }

  if (currency === "BNB") {
    if (bnbUsd === null) return { ok: false, reason: "rate_unavailable" };
    if ((tx.to ?? "").toLowerCase() !== RECEIVE.BSC) {
      return { ok: false, reason: "wrong_address", confirmations, raw: tx };
    }
    const wei = hexToBig(tx.value ?? "0x0");
    const bnbAmount = Number(wei) / 1e18;
    const receivedUsd = bnbAmount * bnbUsd;
    if (confirmations < MIN_CONFIRMS.BSC) {
      return { ok: false, reason: "low_confirmations", confirmations, receivedUsd, raw: tx };
    }
    if (receivedUsd < expectedUsd * 0.99) {
      return { ok: false, reason: "underpaid", confirmations, receivedUsd, raw: tx };
    }
    return { ok: true, reason: "ok", confirmations, receivedUsd, raw: tx };
  }

  // USDT-BEP20: scan Transfer logs from the USDT contract to our address.
  let totalRaw = 0n;
  let toAddrSeen = false;
  let contractSeen = false;
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== USDT_BSC_CONTRACT) continue;
    contractSeen = true;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    // topics[2] = to address (32-byte padded)
    const toTopic = (log.topics[2] ?? "").toLowerCase();
    const toAddr = "0x" + toTopic.slice(-40);
    if (toAddr !== RECEIVE.BSC) continue;
    toAddrSeen = true;
    totalRaw += hexToBig(log.data ?? "0x0");
  }
  if (!contractSeen) return { ok: false, reason: "currency_mismatch", confirmations, raw: receipt };
  if (!toAddrSeen) return { ok: false, reason: "wrong_address", confirmations, raw: receipt };

  // USDT has 18 decimals on BSC
  const usdt = Number(totalRaw) / 1e18;
  const receivedUsd = usdt; // 1:1
  if (confirmations < MIN_CONFIRMS.BSC) {
    return { ok: false, reason: "low_confirmations", confirmations, receivedUsd, raw: receipt };
  }
  if (receivedUsd < expectedUsd * 0.99) {
    return { ok: false, reason: "underpaid", confirmations, receivedUsd, raw: receipt };
  }
  return { ok: true, reason: "ok", confirmations, receivedUsd, raw: receipt };
}

// ---------- TRON (USDT-TRC20) ----------
async function verifyTron(
  hash: string,
  expectedUsd: number,
  paymentCreatedAt: string,
): Promise<Verdict> {
  let info: any, tx: any;
  try {
    const [infoR, txR] = await Promise.all([
      fetch(`https://api.trongrid.io/wallet/gettransactioninfobyid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: hash.replace(/^0x/, "") }),
      }),
      fetch(`https://api.trongrid.io/wallet/gettransactionbyid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: hash.replace(/^0x/, "") }),
      }),
    ]);
    info = await infoR.json();
    tx = await txR.json();
  } catch (e) {
    return { ok: false, reason: "fetch_error", raw: String(e) };
  }
  if (!info || !info.id) return { ok: false, reason: "tx_not_found" };
  // contractResult success
  const success =
    info?.receipt?.result === "SUCCESS" ||
    (Array.isArray(info?.contractResult) && info.contractResult[0]);
  if (!success && info?.result !== "SUCCESS" && !info?.log) {
    // some tx have no result field on success; rely on log presence below
  }

  // Confirmations: tip block - tx block
  let tipBlock = 0;
  try {
    const tipR = await fetch("https://api.trongrid.io/wallet/getnowblock");
    const tipJ = await tipR.json();
    tipBlock = tipJ?.block_header?.raw_data?.number ?? 0;
  } catch { /* non-fatal */ }
  const confirmations = tipBlock && info.blockNumber ? tipBlock - info.blockNumber + 1 : 0;

  // Age
  if (info.blockTimeStamp) {
    if (
      Math.abs(info.blockTimeStamp - new Date(paymentCreatedAt).getTime()) >
      7 * 86400 * 1000
    ) {
      return { ok: false, reason: "tx_too_old", confirmations, raw: info };
    }
  }

  // Scan TRC20 Transfer events in info.log
  const logs: any[] = info?.log ?? [];
  let totalRaw = 0n;
  let toAddrSeen = false;
  let contractSeen = false;
  // USDT-TRC20 contract address (hex w/o 0x41 prefix): a614f803b6fd780986a42c78ec9c7f77e6ded13c
  const USDT_TRON_HEX = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
  // Receive address TMzkn5dm1Ehzg5KUF8uNcB1N9Y5FjzadF8 decoded via base58check.
  // Tron addresses are 21 bytes (0x41 + 20-byte payload). Transfer log topics
  // hold the 20-byte payload right-padded to 32 bytes, so we match the last 40 hex chars.
  const OUR_TRON_HEX = "83ec7369d1eb28b7959014d6b20cb233dd22e5af";
  for (const log of logs) {
    if ((log.address ?? "").toLowerCase() !== USDT_TRON_HEX) continue;
    contractSeen = true;
    const topics: string[] = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC.slice(2)) continue;
    const toTopic = (topics[2] ?? "").toLowerCase();
    const toAddr = toTopic.slice(-40);
    if (toAddr !== OUR_TRON_HEX) continue;
    toAddrSeen = true;
    totalRaw += BigInt("0x" + (log.data ?? "0"));
  }
  if (!contractSeen) return { ok: false, reason: "currency_mismatch", confirmations, raw: info };
  if (!toAddrSeen) return { ok: false, reason: "wrong_address", confirmations, raw: info };

  // USDT on TRON has 6 decimals
  const usdt = Number(totalRaw) / 1e6;
  const receivedUsd = usdt;
  if (confirmations < MIN_CONFIRMS.TRON) {
    return { ok: false, reason: "low_confirmations", confirmations, receivedUsd, raw: info };
  }
  if (receivedUsd < expectedUsd * 0.99) {
    return { ok: false, reason: "underpaid", confirmations, receivedUsd, raw: info };
  }
  return { ok: true, reason: "ok", confirmations, receivedUsd, raw: info };
}

// ---------- per-payment verifier ----------
async function verifyOne(
  paymentId: string,
  rates: { btc: number | null; bnb: number | null },
) {
  // Fresh fetch — never trust request body
  const { data: payment, error } = await admin
    .from("payments")
    .select("id,user_id,status,currency,tx_hash,amount_usd,plan_id,payment_method,created_at")
    .eq("id", paymentId)
    .maybeSingle();
  if (error || !payment) {
    await logAttempt({ paymentId, outcome: "skipped", reason: "payment_not_found" });
    return { paymentId, outcome: "skipped", reason: "payment_not_found" };
  }
  if (payment.status !== "pending") {
    await logAttempt({ paymentId, outcome: "skipped", reason: "status_" + payment.status });
    return { paymentId, outcome: "skipped", reason: "status_" + payment.status };
  }
  if (payment.payment_method !== "crypto" || !payment.tx_hash) {
    await logAttempt({ paymentId, outcome: "skipped", reason: "not_crypto_or_no_hash" });
    return { paymentId, outcome: "skipped", reason: "not_crypto_or_no_hash" };
  }

  // If we've already escalated this payment to admin review (e.g. suspected
  // off-chain / exchange-internal transfer where the hash never appears on
  // the public ledger), stop hitting chain providers — admin will action it.
  const { data: prevEscalation } = await admin
    .from("payment_verification_attempts")
    .select("id")
    .eq("payment_id", payment.id)
    .eq("reason", "needs_admin_review_offchain")
    .limit(1);
  if (prevEscalation && prevEscalation.length > 0) {
    return { paymentId, outcome: "skipped", reason: "awaiting_admin_review" };
  }

  // Replay protection (DB also enforces via unique index, but check early)
  const { data: replay } = await admin
    .from("payments")
    .select("id")
    .eq("status", "confirmed")
    .eq("payment_method", "crypto")
    .ilike("tx_hash", payment.tx_hash)
    .neq("id", payment.id)
    .limit(1);
  if (replay && replay.length > 0) {
    await logAttempt({
      paymentId,
      outcome: "mismatch",
      reason: "replay",
      raw: { conflicts_with: replay[0].id },
    });
    return { paymentId, outcome: "mismatch", reason: "replay" };
  }

  // Resolve expected USD amount: prefer plan price, fall back to payment.amount_usd
  let expectedUsd = Number(payment.amount_usd ?? 0);
  let planId: string | null = payment.plan_id ?? null;
  if ((!expectedUsd || expectedUsd <= 0) && planId) {
    const { data: plan } = await admin
      .from("pricing_plans")
      .select("price_usd")
      .eq("id", planId)
      .maybeSingle();
    expectedUsd = Number(plan?.price_usd ?? 0);
  }
  if (!expectedUsd || expectedUsd <= 0) {
    await logAttempt({ paymentId, outcome: "skipped", reason: "no_expected_amount" });
    return { paymentId, outcome: "skipped", reason: "no_expected_amount" };
  }

  const cur = payment.currency ?? "";
  const hash = payment.tx_hash.trim();

  // ---------- Off-chain (Binance internal transfer) short-circuit ----------
  // The merchant addresses are Binance deposit addresses. When another Binance
  // user pays from inside Binance, Binance settles the transfer on its own
  // books — nothing is ever broadcast to a public chain, so no explorer can
  // ever return that "hash". The reference the user pastes is a Binance
  // internal txId / withdrawal ID (e.g. "381479981610", "Off-chain Transfer …").
  // Detect those refs by shape before wasting any explorer calls, log a single
  // attempt, escalate to admin once, and short-circuit. Admin verifies in
  // Binance → Deposit History and clicks Approve/Reject in the existing UI.
  if (isOffchainRef(cur, hash)) {
    await logAttempt({
      paymentId,
      outcome: "skipped",
      reason: "offchain_suspected_binance",
      expected_amount_usd: expectedUsd,
      raw: { tx_hash: hash, currency: cur },
    });
    await logAttempt({
      paymentId,
      outcome: "skipped",
      reason: "needs_admin_review_offchain",
      raw: {
        verdict_reason: "offchain_suspected_binance",
        tx_hash: hash,
        currency: cur,
      },
    });
    try {
      await admin.functions.invoke("notify-admin-payment-event", {
        body: {
          paymentId: payment.id,
          eventType: "binance_offchain_review",
        },
      });
    } catch (e) {
      console.warn("binance offchain notify failed", e);
    }
    return {
      paymentId,
      outcome: "skipped",
      reason: "offchain_suspected_binance",
    };
  }

  let verdict: Verdict;
  if (cur === "BTC") {
    verdict = await verifyBtc(hash, expectedUsd, rates.btc, payment.created_at);
  } else if (cur === "BNB") {
    verdict = await verifyBsc(hash, "BNB", expectedUsd, rates.bnb, payment.created_at);
  } else if (cur === "USDT-BEP20") {
    verdict = await verifyBsc(hash, "USDT-BEP20", expectedUsd, rates.bnb, payment.created_at);
  } else if (cur === "USDT-TRC20") {
    verdict = await verifyTron(hash, expectedUsd, payment.created_at);
  } else {
    verdict = { ok: false, reason: "unsupported_currency" };
  }

  const outcome = verdict.ok
    ? "confirmed"
    : verdict.reason === "low_confirmations" || verdict.reason === "tx_not_found" || verdict.reason === "fetch_error" || verdict.reason === "rate_unavailable"
      ? "pending"
      : "mismatch";

  await logAttempt({
    paymentId,
    outcome,
    reason: verdict.reason,
    confirmations: verdict.confirmations ?? null,
    on_chain_amount: verdict.receivedUsd ?? null,
    expected_amount_usd: expectedUsd,
    raw: verdict.raw,
  });

  // ---------- Notify buyer once on underpaid so they can top up ----------
  // Race-safe: claim the slot first via a unique-index-backed insert. Only the
  // run that wins the insert proceeds to send the email; concurrent verifier
  // invocations get a duplicate-key error and silently skip.
  if (verdict.reason === "underpaid") {
    const receivedUsd = Number(verdict.receivedUsd ?? 0);
    const shortfallUsd = Math.max(0, Number((expectedUsd - receivedUsd).toFixed(2)));
    const claim = await admin
      .from("payment_verification_attempts")
      .insert({
        payment_id: payment.id,
        outcome: "skipped",
        reason: "user_notified_underpaid",
        expected_amount_usd: expectedUsd,
        on_chain_amount: receivedUsd,
        raw: { shortfall_usd: shortfallUsd, claim: true },
      })
      .select("id")
      .maybeSingle();
    if (claim.error) {
      // 23505 = unique_violation → another concurrent run already claimed it.
      if ((claim.error as any).code !== "23505") {
        console.warn("underpaid notify claim failed", claim.error);
      }
    } else {
      try {
        const { DEPOSIT_WALLETS } = await import("../_shared/crypto-addresses.ts");
        const wallet = (DEPOSIT_WALLETS as any)[cur];
        let buyerEmail: string | null = null;
        let displayName: string | undefined;
        if (payment.user_id) {
          const { data: prof } = await admin
            .from("profiles")
            .select("email,full_name,username")
            .eq("id", payment.user_id)
            .maybeSingle();
          buyerEmail = prof?.email ?? null;
          displayName = prof?.full_name || prof?.username || undefined;
          if (!buyerEmail) {
            const { data: authUser } = await admin.auth.admin.getUserById(payment.user_id);
            buyerEmail = authUser?.user?.email ?? null;
          }
        }
        if (buyerEmail && wallet) {
          await admin.functions.invoke("send-transactional-email", {
            body: {
              templateName: "payment-underpaid",
              recipientEmail: buyerEmail,
              idempotencyKey: `underpaid-${payment.id}`,
              templateData: {
                displayName,
                currency: cur,
                network: wallet.network,
                depositAddress: wallet.address,
                expectedUsd,
                receivedUsd,
                shortfallUsd,
                txHash: hash,
                supportUrl: "mailto:support@eliteswap.online",
              },
            },
          });
        } else {
          await logAttempt({
            paymentId,
            outcome: "skipped",
            reason: "user_notified_underpaid_skipped",
            raw: { has_email: !!buyerEmail, has_wallet: !!wallet },
          });
        }
      } catch (e) {
        console.warn("underpaid notify send failed", e);
      }
      // Also push admin — once per payment (piggybacks the same claim).
      admin.functions.invoke("send-admin-push", {
        body: {
          event: "underpaid_review",
          title: "Payment underpaid",
          body: `$${expectedUsd} expected, $${receivedUsd.toFixed(2)} received • ${cur}`,
          url: "/admin",
          tag: `underpaid-${payment.id}`,
        },
      }).catch((e) => console.warn("underpaid admin push failed", e));
    }
  }

  // Escalate to admin manual review for verdicts the verifier can never
  // auto-resolve on its own:
  //   - tx_not_found      : likely off-chain / exchange-internal transfer
  //   - wrong_address     : user sent to an address that isn't ours
  //   - currency_mismatch : user picked the wrong network / token
  //   - underpaid         : amount received < expected (after tolerance)
  // We wait until the payment is old enough that further retries won't change
  // the verdict (30 min for tx_not_found which depends on explorer indexing,
  // 20 min for the others which are already derived from confirmed on-chain
  // data). We log a single escalation marker (short-circuits future cron runs
  // via prevEscalation above) and notify admin. Status stays "pending" — admin
  // still flips it manually through the existing review UI.
  const TERMINAL_MISMATCH_REASONS = new Set([
    "wrong_address",
    "currency_mismatch",
    "underpaid",
  ]);
  const ageMs = Date.now() - new Date(payment.created_at).getTime();
  const shouldEscalate =
    (verdict.reason === "tx_not_found" && ageMs > 30 * 60 * 1000) ||
    (TERMINAL_MISMATCH_REASONS.has(verdict.reason) && ageMs > 20 * 60 * 1000);
  if (shouldEscalate) {
    await logAttempt({
      paymentId,
      outcome: "skipped",
      reason: "needs_admin_review_offchain",
      raw: {
        age_minutes: Math.round(ageMs / 60000),
        verdict_reason: verdict.reason,
        confirmations: verdict.confirmations ?? null,
        received_usd: verdict.receivedUsd ?? null,
        expected_usd: expectedUsd,
      },
    });
    try {
      await admin.functions.invoke("notify-admin-payment-event", {
        body: {
          paymentId: payment.id,
          eventType:
            verdict.reason === "tx_not_found"
              ? "tx_not_found_review"
              : "verifier_mismatch_review",
        },
      });
    } catch (e) {
      console.warn("escalation notify failed", e);
    }
    return { paymentId, outcome: "skipped", reason: "needs_admin_review_offchain" };
  }

  if (verdict.ok) {
    const { error: rpcErr } = await admin.rpc(
      "auto_confirm_payment_from_verifier" as any,
      {
        p_payment_id: payment.id,
        p_plan_id: planId,
        p_amount_usd: expectedUsd,
      },
    );
    if (rpcErr) {
      console.error("auto_confirm rpc failed", rpcErr);
      await logAttempt({
        paymentId,
        outcome: "skipped",
        reason: "rpc_error:" + rpcErr.message,
      });
      return { paymentId, outcome: "skipped", reason: "rpc_error" };
    }

    // The trg_payments_auto_issue_key trigger runs synchronously inside the RPC,
    // so by the time it returns either an api_keys row exists for this payment
    // OR payments.pending_key_assignment was set true (pool empty for that plan).
    let keyIssued = false;
    let keyPending = false;
    try {
      const [{ data: keyRow }, { data: payRow }] = await Promise.all([
        admin.from("api_keys").select("id").eq("payment_id", payment.id).maybeSingle(),
        admin.from("payments").select("pending_key_assignment").eq("id", payment.id).maybeSingle(),
      ]);
      keyIssued = !!keyRow?.id;
      keyPending = !keyIssued && !!payRow?.pending_key_assignment;
    } catch (e) {
      console.warn("post-confirm key lookup failed", e);
    }

    await logAttempt({
      paymentId,
      outcome: "confirmed",
      reason: keyIssued ? "ok_key_issued" : keyPending ? "ok_key_pending" : "ok",
      confirmations: verdict.confirmations ?? null,
      on_chain_amount: verdict.receivedUsd ?? null,
      expected_amount_usd: expectedUsd,
    });

    // Fire-and-forget admin alert; mirrors the existing notify path
    try {
      await admin.functions.invoke("notify-admin-payment-event", {
        body: {
          paymentId: payment.id,
          eventType: keyPending ? "auto_confirmed_key_pending" : "auto_confirmed",
        },
      });
    } catch (e) {
      console.warn("notify-admin-payment-event failed", e);
    }

    // Send the user the approval email (same template admin uses)
    try {
      const { data: prof } = await admin
        .from("profiles")
        .select("email,display_name")
        .eq("user_id", payment.user_id)
        .maybeSingle();
      if (prof?.email) {
        const adminNote = keyIssued
          ? "Your transaction was verified automatically on-chain — your account is fully unlocked. Welcome aboard!"
          : "Your transaction was verified automatically on-chain. Your API key is being assigned and will appear in your dashboard shortly — usually within a few minutes.";
        await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: "payment-approved",
            recipientEmail: prof.email,
            idempotencyKey: `payment-${payment.id}-confirmed`,
            templateData: {
              displayName: prof.display_name || prof.email.split("@")[0],
              amountUsd: expectedUsd,
              paymentMethod: "Crypto",
              reference: payment.tx_hash,
              adminNote,
            },
          },
        });
      }
    } catch (e) {
      console.warn("approval email failed", e);
    }
  }

  return { paymentId, outcome, reason: verdict.reason, confirmations: verdict.confirmations };
}

// ---------- HTTP entry ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: any = {};
  try {
    body = await req.json();
  } catch { /* empty body ok */ }

  // ---- Authentication ----
  // Accept any of:
  //   (a) the service-role key (internal admin invocations),
  //   (b) a valid end-user JWT — that user may only verify their OWN paymentId,
  //   (c) cron mode with the project anon key in the `apikey` or Authorization header
  //       (pg_cron retry loop — read-only side effects, gated by mode==="cron").
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  const apikeyHeader = req.headers.get("apikey") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";

  const isServiceRole = bearer.length > 0 && bearer === SERVICE_ROLE;

  // For cron, ONLY accept an exact match against the service-role key or the
  // literal project anon/publishable key. Never trust decoded JWT role claims —
  // they are unsigned in this path and can be forged trivially.
  const isCronAnon =
    body?.mode === "cron" &&
    ((ANON_KEY.length > 0 && (bearer === ANON_KEY || apikeyHeader === ANON_KEY)) ||
      bearer === SERVICE_ROLE);

  let callerUserId: string | null = null;
  if (!isServiceRole && !isCronAnon && bearer && bearer !== ANON_KEY) {
    try {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${bearer}` } },
      });
      const { data, error } = await userClient.auth.getClaims(bearer);
      if (!error && data?.claims?.sub) {
        callerUserId = data.claims.sub as string;
      }
    } catch (e) {
      console.warn("getClaims failed", e);
    }
  }

  if (!isServiceRole && !isCronAnon && !callerUserId) {
    console.warn("auth_rejected", {
      mode: body?.mode,
      hasBearer: !!bearer,
      bearerLen: bearer.length,
      apikeyLen: apikeyHeader.length,
      anonLen: ANON_KEY.length,
      bearerIsAnon: bearer === ANON_KEY,
      apikeyIsAnon: apikeyHeader === ANON_KEY,
    });
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rates = await fetchUsdPrices();

  // Cron mode: scan pending payments — service role OR anon-key cron call.
  if (body?.mode === "cron") {
    if (!isServiceRole && !isCronAnon) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: rows, error } = await admin.rpc("payments_pending_verification" as any);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const results: any[] = [];
    for (const r of rows ?? []) {
      try {
        results.push(await verifyOne(r.id, rates));
      } catch (e) {
        console.error("verifyOne crashed", r.id, e);
        results.push({ paymentId: r.id, outcome: "skipped", reason: "exception" });
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    return new Response(JSON.stringify({ scanned: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Single payment mode
  const paymentId = body?.paymentId;
  if (!paymentId || typeof paymentId !== "string") {
    return new Response(JSON.stringify({ error: "paymentId required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // End users may only verify payments they own.
  if (!isServiceRole && callerUserId) {
    const { data: ownerRow, error: ownerErr } = await admin
      .from("payments")
      .select("user_id")
      .eq("id", paymentId)
      .maybeSingle();
    if (ownerErr || !ownerRow || ownerRow.user_id !== callerUserId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  try {
    const result = await verifyOne(paymentId, rates);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("verify-crypto-payment crashed", e);
    return new Response(JSON.stringify({ error: e?.message ?? "unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
