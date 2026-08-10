import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Copy, Check, X, Sparkles } from "lucide-react";

const PROMO_CODE = "ES966900";
const DISMISS_KEY = `promo_dismissed_${PROMO_CODE}`;

interface Props {
  variant?: "hero" | "compact";
  /** Dashboard: called when user clicks CTA so parent can scroll + prefill coupon */
  onApplyToPlan?: (code: string) => void;
}

export default function PromoBanner({ variant = "hero", onApplyToPlan }: Props) {
  const [percentOff, setPercentOff] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });
  const [copied, setCopied] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc("get_promo_code_status" as any, { p_code: PROMO_CODE })
      .then(({ data }) => {
        if (cancelled) return;
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.percent_off) setPercentOff(row.percent_off);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(PROMO_CODE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: "Code copied! 📋", description: `${PROMO_CODE} is in your clipboard.` });
    } catch {
      toast({ title: "Couldn't copy", description: "Please copy the code manually.", variant: "destructive" });
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
  };

  const handleCta = () => {
    if (variant === "compact" && onApplyToPlan) {
      onApplyToPlan(PROMO_CODE);
      return;
    }
    if (user) {
      navigate("/dashboard");
    } else {
      navigate("/auth?redirect=pricing");
    }
  };

  if (!loaded || percentOff == null || dismissed) return null;

  const headline =
    variant === "hero"
      ? `Limited offer — ${percentOff}% off your first plan`
      : `Save ${percentOff}% on any plan today`;

  if (variant === "compact") {
    return (
      <div className="relative glass neon-border rounded-2xl px-4 py-3 bg-gradient-to-r from-primary/25 via-primary/15 to-primary/5 overflow-hidden">
        <button
          onClick={handleDismiss}
          aria-label="Dismiss promo"
          className="absolute top-2 right-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 pr-6">
          <div className="flex items-center gap-2 shrink-0">
            <Sparkles className="w-4 h-4 text-primary animate-pulse-neon" />
            <span className="text-sm font-heading font-bold text-foreground">{headline}</span>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <button
              onClick={handleCopy}
              className="group inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/60 border border-primary/50 hover:border-primary transition-colors"
              aria-label="Copy discount code"
            >
              <span className="font-mono text-sm font-bold tracking-wider text-primary">{PROMO_CODE}</span>
              {copied ? (
                <Check className="w-3.5 h-3.5 text-primary" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary" />
              )}
            </button>
            <Button
              onClick={handleCta}
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-xs neon-glow"
            >
              Apply to a plan ↓
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // hero variant — landing page
  return (
    <div className="relative w-full bg-gradient-to-r from-primary/30 via-primary/20 to-primary/10 border-b border-primary/40">
      <button
        onClick={handleDismiss}
        aria-label="Dismiss promo"
        className="absolute top-2 right-3 text-muted-foreground hover:text-foreground transition-colors z-10"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="max-w-6xl mx-auto px-4 py-3 md:py-3.5 flex flex-col md:flex-row items-center justify-center gap-3 md:gap-5 text-center md:text-left">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary animate-pulse-neon" />
          <span className="text-sm md:text-base font-heading font-bold text-foreground">
            {headline}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="group inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/70 border border-primary/60 hover:border-primary transition-colors"
          aria-label="Copy discount code"
        >
          <span className="font-mono text-sm md:text-base font-bold tracking-wider text-primary">{PROMO_CODE}</span>
          {copied ? (
            <Check className="w-4 h-4 text-primary" />
          ) : (
            <Copy className="w-4 h-4 text-muted-foreground group-hover:text-primary" />
          )}
        </button>
        <Button
          onClick={handleCta}
          size="sm"
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-xs md:text-sm neon-glow"
        >
          Claim & start now →
        </Button>
        <span className="text-[10px] md:text-xs text-muted-foreground font-heading">
          Apply at checkout · Limited redemptions
        </span>
      </div>
    </div>
  );
}
