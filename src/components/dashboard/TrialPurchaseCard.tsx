import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Copy, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useFiatRates } from "@/hooks/useFiatRates";
import { formatFiat } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";

const TRIAL_USD = 10;
const TRIAL_GHS = 150;

interface Props {
  onTrialActivated: () => void;
  remaining: number | null;
}

type UsdtNetwork = "USDT-BEP20" | "USDT-TRC20";
type ManualKind = "usdt" | "momo";

interface ManualPurchase {
  kind: ManualKind;
  purchase_id: string;
  network: UsdtNetwork | null;
  label: string;
  address: string;
  recipientName?: string;
  amount: number;
  amountUnit: string;
}

const USDT_LABELS: Record<UsdtNetwork, string> = {
  "USDT-BEP20": "USDT (BEP-20)",
  "USDT-TRC20": "USDT (TRC20)",
};

export default function TrialPurchaseCard({ onTrialActivated, remaining }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState<null | "choose" | "manual">(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<ManualPurchase | null>(null);
  const [usdtNetwork, setUsdtNetwork] = useState<UsdtNetwork>("USDT-BEP20");
  const [txHash, setTxHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pendingBadge, setPendingBadge] = useState(false);
  const { currency, locale } = useDisplayLocale();
  const { convert } = useFiatRates();
  const trialDisplay = formatFiat(convert(TRIAL_USD, currency), currency, locale);
  const trialUsdSubtext = currency !== "USD" ? ` (≈ $${TRIAL_USD} USD)` : "";

  // Resume any pending USDT or manual-MoMo purchase (page refresh / deep-link / notification click).
  const resumePending = async (purchaseId?: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    let q = supabase
      .from("trial_purchases")
      .select("id,usdt_network,usdt_address,created_at,provider_reference,status,payment_method")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .in("payment_method", ["usdt", "momo_manual"])
      .is("provider_reference", null)
      .gt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    if (purchaseId) q = q.eq("id", purchaseId) as typeof q;
    const { data } = await q.maybeSingle();
    if (!data) {
      setPendingBadge(false);
      return;
    }
    setTxHash("");
    setVerifyMsg(null);
    setConfirmClose(false);
    if (data.payment_method === "momo_manual") {
      // Momo details are a fixed constant on the server — refetch via the
      // same reuse-a-fresh-pending-row path startMomo already uses, instead
      // of duplicating the number/network/name here.
      await startMomo();
      return;
    }
    setPendingBadge(true);
    const net = (data.usdt_network || "USDT-BEP20") as UsdtNetwork;
    setUsdtNetwork(net);
    setManual({
      kind: "usdt",
      purchase_id: data.id,
      network: net,
      label: USDT_LABELS[net] || "USDT",
      address: data.usdt_address || "",
      amount: TRIAL_USD,
      amountUnit: "USDT",
    });
    setOpen("manual");
  };

  // On mount: handle deep-link resume and background pending check.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Deep link from reminder notification
    const resumeId = params.get("resume_trial");
    if (resumeId) {
      params.delete("resume_trial");
      const q = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
      resumePending(resumeId);
    } else {
      // Silent check for any pending USDT/MoMo purchase awaiting a reference
      resumePending();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startUsdt = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-trial-purchase", {
        body: { method: "usdt", network: usdtNetwork },
      });
      if (error || !data?.purchase_id) {
        const code = (data as any)?.code;
        const msg = (data as any)?.message || error?.message || "Could not start trial purchase.";
        toast({ title: code === "LIMIT_REACHED" ? "Trial limit reached" : "Unavailable", description: msg, variant: "destructive" });
        return;
      }
      const net = ((data as any).network || usdtNetwork) as UsdtNetwork;
      setManual({
        kind: "usdt",
        purchase_id: (data as any).purchase_id,
        network: net,
        label: (data as any).label || USDT_LABELS[net],
        address: (data as any).address,
        amount: (data as any).amount_usdt ?? TRIAL_USD,
        amountUnit: "USDT",
      });
      setTxHash("");
      setVerifyMsg(null);
      setConfirmClose(false);
      setPendingBadge(true);
      setOpen("manual");
    } finally {
      setBusy(false);
    }
  };

  const startMomo = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-trial-purchase", {
        body: { method: "momo_manual" },
      });
      if (error || !data?.purchase_id) {
        const code = (data as any)?.code;
        const msg = (data as any)?.message || error?.message || "Could not start trial purchase.";
        toast({ title: code === "LIMIT_REACHED" ? "Trial limit reached" : "Unavailable", description: msg, variant: "destructive" });
        return;
      }
      setManual({
        kind: "momo",
        purchase_id: (data as any).purchase_id,
        network: null,
        label: (data as any).momo_network || "Mobile Money",
        address: (data as any).momo_number || "",
        recipientName: (data as any).momo_name || "",
        amount: (data as any).amount_ghs ?? TRIAL_GHS,
        amountUnit: "GHS",
      });
      setTxHash("");
      setVerifyMsg(null);
      setConfirmClose(false);
      setPendingBadge(true);
      setOpen("manual");
    } finally {
      setBusy(false);
    }
  };

  const submitTxHash = async () => {
    if (!manual || !txHash.trim()) return;
    setVerifying(true);
    setVerifyMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("verify-trial-payment", {
        body: { purchase_id: manual.purchase_id, tx_hash: txHash.trim() },
      });
      if (error) {
        setVerifyMsg(error.message || "Verification failed");
        return;
      }
      if (data?.status === "confirmed") {
        toast({ title: "Trial activated 🎁", description: "4 minutes of studio time is ready." });
        setOpen(null);
        setManual(null);
        setTxHash("");
        setPendingBadge(false);
        onTrialActivated();
        return;
      }
      if (data?.code === "REPLAY") {
        setVerifyMsg(
          manual.kind === "momo"
            ? "This transaction ID was already used for another trial."
            : "This transaction was already used for another trial."
        );
        return;
      }
      if (manual.kind === "momo") {
        // Manual MoMo never auto-confirms — every submission is routed to admin review.
        setPendingBadge(false);
        setVerifyMsg("Reference saved ✓ — we'll manually verify your Mobile Money payment, usually within a few hours. You can close this window.");
        return;
      }
      if (data?.hash_saved) {
        setPendingBadge(false); // hash is now on record; auto-confirm will finish it
        setVerifyMsg("Hash saved ✓ — we'll auto-confirm within a couple of minutes once the network indexes it. You can close this window.");
      } else {
        setVerifyMsg(`Not confirmed yet (${data?.reason || "pending"}). Try again in 30 seconds.`);
      }
    } finally {
      setVerifying(false);
    }
  };

  const cancelPurchase = async () => {
    if (!manual) return;
    setCancelling(true);
    try {
      const { data, error } = await supabase.functions.invoke("cancel-trial-purchase", {
        body: { purchase_id: manual.purchase_id },
      });
      if (error || (data && (data as any).code && !(data as any).ok)) {
        toast({
          title: "Could not cancel",
          description: (data as any)?.message || error?.message || "Try again.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Purchase cancelled", description: "No charge on our side. Start again anytime." });
      setOpen(null);
      setManual(null);
      setTxHash("");
      setConfirmClose(false);
      setPendingBadge(false);
    } finally {
      setCancelling(false);
    }
  };

  const copy = (t: string) => {
    navigator.clipboard?.writeText(t);
    toast({ title: "Copied" });
  };

  const hashSaved = !!verifyMsg && (verifyMsg.startsWith("Hash saved") || verifyMsg.startsWith("Reference saved"));
  const mustKeepOpen = !!manual && !hashSaved && !txHash.trim();

  const handleManualOpenChange = (v: boolean) => {
    if (v) return;
    if (mustKeepOpen) {
      // Intercept close — show inline confirm instead of closing.
      setConfirmClose(true);
      return;
    }
    setOpen(null);
    setConfirmClose(false);
  };

  if (remaining !== null && remaining <= 0) return null;

  return (
    <>
      <div className="rounded-xl p-4 border border-primary/40 bg-gradient-to-br from-primary/10 to-primary/5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-heading font-bold text-foreground">4-Minute Trial</h3>
            <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading font-semibold">
              {trialDisplay}
            </span>
            {remaining !== null && (
              <span className="text-[10px] text-muted-foreground">{remaining} of 2 left</span>
            )}
            {pendingBadge && (
              <span className="text-[10px] bg-amber-500/20 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full font-heading font-semibold flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Reference pending
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Pay {trialDisplay}{trialUsdSubtext} to unlock one 4-minute realtime face-swap session. USDT or Mobile Money.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            variant={pendingBadge ? "default" : "outline"}
            disabled={busy}
            onClick={() => (pendingBadge ? resumePending() : setOpen("choose"))}
            className="font-heading font-semibold text-xs"
          >
            {pendingBadge ? "Finish trial — paste reference" : `Start Trial — ${trialDisplay}`}
          </Button>
        </div>
      </div>

      <Dialog open={open === "choose"} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Choose payment method</DialogTitle>
            <DialogDescription>{trialDisplay}{trialUsdSubtext} = one 4-minute trial session</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-heading font-semibold text-sm">USDT (crypto)</span>
                <select
                  value={usdtNetwork}
                  onChange={(e) => setUsdtNetwork(e.target.value as UsdtNetwork)}
                  className="text-xs bg-background border border-border rounded px-2 py-1"
                >
                  <option value="USDT-BEP20">BEP-20</option>
                  <option value="USDT-TRC20">TRC-20</option>
                </select>
              </div>
              <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
                ⚠ After sending, you must paste your transaction hash (TXID) here. No TXID = no trial.
              </p>
              <Button size="sm" className="w-full" disabled={busy} onClick={startUsdt}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Pay with USDT"}
              </Button>
            </div>
            <div className="rounded-lg border border-border p-3 space-y-2">
              <span className="font-heading font-semibold text-sm">Mobile Money (GHS {TRIAL_GHS})</span>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Manual transfer — we'll show you the number to send to. After sending, paste your transaction ID here. No transaction ID = no trial.
              </p>
              <Button size="sm" className="w-full" disabled={busy} onClick={startMomo}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Pay via Mobile Money"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "manual"} onOpenChange={handleManualOpenChange}>
        <DialogContent
          className="sm:max-w-md max-h-[90vh] overflow-y-auto"
          onInteractOutside={(e) => { if (mustKeepOpen) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (mustKeepOpen) e.preventDefault(); }}
        >

          <DialogHeader>
            <DialogTitle>
              {manual?.kind === "momo"
                ? `Send GHS ${manual?.amount} via ${manual?.label}`
                : `Send $${manual?.amount} ${manual?.label}`}
            </DialogTitle>
            <DialogDescription>
              {manual?.kind === "momo"
                ? "Send the exact amount, then paste the Mobile Money transaction ID below."
                : "Send the exact amount, then paste the transaction hash below."}
            </DialogDescription>
          </DialogHeader>
          {manual && (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex gap-2 items-start">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-300 leading-snug">
                  <strong>Do not close this window without pasting your {manual.kind === "momo" ? "transaction ID" : "TXID"}.</strong> Without it, we cannot confirm your trial and your {manual.kind === "momo" ? `GHS ${manual.amount}` : `$${TRIAL_USD}`} will sit unmatched.
                </p>
              </div>

              <div className="rounded-lg bg-muted/30 p-3 space-y-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Network</p>
                <p className="text-sm font-mono">{manual.kind === "momo" ? manual.label : manual.network}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-2">
                  {manual.kind === "momo" ? "Number" : "Address"}
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-xs font-mono break-all flex-1">{manual.address}</p>
                  <Button size="sm" variant="ghost" onClick={() => copy(manual.address)}>
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
                {manual.kind === "momo" && manual.recipientName && (
                  <>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-2">Registered name</p>
                    <p className="text-xs">{manual.recipientName}</p>
                  </>
                )}
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-2">Amount</p>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-mono flex-1">{manual.amount} {manual.amountUnit}</p>
                  <Button size="sm" variant="ghost" onClick={() => copy(String(manual.amount))}>
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-heading">
                  Transaction {manual.kind === "momo" ? "ID" : "hash"} <span className="text-destructive">*</span>
                </label>
                <Input
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder={manual.kind === "momo" ? "e.g. MP240815.1234.A56789" : "0x... or TRON hash"}
                  className="font-mono text-xs"
                  autoFocus
                />
                <Button size="sm" className="w-full" disabled={verifying || !txHash.trim()} onClick={submitTxHash}>
                  {verifying ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Verifying…</> : "Verify Payment"}
                </Button>
                {verifyMsg && <p className="text-xs text-muted-foreground">{verifyMsg}</p>}
              </div>

              {confirmClose && mustKeepOpen && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                  <p className="text-xs font-heading font-semibold">You haven't submitted a reference yet.</p>
                  <p className="text-[11px] text-muted-foreground">
                    If you already sent the payment, paste the {manual.kind === "momo" ? "transaction ID" : "TXID"} above so we can confirm it. Otherwise cancel this purchase — no charge on our side.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmClose(false)}>
                      Paste reference now
                    </Button>
                    <Button size="sm" variant="destructive" className="flex-1" disabled={cancelling} onClick={cancelPurchase}>
                      {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel purchase"}
                    </Button>
                  </div>
                </div>
              )}

              {hashSaved && (
                <Button size="sm" variant="outline" className="w-full" onClick={() => { setOpen(null); setManual(null); }}>
                  Close
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
