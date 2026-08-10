import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { notifyAdminPaymentEvent } from "@/lib/adminNotify";

// Conversion-tuned note presets. Selecting one auto-fills the textarea
// but the admin can still edit before sending.
const APPROVE_PRESETS: { id: string; label: string; note: string }[] = [
  {
    id: "default",
    label: "Standard welcome",
    note:
      "Thanks for upgrading to EliteSwap — your account is fully unlocked and ready to go. Jump back in any time and reach out if you'd like a hand getting the most out of it. Welcome aboard!",
  },
  {
    id: "fast",
    label: "Quick & friendly",
    note:
      "Payment confirmed — you're in! Your full access is active right now. Enjoy EliteSwap, and reply to this email any time if you need a hand.",
  },
  {
    id: "vip",
    label: "VIP / high-value",
    note:
      "Thanks so much for upgrading — really appreciate you choosing EliteSwap. Your account is fully unlocked. If you'd ever like a quick walkthrough of the advanced features, just reply to this email and we'll set it up personally.",
  },
];

const REJECT_PRESETS: { id: string; label: string; note: string }[] = [
  {
    id: "general",
    label: "General (safe default)",
    note:
      "Thanks for trying to upgrade your EliteSwap account — we really appreciate it. We weren't able to verify this particular payment, but no funds are stuck and your account is safe. The fastest fix is to retry with a different method (card and mobile money confirm instantly), or reply to this email with your transaction reference and a team member will personally unlock your access today. We're not going anywhere — let's get you in.",
  },
  {
    id: "tx_invalid",
    label: "Crypto: tx hash invalid / not found",
    note:
      "Thanks for upgrading! We checked the blockchain but couldn't find the transaction hash you sent — it may have been mistyped or the transfer didn't go through. Just resend with the correct hash and we'll unlock your account within minutes. If you'd rather pay by card or mobile money, that works instantly too.",
  },
  {
    id: "wrong_amount",
    label: "Crypto: wrong amount sent",
    note:
      "Thanks for your payment! The amount we received doesn't match the plan price, so we couldn't auto-activate your account. Reply to this email with your transaction hash and we'll sort it out manually today — no need to send anything extra.",
  },
  {
    id: "tx_dropped",
    label: "Crypto: transaction never confirmed",
    note:
      "Your transaction never confirmed on the network — this happens occasionally with low gas fees. No funds have been deducted from you. Try again with the same or a different method and you'll be up and running in a couple of minutes.",
  },
  {
    id: "duplicate",
    label: "Suspected duplicate payment",
    note:
      "Looks like this payment may be a duplicate of one we already processed — we don't want to charge you twice! Reply here and we'll double-check your account status right away.",
  },
];

interface Payment {
  id: string;
  user_id: string;
  currency: string;
  amount_usd: number | null;
  tx_hash: string | null;
  payment_method?: string;
  status: string;
}

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

interface PricingPlan {
  id: string;
  name: string;
  price_usd: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: "confirmed" | "rejected" | null;
  payment: Payment | null;
  profile: Profile | null;
  onComplete: () => void;
}

const NOTE_MAX = 1000;

export default function PaymentActionDialog({
  open, onOpenChange, action, payment, profile, onComplete,
}: Props) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [presetId, setPresetId] = useState<string>("");
  const [sendEmail, setSendEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [amountUsd, setAmountUsd] = useState("");
  const [verification, setVerification] = useState<{
    outcome: string;
    reason: string | null;
    confirmations: number | null;
    on_chain_amount: number | null;
    attempted_at: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    supabase
      .from("pricing_plans")
      .select("id, name, price_usd")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data }) => setPlans((data ?? []) as unknown as PricingPlan[]));
  }, [open]);

  useEffect(() => {
    if (!open || !payment) {
      setVerification(null);
      return;
    }
    setSelectedPlanId((payment as any).plan_id ?? "");
    setAmountUsd(payment.amount_usd != null ? String(payment.amount_usd) : "");
    // Latest on-chain verification attempt (if any) for context.
    supabase
      .from("payment_verification_attempts" as any)
      .select("outcome,reason,confirmations,on_chain_amount,attempted_at")
      .eq("payment_id", payment.id)
      .order("attempted_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setVerification((data as any) ?? null));
  }, [open, payment]);

  if (!payment || !action) return null;

  const isApprove = action === "confirmed";
  const presets = isApprove ? APPROVE_PRESETS : REJECT_PRESETS;
  const reference = payment.tx_hash || "—";
  // Defensive, not currently load-bearing: every real row in `payments` has
  // payment_method='crypto' today (paystack/momo only exists on the
  // separate trial_purchases flow), but hardcoding this regardless of the
  // actual field would silently mislabel the admin UI and the customer
  // email the moment that ever changes.
  const method = payment.payment_method === "crypto" || !payment.payment_method ? "Crypto" : payment.payment_method;

  const handlePresetChange = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (preset) setNote(preset.note);
  };

  const handlePlanChange = (id: string) => {
    setSelectedPlanId(id);
    const plan = plans.find((p) => p.id === id);
    if (plan) setAmountUsd(String(Number(plan.price_usd)));
  };

  const handleConfirm = async () => {
    const parsedAmount = amountUsd.trim() ? Number(amountUsd) : null;
    if (isApprove && (parsedAmount === null || !Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
      toast({ title: "Plan amount required", description: "Choose a plan or enter the USD amount before approving.", variant: "destructive" });
      return;
    }
    setSaving(true);
    // 1. Update status through the guarded backend path so partner earnings can always resolve.
    // p_suppress_notify: true — this dialog always sends its own richer
    // email below (step 2), so the generic DB-trigger fallback would
    // otherwise race it for the same customer send.
    const { error: updateError } = await supabase.rpc("admin_set_payment_status" as any, {
      p_payment_id: payment.id,
      p_status: action,
      p_plan_id: isApprove && selectedPlanId ? selectedPlanId : null,
      p_amount_usd: isApprove ? parsedAmount : null,
      p_suppress_notify: true,
    });
    if (updateError) {
      toast({ title: "Error", description: updateError.message, variant: "destructive" });
      setSaving(false);
      return;
    }

    // 1b. Fire-and-forget admin alert (separate from the user-facing email).
    // skipUserEmail: true — step 2 below is this dialog's own richer send.
    notifyAdminPaymentEvent({
      paymentId: payment.id,
      eventType: isApprove ? "admin_confirmed" : "admin_rejected",
      userEmail: profile?.email ?? null,
      userDisplayName: profile?.display_name ?? null,
      amountUsd: payment.amount_usd,
      currency: payment.currency,
      paymentMethod: method,
      reference,
      skipUserEmail: true,
    });

    // 2. Optional user-facing email
    if (sendEmail && profile?.email) {
      try {
        const { error: emailError } = await supabase.functions.invoke("send-transactional-email", {
          body: {
            templateName: isApprove ? "payment-approved" : "payment-rejected",
            recipientEmail: profile.email,
            idempotencyKey: `payment-${payment.id}-${action}`,
            templateData: {
              displayName: profile.display_name || profile.email.split("@")[0],
              amountUsd: payment.amount_usd,
              paymentMethod: method,
              reference,
              adminNote: note.trim() || undefined,
            },
          },
        });
        if (emailError) throw emailError;
        toast({ title: `Payment ${action} ✅`, description: "User notified by email." });
      } catch (e: any) {
        toast({
          title: `Payment ${action}`,
          description: `Status updated, but email failed: ${e?.message ?? "unknown error"}`,
          variant: "destructive",
        });
      }
    } else {
      toast({ title: `Payment ${action} ✅` });
    }

    setSaving(false);
    setNote("");
    setPresetId("");
    setSendEmail(true);
    onOpenChange(false);
    onComplete();
  };

  const placeholder = isApprove
    ? "e.g. Thanks for your purchase — your account is fully unlocked. Enjoy EliteSwap!"
    : "e.g. We could not verify the transaction reference. Please re-send with the correct hash, or try a different payment method.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-heading">
            {isApprove ? "Approve payment" : "Reject payment"}
          </DialogTitle>
          <DialogDescription>
            {isApprove
              ? "Confirm this payment and (optionally) email the user."
              : "Mark this payment as rejected and (optionally) tell the user why."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="glass rounded-lg p-3 space-y-1.5 text-xs">
            <Row label="User" value={profile?.email ?? payment.user_id.slice(0, 8)} />
            <Row label="Amount" value={payment.amount_usd != null ? `$${payment.amount_usd.toFixed(2)} USD` : "—"} />
            <Row label="Method" value={method} />
            <Row label="Reference" value={reference} mono />
          </div>

          {verification && (
            <div
              className={`rounded-lg p-3 text-xs space-y-1 border ${
                verification.outcome === "confirmed"
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : verification.outcome === "mismatch"
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-amber-500/40 bg-amber-500/10"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-heading font-semibold">
                  On-chain check:{" "}
                  {verification.outcome === "confirmed"
                    ? "✅ matched"
                    : verification.outcome === "mismatch"
                    ? "⚠ mismatch"
                    : "⏳ pending"}
                </span>
                <span className="text-muted-foreground">
                  {new Date(verification.attempted_at).toLocaleString()}
                </span>
              </div>
              <div className="text-muted-foreground">
                Reason: <span className="text-foreground">{verification.reason ?? "—"}</span>
                {verification.confirmations != null && (
                  <> · Confirms: <span className="text-foreground">{verification.confirmations}</span></>
                )}
                {verification.on_chain_amount != null && (
                  <> · Received: <span className="text-foreground">${Number(verification.on_chain_amount).toFixed(2)}</span></>
                )}
              </div>
            </div>
          )}

          {isApprove && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg bg-muted/30 p-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground font-heading">Plan paid for</Label>
                <Select value={selectedPlanId} onValueChange={handlePlanChange}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Select plan…" />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-sm">
                        {p.name} — ${Number(p.price_usd).toFixed(2)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground font-heading">Amount USD</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amountUsd}
                  onChange={(e) => setAmountUsd(e.target.value)}
                  className="h-9 text-sm"
                  placeholder="0.00"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2">
            <Label htmlFor="send-email" className="text-sm font-heading">
              Send email notification to user
            </Label>
            <Switch id="send-email" checked={sendEmail} onCheckedChange={setSendEmail} />
          </div>

          <div className={sendEmail ? "space-y-2" : "opacity-40 pointer-events-none space-y-2"}>
            <div>
              <Label className="text-xs text-muted-foreground font-heading mb-1 block">
                Reason preset {isApprove ? "(welcome tone)" : "(rejection reason)"}
              </Label>
              <Select value={presetId} onValueChange={handlePresetChange}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Pick a preset to auto-fill the note…" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-sm">
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground font-heading mb-1 block">
                Note ({note.length}/{NOTE_MAX}) — fully editable
              </Label>
              <Textarea
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                placeholder={placeholder}
                rows={6}
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Shown inside the branded EliteSwap email as a highlighted message.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={saving}
            className={isApprove
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
          >
            {saving ? "Saving..." : isApprove ? "Approve & Notify" : "Reject & Notify"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground font-heading">{label}</span>
      <span className={`text-foreground text-right break-all ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}
