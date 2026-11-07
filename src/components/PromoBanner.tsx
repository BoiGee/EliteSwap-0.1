import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";
import { PUBLIC_PLAN_COLUMNS, formatSaleEnd, salePercent, type PublicPlan } from "@/lib/planPricing";

interface Props {
  variant?: "hero" | "compact";
  /** Dashboard: called when the user clicks the CTA so the parent can scroll to the plans. */
  onApplyToPlan?: (code: string) => void;
}

// Advertises the running plan sale (plan_promotions). Shows nothing when no sale is active.
// The sale applies automatically at checkout, so there's no code to copy.
export default function PromoBanner({ variant = "hero", onApplyToPlan }: Props) {
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("pricing_plans_public" as any)
      .select(PUBLIC_PLAN_COLUMNS)
      .then(({ data }) => { if (!cancelled && data) setPlans(data as unknown as PublicPlan[]); });
    return () => { cancelled = true; };
  }, []);

  const onSale = plans.filter((p) => salePercent(p) > 0);
  const best = Math.max(0, ...onSale.map((p) => salePercent(p)));
  const endsIso = onSale[0]?.promo_ends_at ?? null;
  // Dismissal is remembered per sale (keyed by its end time), so the next sale shows again.
  const dismissKey = endsIso ? `promo_dismissed_sale_${endsIso}` : null;
  useEffect(() => {
    if (!dismissKey) return;
    try { if (localStorage.getItem(dismissKey) === "1") setDismissedKey(dismissKey); } catch { /* noop */ }
  }, [dismissKey]);

  if (best <= 0 || !dismissKey || dismissedKey === dismissKey) return null;

  const label = onSale[0]?.promo_label || "Sale";
  const ends = formatSaleEnd(endsIso);
  const perPlan = onSale
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((p) => `${p.name} ${salePercent(p)}% off`)
    .join(" · ");

  const handleDismiss = () => {
    setDismissedKey(dismissKey);
    try { localStorage.setItem(dismissKey, "1"); } catch { /* noop */ }
  };
  const handleCta = () => {
    if (variant === "compact" && onApplyToPlan) {
      onApplyToPlan("");
      return;
    }
    navigate(user ? "/dashboard" : "/pricing");
  };

  if (variant === "compact") {
    return (
      <div className="relative glass neon-border rounded-2xl px-4 py-3 bg-gradient-to-r from-primary/25 via-primary/15 to-primary/5 overflow-hidden">
        <button onClick={handleDismiss} aria-label="Dismiss" className="absolute top-2 right-2 text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
        <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 pr-6">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary animate-pulse-neon" />
              <span className="text-sm font-heading font-bold text-foreground">{label}: up to {best}% off every plan</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{perPlan}{ends ? ` · ends ${ends}` : ""} · applied automatically, monthly and annual</p>
          </div>
          <Button onClick={handleCta} size="sm" className="md:ml-auto bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-xs neon-glow">
            See sale prices ↓
          </Button>
        </div>
      </div>
    );
  }

  // hero variant, landing page
  return (
    <div className="relative w-full bg-gradient-to-r from-primary/30 via-primary/20 to-primary/10 border-b border-primary/40">
      <button onClick={handleDismiss} aria-label="Dismiss" className="absolute top-2 right-3 text-muted-foreground hover:text-foreground transition-colors z-10">
        <X className="w-4 h-4" />
      </button>
      <div className="max-w-6xl mx-auto px-4 py-3 md:py-3.5 flex flex-col md:flex-row items-center justify-center gap-2 md:gap-5 text-center md:text-left">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary animate-pulse-neon" />
          <span className="text-sm md:text-base font-heading font-bold text-foreground">
            {label}: up to {best}% off every plan{ends ? `, ends ${ends}` : ""}
          </span>
        </div>
        <span className="text-[11px] md:text-xs text-muted-foreground font-heading">{perPlan} · no code needed</span>
        <Button onClick={handleCta} size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold text-xs md:text-sm neon-glow">
          See sale prices →
        </Button>
      </div>
    </div>
  );
}
