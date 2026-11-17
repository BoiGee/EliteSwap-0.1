import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Copy, CheckCircle2, Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useFiatRates } from "@/hooks/useFiatRates";
import { formatFiat } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";
import { fromTable, rpc, rpcErrorMessage } from "@/lib/db";
import { START_TRIAL_EVENT } from "@/lib/support";
import SupportChatButtons from "./SupportChatButtons";

const TRIAL_USD = 10;
const TRIAL_GHS = 150;
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000; // unpaid checkouts are expired by the reconciler after 24h idle
const CONFIRMING_WINDOW_MS = 72 * 60 * 60 * 1000;

interface Props {
  onTrialActivated: () => void;
  remaining: number | null;
  /** New-user dashboard: the hero has the main button, so show this card only when a purchase is in progress. */
  compact?: boolean;
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

interface PurchaseRow {
  id: string;
  payment_method: string;
  status: string;
  created_at: string;
  provider_reference: string | null;
  usdt_network: string | null;
  usdt_address: string | null;
  customer_marked_sent_at: string | null;
}

const USDT_LABELS: Record<UsdtNetwork, string> = {
  "USDT-BEP20": "USDT (BEP-20)",
  "USDT-TRC20": "USDT (TRC20)",
};

export default function TrialPurchaseCard({ onTrialActivated, remaining, compact = false }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState<null | "choose" | "manual" | "add_id">(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<ManualPurchase | null>(null);
  const [usdtNetwork, setUsdtNetwork] = useState<UsdtNetwork>("USDT-BEP20");
  const [txHash, setTxHash] = useState("");
  const [senderPhone, setSenderPhone] = useState("");
  const [senderName, setSenderName] = useState("");
  const [momoProof, setMomoProof] = useState<"phone" | "id">("phone");
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // An unpaid checkout the customer can come back to, or one we're confirming.
  const [unfinished, setUnfinished] = useState<PurchaseRow | null>(null);
  const [confirming, setConfirming] = useState<PurchaseRow | null>(null);
  const { currency, locale } = useDisplayLocale();
  const { convert } = useFiatRates();
  const trialDisplay = formatFiat(convert(TRIAL_USD, currency), currency, locale);
  const trialUsdSubtext = currency !== "USD" ? ` (≈ $${TRIAL_USD} USD)` : "";
  const activatedRef = useRef(false);

  // Latest trial purchase still in progress: paid-and-waiting, or started-but-unpaid.
  const refreshState = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const since = new Date(Date.now() - CONFIRMING_WINDOW_MS).toISOString();
    const { data } = await fromTable("trial_purchases")
      .select("id,payment_method,status,created_at,provider_reference,usdt_network,usdt_address,customer_marked_sent_at")
      .eq("user_id", user.id)
      .in("payment_method", ["usdt", "momo_manual"])
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    const rows = (data as PurchaseRow[] | null) ?? [];
    const waiting = rows.find((r) => r.status === "pending" && (r.provider_reference || r.customer_marked_sent_at));
    const unpaid = rows.find((r) => r.status === "pending" && !r.provider_reference && !r.customer_marked_sent_at
      && Date.now() - new Date(r.created_at).getTime() < RESUME_WINDOW_MS);
    setConfirming(waiting ?? null);
    setUnfinished(waiting ? null : unpaid ?? null);
    return rows;
  }, []);

  // While a payment is being confirmed, check now and then so the trial switches on by itself.
  useEffect(() => {
    if (!confirming) return;
    const t = setInterval(async () => {
      const { data } = await fromTable("trial_purchases").select("status").eq("id", confirming.id).maybeSingle();
      if ((data as { status?: string } | null)?.status === "confirmed" && !activatedRef.current) {
        activatedRef.current = true;
        toast({ title: "Trial activated 🎁", description: "Your 4 minutes of studio time are ready." });
        setConfirming(null);
        onTrialActivated();
      }
    }, 30000);
    return () => clearInterval(t);
  }, [confirming, onTrialActivated, toast]);

  const startUsdt = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-trial-purchase", {
        body: { method: "usdt", network: usdtNetwork },
      });
      if (error || !data?.purchase_id) {
        const d = data as { code?: string; message?: string } | null;
        toast({ title: d?.code === "LIMIT_REACHED" ? "Trial limit reached" : "Unavailable", description: d?.message || error?.message || "Could not start the trial.", variant: "destructive" });
        return;
      }
      const net = ((data as { network?: string }).network || usdtNetwork) as UsdtNetwork;
      openManual({
        kind: "usdt",
        purchase_id: data.purchase_id,
        network: net,
        label: (data as { label?: string }).label || USDT_LABELS[net],
        address: (data as { address?: string }).address ?? "",
        amount: (data as { amount_usdt?: number }).amount_usdt ?? TRIAL_USD,
        amountUnit: "USDT",
      });
    } finally {
      setBusy(false);
    }
  };

  const startMomo = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-trial-purchase", { body: { method: "momo_manual" } });
      if (error || !data?.purchase_id) {
        const d = data as { code?: string; message?: string } | null;
        toast({ title: d?.code === "LIMIT_REACHED" ? "Trial limit reached" : "Unavailable", description: d?.message || error?.message || "Could not start the trial.", variant: "destructive" });
        return;
      }
      const d = data as { momo_network?: string; momo_number?: string; momo_name?: string; amount_ghs?: number };
      openManual({
        kind: "momo",
        purchase_id: data.purchase_id,
        network: null,
        label: d.momo_network || "Mobile Money",
        address: d.momo_number || "",
        recipientName: d.momo_name || "",
        amount: d.amount_ghs ?? TRIAL_GHS,
        amountUnit: "GHS",
      });
    } finally {
      setBusy(false);
    }
  };

  const openManual = (m: ManualPurchase) => {
    setManual(m);
    setTxHash("");
    setVerifyMsg(null);
    setSubmitted(false);
    setMomoProof("phone");
    setOpen("manual");
    refreshState();
  };

  // Pick up where they left off: unpaid USDT reopens the same purchase; unpaid Mobile Money
  // goes through create-trial-purchase (it reuses a fresh row, or starts a new one).
  const resumeUnfinished = async (row?: PurchaseRow | null) => {
    const r = row ?? unfinished;
    if (!r) { setOpen("choose"); return; }
    if (r.payment_method === "momo_manual") { await startMomo(); return; }
    const net = (r.usdt_network || "USDT-BEP20") as UsdtNetwork;
    setUsdtNetwork(net);
    openManual({ kind: "usdt", purchase_id: r.id, network: net, label: USDT_LABELS[net] || "USDT", address: r.usdt_address || "", amount: TRIAL_USD, amountUnit: "USDT" });
  };

  // On mount: state, plus deep links (?start_trial=1 from emails, ?resume_trial=<id> from reminders).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resumeId = params.get("resume_trial");
    const start = params.get("start_trial");
    if (resumeId || start) {
      params.delete("resume_trial");
      params.delete("start_trial");
      const q = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
    }
    refreshState().then((rows) => {
      if (!resumeId && !start) return;
      const r = rows?.find((x) => x.id === resumeId) ?? null;
      if (r && r.status === "pending" && !r.provider_reference && !r.customer_marked_sent_at) resumeUnfinished(r);
      else if (start && !rows?.some((x) => x.status === "pending" && (x.provider_reference || x.customer_marked_sent_at))) setOpen("choose");
    });
    const onStart = () => setOpen("choose");
    window.addEventListener(START_TRIAL_EVENT, onStart);
    return () => window.removeEventListener(START_TRIAL_EVENT, onStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishSubmitted = (message: string) => {
    setSubmitted(true);
    setVerifyMsg(message);
    refreshState();
  };

  // Transaction ID (Mobile Money) or hash (USDT).
  const submitTxHash = async (purchaseId: string, kind: ManualKind) => {
    if (!txHash.trim()) return;
    setVerifying(true);
    setVerifyMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("verify-trial-payment", {
        body: { purchase_id: purchaseId, tx_hash: txHash.trim() },
      });
      if (error) { setVerifyMsg(error.message || "Couldn't check that. Try again."); return; }
      if (data?.status === "confirmed") {
        toast({ title: "Trial activated 🎁", description: "Your 4 minutes of studio time are ready." });
        setOpen(null); setManual(null); setTxHash("");
        refreshState();
        onTrialActivated();
        return;
      }
      if (data?.code === "REPLAY") {
        setVerifyMsg(kind === "momo" ? "This transaction ID was already used for another trial." : "This transaction was already used for another trial.");
        return;
      }
      if (kind === "momo") {
        finishSubmitted("Thanks, we've got it. We're confirming your payment now, usually within the hour, and your 4 minutes will appear on your dashboard.");
        return;
      }
      if (data?.hash_saved) finishSubmitted("Hash saved. We confirm USDT automatically within a few minutes once the network shows it.");
      else setVerifyMsg(`Not confirmed yet (${data?.reason || "pending"}). Try again in 30 seconds.`);
    } finally {
      setVerifying(false);
    }
  };

  // Mobile Money "I've sent it": the number they paid from is enough for us to find it.
  const markMomoSent = async (purchaseId: string) => {
    setVerifying(true);
    setVerifyMsg(null);
    const { error } = await rpc("trial_momo_mark_sent", { p_purchase_id: purchaseId, p_sender_phone: senderPhone, p_sender_name: senderName || null });
    setVerifying(false);
    if (error) { setVerifyMsg(rpcErrorMessage(error, "Couldn't save that. Try again.")); return; }
    finishSubmitted("Thanks! We're matching your payment now, usually within the hour. Your 4 minutes will appear on your dashboard; you can close this window.");
  };

  const cancelPurchase = async () => {
    if (!manual) return;
    setCancelling(true);
    try {
      const { data, error } = await supabase.functions.invoke("cancel-trial-purchase", { body: { purchase_id: manual.purchase_id } });
      const d = data as { code?: string; ok?: boolean; message?: string } | null;
      if (error || (d && d.code && !d.ok)) {
        toast({ title: "Could not cancel", description: d?.message || error?.message || "Try again.", variant: "destructive" });
        return;
      }
      toast({ title: "Purchase cancelled", description: "Nothing was charged. Start again any time." });
      setOpen(null); setManual(null);
      refreshState();
    } finally {
      setCancelling(false);
    }
  };

  const copy = (t: string, what: string) => {
    navigator.clipboard?.writeText(t);
    toast({ title: `${what} copied` });
  };

  if (remaining !== null && remaining <= 0 && !confirming) return null;

  const chatMessage = `Hi Elite Swap, I've paid for the 4-minute trial${senderPhone ? ` from ${senderPhone}` : ""}. Reference: ${(manual?.purchase_id ?? confirming?.id ?? "").slice(0, 8)}`;

  const card = (() => {
    if (confirming) {
      return (
        <div className="rounded-xl p-4 border border-amber-500/40 bg-amber-500/10 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-amber-400" /><h3 className="text-base font-heading font-bold text-foreground">Confirming your trial payment</h3></div>
            <p className="text-xs text-muted-foreground mt-1">
              {confirming.payment_method === "momo_manual"
                ? "We're matching your Mobile Money payment, usually within the hour. This page switches your trial on by itself."
                : "We're confirming your USDT payment. This page switches your trial on by itself."}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {confirming.payment_method === "momo_manual" && !confirming.provider_reference && (
              <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => { setTxHash(""); setVerifyMsg(null); setSubmitted(false); setOpen("add_id"); }}>
                Add transaction ID
              </Button>
            )}
            <SupportChatButtons message={chatMessage} />
          </div>
        </div>
      );
    }
    if (compact && !unfinished) return null;
    return (
      <div className="rounded-xl p-4 border border-primary/40 bg-gradient-to-br from-primary/10 to-primary/5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-heading font-bold text-foreground">4-Minute Trial</h3>
            <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading font-semibold">{trialDisplay}</span>
            {remaining !== null && <span className="text-[10px] text-muted-foreground">{remaining} of 2 left</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {unfinished
              ? "You started a trial but we haven't received your payment yet. Finish it in a minute."
              : `Try the real thing for ${trialDisplay}${trialUsdSubtext}: one 4-minute live session. Pay by Mobile Money or USDT.`}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant={unfinished ? "default" : "outline"} disabled={busy} onClick={() => (unfinished ? resumeUnfinished() : setOpen("choose"))} className="font-heading font-semibold text-xs">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : unfinished ? "Finish my trial" : `Start Trial: ${trialDisplay}`}
          </Button>
        </div>
      </div>
    );
  })();

  return (
    <>
      {card}

      <Dialog open={open === "choose"} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Start your 4-minute trial</DialogTitle>
            <DialogDescription>{trialDisplay}{trialUsdSubtext} for one live 4-minute session. Choose how to pay.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-primary/40 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-heading font-semibold text-sm">Mobile Money</span>
                <span className="text-xs font-heading text-primary">GHS {TRIAL_GHS}</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">Send to our MoMo number, then tell us the number you paid from. We confirm it, usually within the hour.</p>
              <Button size="sm" className="w-full" disabled={busy} onClick={startMomo}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Pay with Mobile Money"}
              </Button>
            </div>
            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-heading font-semibold text-sm">USDT (crypto)</span>
                <select value={usdtNetwork} onChange={(e) => setUsdtNetwork(e.target.value as UsdtNetwork)} className="text-xs bg-background border border-border rounded px-2 py-1">
                  <option value="USDT-BEP20">BEP-20</option>
                  <option value="USDT-TRC20">TRC-20</option>
                </select>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">Send 10 USDT, then paste the transaction hash. Confirmed automatically in minutes.</p>
              <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={startUsdt}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Pay with USDT"}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
              <span className="text-[11px] text-muted-foreground">Questions before you pay?</span>
              <SupportChatButtons message="Hi Elite Swap, I have a question about the 4-minute trial." />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "manual"} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{manual?.kind === "momo" ? `Pay GHS ${manual?.amount} with Mobile Money` : `Pay ${manual?.amount} USDT`}</DialogTitle>
            <DialogDescription>
              {manual?.kind === "momo"
                ? "Two quick steps. You can close this and come back any time in the next 24 hours."
                : `Send exactly ${manual?.amount} USDT on ${manual?.network}, then paste the transaction hash so we can find it.`}
            </DialogDescription>
          </DialogHeader>
          {manual && (
            <div className="space-y-4">
              {submitted ? (
                <div className="rounded-lg border border-primary/40 bg-primary/10 p-4 space-y-3 text-center">
                  <CheckCircle2 className="h-8 w-8 text-primary mx-auto" />
                  <p className="text-sm">{verifyMsg}</p>
                  <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">Want to check on it? Message us:</p>
                    <SupportChatButtons message={chatMessage} className="justify-center" />
                  </div>
                  <Button size="sm" className="w-full" onClick={() => { setOpen(null); setManual(null); }}>Done</Button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg bg-muted/30 p-3 space-y-2">
                    {manual.kind === "momo" && <p className="text-xs font-heading font-semibold">1. Send exactly GHS {manual.amount} to</p>}
                    <div className="flex items-center gap-2">
                      <p className={`font-mono break-all flex-1 ${manual.kind === "momo" ? "text-2xl font-bold tracking-wide" : "text-xs"}`}>{manual.address}</p>
                      <Button size="sm" variant="outline" className="gap-1 shrink-0" onClick={() => copy(manual.address, manual.kind === "momo" ? "Number" : "Address")}>
                        <Copy className="h-3.5 w-3.5" />Copy
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {manual.kind === "momo"
                        ? <>{manual.label}{manual.recipientName ? <> · name shows as <span className="text-foreground">{manual.recipientName}</span></> : null}</>
                        : manual.network}
                    </p>
                    <div className="flex items-center justify-between border-t border-border pt-2">
                      <span className="text-xs text-muted-foreground">Amount</span>
                      <span className="flex items-center gap-1">
                        <span className="font-mono font-semibold">{manual.amount} {manual.amountUnit}</span>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => copy(String(manual.amount), "Amount")}><Copy className="h-3 w-3" /></Button>
                      </span>
                    </div>
                  </div>

                  {manual.kind === "momo" ? (
                    <div className="space-y-2">
                      <p className="text-xs font-heading font-semibold">2. Tell us it's sent</p>
                      {momoProof === "phone" ? (
                        <>
                          <Input value={senderPhone} onChange={(e) => setSenderPhone(e.target.value)} placeholder="The number you paid from, e.g. 024 123 4567" inputMode="tel" />
                          <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Name on that MoMo account (optional)" />
                          <Button size="sm" className="w-full" disabled={verifying || senderPhone.replace(/\D/g, "").length < 9} onClick={() => markMomoSent(manual.purchase_id)}>
                            {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : "I've sent it"}
                          </Button>
                          <button type="button" className="text-[11px] text-primary underline" onClick={() => setMomoProof("id")}>I have the transaction ID instead</button>
                        </>
                      ) : (
                        <>
                          <Input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Transaction ID from your MoMo SMS" className="font-mono text-xs" />
                          <Button size="sm" className="w-full" disabled={verifying || !txHash.trim()} onClick={() => submitTxHash(manual.purchase_id, "momo")}>
                            {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit transaction ID"}
                          </Button>
                          <button type="button" className="text-[11px] text-primary underline" onClick={() => setMomoProof("phone")}>I don't have the ID: use my number instead</button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Transaction hash: 0x… or TRON hash" className="font-mono text-xs" />
                      <Button size="sm" className="w-full" disabled={verifying || !txHash.trim()} onClick={() => submitTxHash(manual.purchase_id, "usdt")}>
                        {verifying ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Checking…</> : "Submit hash"}
                      </Button>
                    </div>
                  )}
                  {verifyMsg && <p className="text-xs text-destructive">{verifyMsg}</p>}
                  <button type="button" className="text-[11px] text-muted-foreground underline" disabled={cancelling} onClick={cancelPurchase}>
                    {cancelling ? "Cancelling…" : "Cancel this purchase"}
                  </button>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={open === "add_id"} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add your transaction ID</DialogTitle>
            <DialogDescription>Optional: it's in the SMS Mobile Money sent you, and helps us confirm your payment faster.</DialogDescription>
          </DialogHeader>
          {submitted ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="h-8 w-8 text-primary mx-auto" />
              <p className="text-sm">{verifyMsg}</p>
              <Button size="sm" className="w-full" onClick={() => setOpen(null)}>Done</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Transaction ID" className="font-mono text-xs" />
              <Button size="sm" className="w-full" disabled={verifying || !txHash.trim() || !confirming} onClick={() => confirming && submitTxHash(confirming.id, "momo")}>
                {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit"}
              </Button>
              {verifyMsg && <p className="text-xs text-destructive">{verifyMsg}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
