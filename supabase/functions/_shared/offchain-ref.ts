// Shared off-chain/Binance-internal-transfer detector.
// Used by verify-crypto-payment (main payments) and verify-trial-payment
// ($10 trials) so both flows apply the exact same heuristic and neither can
// drift out of sync with the other or with the admin UI's display copy
// (src/components/admin/PaymentManager.tsx mirrors this on the client side
// purely for the "Binance off-chain" badge — it never gates confirmation).
//
// Detects references that can never appear on a public blockchain:
//   - Binance internal transfers between two Binance accounts
//   - Cash App / Strike / exchange withdrawal IDs
// These look nothing like real on-chain tx hashes, so we can rule them out
// by shape before calling any explorer. Returns true => skip on-chain checks
// and route the payment straight to admin manual review.
export function isOffchainRef(currency: string, raw: string): boolean {
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
