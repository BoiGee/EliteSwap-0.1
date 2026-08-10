import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { FUNNEL_STAGE_LABELS } from "@/lib/paymentFunnel";

export interface NudgeTarget {
  user_id: string;
  email: string;
  display_name: string | null;
  payment_funnel_stage: number;
  last_payment_nudge_sent_at: string | null;
}

interface Preset {
  id: string;
  label: string;
  forStages: number[];
  headline: string;
  body: string;
  ctaLabel: string;
  adminNote?: string;
}

const PRESETS: Preset[] = [
  {
    id: "stuck_at_pricing",
    label: "Browsed pricing — never picked a plan",
    forStages: [1],
    headline: "Still weighing your EliteSwap options?",
    body: "I noticed you checked out our plans but didn't pick one. Most folks land on the Pro plan — it's the best value if you want unlimited realtime swaps. Happy to answer any questions before you upgrade.",
    ctaLabel: "See Plans",
    adminNote: "Reply to this email if you'd like a quick walkthrough — we'll personally help you choose.",
  },
  {
    id: "stuck_at_method",
    label: "Picked a plan — no payment method chosen",
    forStages: [2, 3],
    headline: "One click away from unlocking EliteSwap",
    body: "You picked your plan — nice choice. The last step is just sending your crypto payment (BTC, BNB, or USDT on BEP-20 / TRC20) to the displayed wallet and pasting the transaction hash. It takes less than 60 seconds.",
    ctaLabel: "Finish Checkout",
  },
  {
    id: "crypto_qr_no_hash",
    label: "Saw crypto QR — never submitted hash",
    forStages: [4, 5],
    headline: "Did your crypto payment go through?",
    body: "We saw you opened the crypto payment screen but haven't submitted a transaction hash yet. If you sent the funds, just paste the hash in your dashboard and we'll confirm within minutes. If something went wrong, reply to this email and we'll sort it out — no pressure.",
    ctaLabel: "Submit My Tx Hash",
    adminNote: "Common fixes: make sure you sent on the correct network (BTC mainnet, BNB BEP-20, USDT BEP-20, or USDT TRC20) and sent the exact amount shown.",
  },
  {
    id: "tx_submitted_waiting",
    label: "Submitted hash — checking on them",
    forStages: [6],
    headline: "Your payment is being verified",
    body: "Just a heads up — we received your transaction hash and our team is verifying it on-chain. You should be activated within the next few hours. If you don't see your API key by tomorrow, reply to this email and we'll dig in.",
    ctaLabel: "Open Dashboard",
  },
  {
    id: "soft_offer",
    label: "Sweetener — 10% discount nudge",
    forStages: [1, 2, 3, 4, 5],
    headline: "A small thank-you to finish your upgrade",
    body: "We'd love to have you onboard. Use the code below at checkout for 10% off your first plan — valid for the next 7 days. No strings attached.",
    ctaLabel: "Claim 10% Off",
    adminNote: "Code: WELCOME10 — 10% off any plan, expires in 7 days.",
  },
];

const PRESET_BY_ID: Record<string, Preset> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

interface Props {
  target: NudgeTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}

const PER_PRESET_COOLDOWN_HOURS = 48;

interface HistoryRow {
  id: string;
  preset_id: string;
  subject: string | null;
  headline_snippet: string | null;
  sent_at: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = diff / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (h < 24) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

export default function PaymentNudgeDialog({ target, open, onOpenChange, onSent }: Props) {
  const { toast } = useToast();
  const [presetId, setPresetId] = useState<string>("");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("Finish Upgrade");
  const [ctaUrl, setCtaUrl] = useState("https://eliteswap.online/dashboard");
  const [adminNote, setAdminNote] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  // Load per-user nudge history when dialog opens
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("payment_nudge_history")
        .select("id, preset_id, subject, headline_snippet, sent_at")
        .eq("user_id", target.user_id)
        .order("sent_at", { ascending: false })
        .limit(20);
      if (!cancelled) setHistory((data as HistoryRow[]) || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  const handlePresetChange = (id: string) => {
    setPresetId(id);
    const preset = PRESET_BY_ID[id];
    if (!preset) return;
    setHeadline(preset.headline);
    setBody(preset.body);
    setCtaLabel(preset.ctaLabel);
    setAdminNote(preset.adminNote || "");
  };

  // Per-preset cooldown — only for the currently selected preset
  const presetCooldownRemaining = useMemo(() => {
    if (!presetId) return 0;
    const last = history.find((h) => h.preset_id === presetId);
    if (!last) return 0;
    const elapsedHrs = (Date.now() - new Date(last.sent_at).getTime()) / 3_600_000;
    return Math.max(0, PER_PRESET_COOLDOWN_HOURS - elapsedHrs);
  }, [presetId, history]);

  // Aggregate counts by preset for the header chip row
  const countsByPreset = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const h of history) counts[h.preset_id] = (counts[h.preset_id] || 0) + 1;
    return counts;
  }, [history]);

  const reset = () => {
    setPresetId("");
    setHeadline("");
    setBody("");
    setCtaLabel("Finish Upgrade");
    setCtaUrl("https://eliteswap.online/dashboard");
    setAdminNote("");
    setConfirmStep(false);
    setSending(false);
    setHistory([]);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const send = async () => {
    if (!target || !headline.trim() || !body.trim()) return;
    setSending(true);
    try {
      const idempotencyKey = `nudge-${target.user_id}-${Date.now()}`;
      const { error } = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "payment-nudge",
          recipientEmail: target.email,
          idempotencyKey,
          templateData: {
            displayName: target.display_name || undefined,
            headline,
            body,
            ctaLabel,
            ctaUrl,
            adminNote: adminNote.trim() || undefined,
          },
        },
      });
      if (error) throw error;

      // Log this nudge in history (per-preset audit) and update legacy timestamp.
      const { data: auth } = await supabase.auth.getUser();
      const sentBy = auth?.user?.id;
      if (sentBy) {
        await supabase.from("payment_nudge_history").insert({
          user_id: target.user_id,
          preset_id: presetId || "custom",
          sent_by: sentBy,
          subject: headline.slice(0, 200),
          headline_snippet: headline.slice(0, 80),
        });
      }
      await supabase
        .from("profiles")
        .update({ last_payment_nudge_sent_at: new Date().toISOString() })
        .eq("user_id", target.user_id);

      toast({ title: "Nudge sent ✉️", description: `Email queued to ${target.email}` });
      onSent?.();
      handleClose(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send";
      toast({ title: "Error", description: msg, variant: "destructive" });
      setSending(false);
    }
  };

  if (!target) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send payment nudge</DialogTitle>
          <DialogDescription>
            To <span className="font-mono">{target.email}</span> · Stage:{" "}
            <span className="text-primary font-semibold">
              {FUNNEL_STAGE_LABELS[target.payment_funnel_stage] || "Unknown"}
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* Per-preset counts */}
        {Object.keys(countsByPreset).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(countsByPreset).map(([pid, count]) => (
              <span
                key={pid}
                className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30 font-heading"
              >
                {PRESET_BY_ID[pid]?.label.split(" — ")[0] || pid} ×{count}
              </span>
            ))}
          </div>
        )}

        {/* Past nudges */}
        {history.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/10 p-2 max-h-32 overflow-y-auto space-y-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-heading px-1">
              Past nudges ({history.length})
            </p>
            {history.slice(0, 8).map((h) => (
              <div key={h.id} className="text-[11px] flex items-center gap-2 px-1">
                <span className="text-primary font-mono">{PRESET_BY_ID[h.preset_id]?.label.split(" — ")[0] || h.preset_id}</span>
                <span className="text-muted-foreground truncate flex-1">{h.headline_snippet || h.subject}</span>
                <span className="text-muted-foreground text-[10px] shrink-0">{relativeTime(h.sent_at)}</span>
              </div>
            ))}
          </div>
        )}

        {presetCooldownRemaining > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-400">
            ⚠️ This <strong>specific preset</strong> was sent{" "}
            {(PER_PRESET_COOLDOWN_HOURS - presetCooldownRemaining).toFixed(1)}h ago.
            Re-sending the same nudge may feel spammy. Cooldown for this preset expires in{" "}
            <strong>{presetCooldownRemaining.toFixed(1)}h</strong>. Other preset types are free to send.
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Preset</Label>
            <Select value={presetId} onValueChange={handlePresetChange}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a preset, or write from scratch below" />
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                {PRESETS.map((p) => {
                  const matches = p.forStages.includes(target.payment_funnel_stage);
                  const count = countsByPreset[p.id] || 0;
                  return (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        {matches && <span className="text-primary">★</span>}
                        {p.label}
                        {count > 0 && <span className="text-[10px] text-muted-foreground">(sent {count}×)</span>}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              ★ = recommended for this user's current funnel stage. Each preset has its own cooldown.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Headline</Label>
            <Input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Eye-catching one-liner for the email"
              maxLength={120}
            />
          </div>

          <div className="space-y-2">
            <Label>Body</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="The main message — be conversational, not salesy"
              maxLength={1000}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>CTA label</Label>
              <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} maxLength={40} />
            </div>
            <div className="space-y-2">
              <Label>CTA URL</Label>
              <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Admin note (optional callout box)</Label>
            <Textarea
              value={adminNote}
              onChange={(e) => setAdminNote(e.target.value)}
              rows={2}
              placeholder="e.g. discount code, special offer, support tip"
              maxLength={300}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => handleClose(false)} disabled={sending}>
            Cancel
          </Button>
          {!confirmStep ? (
            <Button
              onClick={() => setConfirmStep(true)}
              disabled={!headline.trim() || !body.trim() || sending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Review & Send
            </Button>
          ) : (
            <Button
              onClick={send}
              disabled={sending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 neon-glow"
            >
              {sending ? "Sending..." : `Confirm send to ${target.email}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
