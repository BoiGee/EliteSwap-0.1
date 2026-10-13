import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { readFunctionError } from "@/lib/adminData";

interface Props {
  planId: string;
  planName: string;
  discountCode?: string | null;
  className?: string;
  onPaid?: () => void;
}

type Phase = "idle" | "opening" | "waiting" | "paid" | "failed";

// Mobile Money (MTN, Telecel, AirtelTigo) or card through OGateway's hosted checkout, in GHS.
// The checkout opens in a new tab; this dialog waits for the payment, asking the server to read
// its status from OGateway every few seconds, so it doesn't depend on the webhook arriving.
export default function GatewayCheckoutButton({ planId, planName, discountCode, className, onPaid }: Props) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<{ paymentId: string; url: string; ghs: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(() => stopPolling, []);

  const start = async () => {
    // Open the tab inside the click, before any await, or browsers block it as a popup.
    const tab = window.open("", "_blank");
    setPhase("opening");
    setMessage(null);
    const { data, error } = await supabase.functions.invoke("create-plan-checkout", {
      body: { plan_id: planId, discount_code: discountCode ?? null },
    });
    if (error || !data?.checkout_url) {
      tab?.close();
      const msg = error ? (await readFunctionError(error)).message : "Couldn't open the checkout";
      setPhase("idle");
      toast({ title: "Payment couldn't start", description: msg, variant: "destructive" });
      return;
    }
    setInfo({ paymentId: data.payment_id, url: data.checkout_url, ghs: data.amount_ghs });
    if (tab) {
      tab.opener = null;
      tab.location.href = data.checkout_url;
    }
    setPhase("waiting");

    const startedAt = Date.now();
    stopPolling();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > 20 * 60_000) {
        stopPolling();
        setMessage("Still waiting. If you paid, it will confirm by itself shortly and we'll email you.");
        return;
      }
      const { data: res } = await supabase.functions.invoke("verify-ogateway-payment", { body: { payment_id: data.payment_id } });
      const state = res?.state;
      if (state === "confirmed" || (state === "already" && res?.status === "confirmed")) {
        stopPolling();
        setPhase("paid");
        onPaid?.();
      } else if (state === "closed") {
        stopPolling();
        setPhase("failed");
        setMessage(res?.ogStatus === "CANCELLED" ? "The payment was cancelled." : "The payment didn't go through. No money was taken; you can try again.");
      } else if (state === "mismatch") {
        stopPolling();
        setPhase("failed");
        setMessage("We received a payment that doesn't match this plan. Our team will look into it and contact you.");
      }
    }, 5000);
  };

  const close = () => {
    stopPolling();
    setPhase("idle");
    setInfo(null);
    setMessage(null);
  };

  return (
    <>
      <Button onClick={start} disabled={phase === "opening"} size="sm" className={className}>
        {phase === "opening" ? "Opening checkout…" : "Pay with Mobile Money or Card"}
      </Button>
      <Dialog open={phase === "waiting" || phase === "paid" || phase === "failed"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading">
              {phase === "paid" ? "Payment received 🎉" : phase === "failed" ? "Payment not completed" : `Paying for ${planName}`}
            </DialogTitle>
            <DialogDescription>
              {phase === "paid"
                ? "Your unique key is ready in your dashboard. A receipt is on its way to your email."
                : phase === "failed"
                  ? message
                  : `Finish paying GH₵${info?.ghs.toFixed(2) ?? ""} in the checkout tab. Approve the prompt on your phone if you chose Mobile Money. This window updates by itself.`}
            </DialogDescription>
          </DialogHeader>
          {phase === "waiting" && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" /> Waiting for your payment…
              </div>
              {message && <p className="text-xs text-muted-foreground">{message}</p>}
              {info?.url && (
                <a href={info.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline">
                  Checkout tab didn't open? Open it here
                </a>
              )}
            </div>
          )}
          <Button variant={phase === "paid" ? "default" : "outline"} onClick={close} className="font-heading">
            {phase === "paid" ? "Done" : "Close"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
