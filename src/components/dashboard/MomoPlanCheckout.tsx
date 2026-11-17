import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, Copy, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { rpc, rpcErrorMessage } from "@/lib/db";
import { trackFunnel } from "@/lib/paymentFunnel";
import SupportChatButtons from "./SupportChatButtons";

export interface MomoPlanTarget {
  planId: string;
  planName: string;
  billingPeriod: "monthly" | "annual";
  /** A discount code the customer applied (the sale applies on its own). */
  discountCode: string | null;
}

interface Quote {
  quote_id: string;
  plan_name: string;
  billing_period: "monthly" | "annual";
  amount_usd: number;
  discount_percent: number;
  fx_rate: number;
  rate_date: string;
  amount_ghs: number;
  momo_number: string;
  momo_network: string;
  momo_name: string;
}

const ghs = (n: number) => `GHS ${Number(n).toLocaleString("en-GH", { maximumFractionDigits: 0 })}`;

/**
 * Pay a plan by Mobile Money. The server prices it in cedis (plan price incl. sale/code x today's
 * rate, rounded up) and locks that amount; "I've sent it" files a pending payment for an admin to
 * approve, which issues the key.
 */
export default function MomoPlanCheckout({ target, onClose, onSubmitted }: { target: MomoPlanTarget | null; onClose: () => void; onSubmitted: () => void }) {
  const { toast } = useToast();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [proof, setProof] = useState<"phone" | "id">("phone");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!target) return;
    setQuote(null); setError(null); setDone(false); setProof("phone"); setReference("");
    setLoading(true);
    trackFunnel("funnel_payment_method_chosen", { method: "momo", plan_id: target.planId });
    rpc<Quote>("quote_momo_plan", { p_plan_id: target.planId, p_billing_period: target.billingPeriod, p_discount_code: target.discountCode })
      .then(({ data, error: e }) => {
        if (e || !data) setError(rpcErrorMessage(e, "Couldn't price this plan in cedis. Try again in a minute."));
        else setQuote(data);
        setLoading(false);
      });
  }, [target]);

  const submit = async () => {
    if (!quote) return;
    setSubmitting(true);
    const { error: e } = await rpc("submit_momo_plan_payment", {
      p_quote_id: quote.quote_id,
      p_sender_phone: proof === "phone" ? phone : null,
      p_sender_name: proof === "phone" ? name || null : null,
      p_reference: proof === "id" ? reference : null,
    });
    setSubmitting(false);
    if (e) { toast({ title: "Couldn't send that", description: rpcErrorMessage(e), variant: "destructive" }); return; }
    trackFunnel("funnel_tx_hash_submitted", { currency: "GHS", method: "momo" });
    setDone(true);
    onSubmitted();
  };

  const copy = (t: string, what: string) => {
    navigator.clipboard?.writeText(t);
    toast({ title: `${what} copied` });
  };

  const canSubmit = proof === "phone" ? phone.replace(/\D/g, "").length >= 9 : reference.trim().length >= 6;
  const chatMessage = quote
    ? `Hi Elite Swap, I'm paying ${ghs(quote.amount_ghs)} by Mobile Money for ${quote.plan_name}${quote.billing_period === "annual" ? " (annual)" : ""}.${phone ? ` From ${phone}.` : ""}`
    : "Hi Elite Swap, I have a question about paying by Mobile Money.";

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {quote ? `Pay ${ghs(quote.amount_ghs)} with Mobile Money` : `Pay ${target?.planName ?? "your plan"} with Mobile Money`}
          </DialogTitle>
          <DialogDescription>
            {quote
              ? <>{quote.plan_name}{quote.billing_period === "annual" ? " (annual)" : ""}: ${Number(quote.amount_usd).toFixed(2)}{quote.discount_percent > 0 ? ` (${quote.discount_percent}% off)` : ""} at today's rate, 1 USD = {Number(quote.fx_rate).toFixed(2)} GHS.</>
              : "Working out today's price in cedis…"}
          </DialogDescription>
        </DialogHeader>

        {loading && <div className="py-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>}
        {error && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <SupportChatButtons message="Hi Elite Swap, I want to pay my plan by Mobile Money." />
          </div>
        )}

        {quote && (done ? (
          <div className="rounded-lg border border-primary/40 bg-primary/10 p-4 space-y-3 text-center">
            <CheckCircle2 className="h-8 w-8 text-primary mx-auto" />
            <p className="text-sm">Thanks! We're matching your payment now, usually within the hour. Your new key appears in Step 2 of your dashboard as soon as it's confirmed.</p>
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">Want to check on it? Message us:</p>
              <SupportChatButtons message={chatMessage} className="justify-center" />
            </div>
            <Button size="sm" className="w-full" onClick={onClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-heading font-semibold">1. Send exactly {ghs(quote.amount_ghs)} to</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-2xl font-bold tracking-wide flex-1">{quote.momo_number}</p>
                <Button size="sm" variant="outline" className="gap-1 shrink-0" onClick={() => copy(quote.momo_number, "Number")}><Copy className="h-3.5 w-3.5" />Copy</Button>
              </div>
              <p className="text-xs text-muted-foreground">{quote.momo_network} · name shows as <span className="text-foreground">{quote.momo_name}</span></p>
              <div className="flex items-center justify-between border-t border-border pt-2">
                <span className="text-xs text-muted-foreground">Amount</span>
                <span className="flex items-center gap-1">
                  <span className="font-mono font-semibold">{ghs(quote.amount_ghs)}</span>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => copy(String(quote.amount_ghs), "Amount")}><Copy className="h-3 w-3" /></Button>
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">This amount is held for you for 3 days.</p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-heading font-semibold">2. Tell us it's sent</p>
              {proof === "phone" ? (
                <>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="The number you paid from, e.g. 024 123 4567" inputMode="tel" />
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name on that MoMo account (optional)" />
                  <button type="button" className="text-[11px] text-primary underline" onClick={() => setProof("id")}>I have the transaction ID instead</button>
                </>
              ) : (
                <>
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID from your MoMo SMS" className="font-mono text-xs" />
                  <button type="button" className="text-[11px] text-primary underline" onClick={() => setProof("phone")}>I don't have the ID: use my number instead</button>
                </>
              )}
              <Button className="w-full" disabled={submitting || !canSubmit} onClick={submit}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "I've sent it"}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground">Questions before you pay?</span>
              <SupportChatButtons message={chatMessage} />
            </div>
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
}
