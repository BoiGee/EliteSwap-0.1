import { memo, useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "./ui/button";
import { useToast } from "@/hooks/use-toast";
import { useCryptoPrices } from "@/hooks/useCryptoPrices";
import { useFiatRates } from "@/hooks/useFiatRates";
import { CurrencySelector, formatFiat } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";
import { trackFunnel } from "@/lib/paymentFunnel";

export type PayCurrency = "BTC" | "BNB" | "USDT-BEP20" | "USDT-TRC20";

type Wallet = {
  name: string;
  symbol: string;
  ticker: string; // short label on tab
  currencyCode: PayCurrency; // sent to backend
  network: string;
  address: string;
  icon: string;
  color: string;
  warning: string;
  coinId: "bitcoin" | "binancecoin" | null; // null = use fixedUsdPrice
  fixedUsdPrice?: number;
  decimals: number;
};

const WALLETS: Wallet[] = [
  {
    name: "Bitcoin",
    symbol: "BTC",
    ticker: "BTC",
    currencyCode: "BTC",
    network: "Bitcoin Network",
    address: "1EuGLFCfRVd2p4VwpjWHhBKtZbMc8Wbcv7",
    icon: "₿",
    color: "from-amber-500 to-orange-600",
    warning: "Send only BTC on the Bitcoin network.",
    coinId: "bitcoin",
    decimals: 8,
  },
  {
    name: "BNB",
    symbol: "BNB",
    ticker: "BNB",
    currencyCode: "BNB",
    network: "BNB Smart Chain (BEP-20)",
    address: "0x15a62f46355f03b66c30e88dad4564dd69a3aab7",
    icon: "◆",
    color: "from-yellow-400 to-yellow-600",
    warning: "Send only BNB on the BEP-20 Smart Chain network.",
    coinId: "binancecoin",
    decimals: 6,
  },
  {
    name: "USDT (BEP-20)",
    symbol: "USDT",
    ticker: "USDT·BEP20",
    currencyCode: "USDT-BEP20",
    network: "BNB Smart Chain (BEP-20)",
    address: "0x15a62f46355f03b66c30e88dad4564dd69a3aab7",
    icon: "₮",
    color: "from-emerald-500 to-emerald-600",
    warning: "Send only USDT on the BEP-20 (BNB Smart Chain) network. Sending on any other network will result in permanent loss.",
    coinId: null,
    fixedUsdPrice: 1,
    decimals: 2,
  },
  {
    name: "USDT (TRC20)",
    symbol: "USDT",
    ticker: "USDT·TRC20",
    currencyCode: "USDT-TRC20",
    network: "Tron Network (TRC20)",
    address: "TMzkn5dm1Ehzg5KUF8uNcB1N9Y5FjzadF8",
    icon: "₮",
    color: "from-emerald-500 to-emerald-600",
    warning: "Send only USDT on the TRC20 (Tron) network. Sending on any other network will result in permanent loss.",
    coinId: null,
    fixedUsdPrice: 1,
    decimals: 2,
  },
];

function formatUsd(price: number | null): string {
  if (price === null) return "...";
  return price.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatCrypto(amount: number, decimals: number): string {
  // Trim trailing zeros while keeping enough precision
  return amount.toFixed(decimals).replace(/\.?0+$/, "");
}

interface AppliedDiscount {
  code: string;
  percent_off: number;
  discount_usd: number;
  final_usd: number;
}

interface SelectedPlan {
  id: string;
  name: string;
  priceUsd: number;
  billingLabel?: string; // e.g. "monthly" or "annual"
  discount?: AppliedDiscount | null;
}

interface Props {
  onClose: () => void;
  selectedPlan?: SelectedPlan | null;
  onSubmitHash?: (hash: string, currency: PayCurrency) => Promise<boolean>;
}

function CryptoPaymentImpl({ onClose, selectedPlan, onSubmitHash }: Props) {
  const [selected, setSelected] = useState(0);
  const { currency, locale } = useDisplayLocale();
  const [txHash, setTxHash] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const wallet = WALLETS[selected];
  const prices = useCryptoPrices(30000); // refresh every 30s for accuracy
  const { convert, lastUpdated: fxUpdated } = useFiatRates(30000);

  const currentUsdPrice = wallet.coinId ? prices[wallet.coinId] : (wallet.fixedUsdPrice ?? null);
  // Wallet unit price in selected currency (for display: "1 BTC = X")
  const currentFiatPrice = currentUsdPrice !== null ? convert(currentUsdPrice, currency) : null;

  // Compute amount to send for the selected plan (apply discount if present)
  const discount = selectedPlan?.discount ?? null;
  const planUsd = selectedPlan
    ? (discount ? discount.final_usd : selectedPlan.priceUsd)
    : null;
  const originalUsd = selectedPlan?.priceUsd ?? null;
  const planFiat = planUsd !== null ? convert(planUsd, currency) : null;
  const cryptoAmount =
    planUsd !== null && currentUsdPrice !== null && currentUsdPrice > 0
      ? planUsd / currentUsdPrice
      : null;

  // Funnel checkpoint: user reached the QR / pay-with-crypto screen
  useEffect(() => {
    trackFunnel("funnel_crypto_qr_viewed", {
      plan_id: selectedPlan?.id ?? null,
      plan_name: selectedPlan?.name ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyAddress = () => {
    navigator.clipboard.writeText(wallet.address);
    trackFunnel("funnel_crypto_address_copied", { wallet: wallet.symbol });
    toast({ title: "Address copied! 📋" });
  };

  const copyAmount = () => {
    if (cryptoAmount === null) return;
    const amt = formatCrypto(cryptoAmount, wallet.decimals);
    navigator.clipboard.writeText(amt);
    toast({ title: `Amount copied: ${amt} ${wallet.symbol} 📋` });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-background/80 backdrop-blur-sm p-4 overflow-y-auto overscroll-contain">
      <div className="glass neon-border rounded-2xl w-full max-w-md relative my-8 max-h-[calc(100vh-4rem)] overflow-y-auto">
        <div className="sticky top-0 z-10 flex justify-end px-4 pt-3 pb-1 bg-[hsl(220_18%_8%/0.95)] backdrop-blur-sm rounded-t-2xl">
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground text-lg leading-none">✕</button>
        </div>
        <div className="px-6 pb-6 pt-2 space-y-5">



        <div className="text-center space-y-1">
          <h2 className="text-2xl font-heading font-bold gradient-text">Pay with Crypto</h2>
          {selectedPlan ? (
            <p className="text-xs text-muted-foreground">
              {selectedPlan.name}
              {selectedPlan.billingLabel ? ` · ${selectedPlan.billingLabel}` : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Select your preferred currency below</p>
          )}
        </div>

        <div className="flex justify-center">
          <CurrencySelector />
        </div>

        {/* Crypto tabs with live unit price */}
        <div className="grid grid-cols-2 gap-2">
          {WALLETS.map((w, i) => {
            const usd = w.coinId ? prices[w.coinId] : (w.fixedUsdPrice ?? null);
            const fiat = usd !== null ? convert(usd, currency) : null;
            return (
              <button
                key={w.currencyCode}
                onClick={() => setSelected(i)}
                className={`py-2.5 rounded-xl font-heading font-semibold text-xs transition-all ${
                  selected === i
                    ? "bg-primary/20 text-primary neon-border"
                    : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                }`}
              >
                <span className="mr-1.5">{w.icon}</span>
                {w.ticker}
                {fiat !== null && (
                  <span className="block text-[10px] font-normal opacity-70">{formatFiat(fiat, currency, locale)}</span>
                )}
              </button>
            );
          })}
        </div>


        {/* AMOUNT TO SEND — primary call-to-action when a plan is selected */}
        {selectedPlan && (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-heading text-center">
              Order summary
            </p>

            {/* Breakdown */}
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Plan ({selectedPlan.name})</span>
                <span className={discount ? "text-muted-foreground line-through" : "text-foreground"}>
                  {formatUsd(originalUsd)}
                </span>
              </div>
              {discount && (
                <div className="flex justify-between text-emerald-400">
                  <span>Discount ({discount.code} · −{discount.percent_off}%)</span>
                  <span>−{formatUsd(discount.discount_usd)}</span>
                </div>
              )}
              <div className="flex justify-between pt-1 border-t border-border/50">
                <span className="font-heading font-semibold text-foreground">Total</span>
                <span className="font-heading font-bold text-primary text-base">{formatUsd(planUsd)}</span>
              </div>
            </div>

            <div className="border-t border-border/50 pt-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-heading text-center mb-2">
                Send exactly
              </p>
              {cryptoAmount !== null ? (
                <>
                  <div className="text-center">
                    <div className="text-3xl font-heading font-bold text-foreground">
                      {formatCrypto(cryptoAmount, wallet.decimals)}{" "}
                      <span className="text-xl text-primary">{wallet.symbol}</span>
                    </div>
                    {planFiat !== null && planUsd !== null && (
                      <p className="text-sm text-muted-foreground mt-1">
                        ≈ {formatFiat(planFiat, currency, locale)}
                        {currency !== "USD" && (
                          <span className="text-xs"> · {formatUsd(planUsd)}</span>
                        )}
                      </p>
                    )}
                  </div>
                  <Button
                    onClick={copyAmount}
                    size="sm"
                    variant="outline"
                    className="w-full font-heading text-xs border-primary/40 hover:bg-primary/10 mt-2"
                  >
                    Copy Amount
                  </Button>
                </>
              ) : (
                <div className="text-center text-sm text-muted-foreground animate-pulse py-2">
                  Loading live price…
                </div>
              )}
            </div>
          </div>
        )}

        {/* Live unit price banner (always shown) */}
        {currentFiatPrice !== null && currentUsdPrice !== null && (
          <div className="text-center bg-muted/20 rounded-lg py-2 px-3">
            <p className="text-sm font-heading font-semibold text-foreground">
              1 {wallet.symbol} = {formatFiat(currentFiatPrice, currency, locale)}
            </p>
            {currency !== "USD" && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                ≈ {formatUsd(currentUsdPrice)}
              </p>
            )}
            {(prices.lastUpdated || fxUpdated) && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Live · updated {(prices.lastUpdated ?? fxUpdated)!.toLocaleTimeString()}
              </p>
            )}
          </div>
        )}

        {/* QR + address */}
        <div className="flex flex-col items-center gap-4">
          <div className="p-3 bg-foreground rounded-xl">
            <QRCodeSVG
              value={wallet.address}
              size={180}
              bgColor="hsl(210, 40%, 95%)"
              fgColor="hsl(220, 20%, 4%)"
              level="M"
            />
          </div>

          <div className="w-full space-y-2">
            <p className="text-xs font-heading text-muted-foreground uppercase tracking-wider text-center">
              {wallet.network}
            </p>
            <div
              onClick={copyAddress}
              className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2.5 text-xs font-mono text-foreground/80 break-all cursor-pointer hover:border-primary/40 transition-colors text-center"
              title="Click to copy"
            >
              {wallet.address}
            </div>
            <Button onClick={copyAddress} className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-sm">
              Copy Address
            </Button>
          </div>
        </div>

        {/* Submit transaction hash directly here — no need to scroll back */}
        {onSubmitHash && selectedPlan && (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-heading text-center">
              After sending, paste your transaction hash
            </p>
            <input
              type="text"
              placeholder={`Paste your ${wallet.symbol} transaction hash...`}
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              className="w-full bg-muted/30 border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground focus:border-primary outline-none"
            />
            <Button
              onClick={async () => {
                if (!txHash.trim() || submitting) return;
                setSubmitting(true);
                const ok = await onSubmitHash(txHash.trim(), wallet.currencyCode);
                setSubmitting(false);
                if (ok) {
                  // Fire-and-forget on-chain verification. Falls back to admin
                  // review if anything goes wrong; never blocks the UX.
                  void (async () => {
                    try {
                      const { supabase } = await import("@/integrations/supabase/client");
                      const { data: latest } = await supabase
                        .from("payments")
                        .select("id")
                        .eq("tx_hash", txHash.trim())
                        .order("created_at", { ascending: false })
                        .limit(1)
                        .maybeSingle();
                      if (latest?.id) {
                        const { data: vres } = await supabase.functions.invoke(
                          "verify-crypto-payment",
                          { body: { paymentId: latest.id } },
                        );
                        if ((vres as any)?.reason === "offchain_suspected_binance") {
                          toast({
                            title: "Sent for manual review",
                            description:
                              "Looks like a Binance internal transfer — we'll match it on the merchant Binance account and activate your key shortly.",
                          });
                        }
                      }
                    } catch (e) {
                      console.warn("[verify-crypto-payment] kick failed", e);
                    }
                  })();
                  setTxHash("");
                  onClose();
                }
              }}
              disabled={!txHash.trim() || submitting}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-sm"
            >
              {submitting ? "Submitting..." : `Submit ${wallet.symbol} Hash for Verification`}
            </Button>
            <p className="text-[10px] text-muted-foreground text-center">
              We'll verify on-chain and activate your unique key — usually within minutes.
            </p>
            <p className="text-[10px] text-muted-foreground/80 text-center leading-snug">
              Paid from <span className="font-semibold">inside Binance</span>? Paste the Binance
              <span className="font-semibold"> txId</span> from your Withdrawal History — we'll match it manually.
              Off-Binance payments must use the on-chain transaction hash.
            </p>
          </div>
        )}

        {/* Warning */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-center">
          <p className="text-xs text-amber-400 font-heading font-medium">⚠️ {wallet.warning}</p>
          <p className="text-xs text-amber-400/70 mt-1">
            Send the <span className="font-semibold">exact amount</span> shown above. Sending on a different network may result in permanent loss.
          </p>
        </div>
        </div>
      </div>
    </div>

  );
}

export const CryptoPayment = memo(CryptoPaymentImpl);

