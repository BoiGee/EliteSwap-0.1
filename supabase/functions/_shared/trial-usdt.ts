// On-chain USDT verification and confirmation notices for $10 trial purchases, shared by
// verify-trial-payment (customer at checkout) and reconcile-trial-purchases (cron retry).

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

export type UsdtVerdict = { ok: boolean; reason: string; usdt?: number; confirmations?: number };

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

export async function verifyUsdtBep20(hash: string, expectedUsd: number): Promise<UsdtVerdict> {
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

export async function verifyUsdtTrc20(hash: string, expectedUsd: number): Promise<UsdtVerdict> {
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

export function verifyTrialUsdt(network: string | null, hash: string, expectedUsd: number): Promise<UsdtVerdict> {
  return network === "USDT-TRC20" ? verifyUsdtTrc20(hash, expectedUsd) : verifyUsdtBep20(hash, expectedUsd);
}

function methodLabel(purchase: any): string {
  return purchase.payment_method === "momo_manual"
    ? "Mobile Money (manual, GHS)"
    : purchase.payment_method === "paystack"
    ? "Card or Mobile Money (GHS), legacy"
    : purchase.usdt_network === "USDT-TRC20" ? "USDT (TRC-20)" : "USDT (BEP-20)";
}

// The idempotency key is what stops a customer getting this twice when both the checkout
// verifier and the cron send it for the same purchase.
export async function sendTrialActivatedEmail(admin: any, purchase: any, userEmail: string | null | undefined, displayName: string | null | undefined): Promise<boolean> {
  if (!userEmail) return false;
  try {
    const { error } = await admin.functions.invoke("send-transactional-email", {
      body: {
        templateName: "trial-activated",
        recipientEmail: userEmail,
        idempotencyKey: `trial-activated-${purchase.id}`,
        templateData: {
          displayName: displayName ?? undefined,
          method: methodLabel(purchase),
          amountUsd: Number(purchase.amount_usd) || 10,
          durationMinutes: 4,
          reference: purchase.provider_reference || purchase.id,
          studioUrl: "https://eliteswap.online/studio",
        },
      },
    });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("[trial-usdt] trial-activated email failed", e);
    return false;
  }
}

export async function notifyAdminTrialConfirmed(admin: any, purchase: any, who: string) {
  try {
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
    console.warn("[trial-usdt] admin push failed", e);
  }
}
