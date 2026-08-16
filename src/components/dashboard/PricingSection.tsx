import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useFiatRates } from "@/hooks/useFiatRates";
import { CurrencySelector, formatFiat } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";
import CouponInput, { type AppliedDiscount } from "@/components/dashboard/CouponInput";
import { trackFunnel } from "@/lib/paymentFunnel";

interface PricingPlan {
  id: string;
  name: string;
  description: string | null;
  price_usd: number;
  price_usd_annual: number | null;
  features: string[];
  sort_order: number;
}

export interface SelectedPlanInfo {
  id: string;
  name: string;
  priceUsd: number;
  billingLabel: "monthly" | "annual";
  discount?: AppliedDiscount | null;
}

interface Props {
  onSelectPlan: (plan: SelectedPlanInfo) => void;
  hasConfirmedPayment: boolean;
  prefillCode?: string | null;
  onRepurchaseModeChange?: (open: boolean) => void;
}

export default function PricingSection({ onSelectPlan, hasConfirmedPayment, prefillCode, onRepurchaseModeChange }: Props) {
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const { currency, locale } = useDisplayLocale();
  const [appliedDiscount, setAppliedDiscount] = useState<AppliedDiscount | null>(null);
  const [discountPlanId, setDiscountPlanId] = useState<string | null>(null);
  const [repurchase, setRepurchase] = useState(false);
  const purchaseUnlocked = !hasConfirmedPayment || repurchase;
  const setRepurchaseMode = (v: boolean) => {
    setRepurchase(v);
    onRepurchaseModeChange?.(v);
  };
  const { convert, lastUpdated } = useFiatRates();

  useEffect(() => {
    supabase
      .from("pricing_plans_public" as any)
      .select("id, name, description, price_usd, price_usd_annual, features, sort_order")
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        if (data) setPlans(data as unknown as PricingPlan[]);
        setLoading(false);
      });
    trackFunnel("funnel_pricing_viewed");
  }, []);

  useEffect(() => {
    if (!prefillCode || plans.length === 0) return;
    const targetIdx = plans.length >= 3 ? 1 : plans.length - 1;
    const target = plans[targetIdx];
    if (!target) return;
    setDiscountPlanId(target.id);
    supabase
      .rpc("validate_discount_code" as any, { p_code: prefillCode, p_plan_id: target.id })
      .then(({ data }) => {
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.valid) {
          setAppliedDiscount({
            code: prefillCode.toUpperCase(),
            percent_off: row.percent_off,
            discount_usd: Number(row.discount_usd),
            final_usd: Number(row.final_usd),
          });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillCode, plans]);

  const displayPrice = (plan: PricingPlan) => {
    const usd = plan.price_usd;
    const converted = convert(usd, currency);
    const usdSubtext = currency !== "USD" ? `≈ $${usd.toFixed(2)} USD` : null;
    return { display: formatFiat(converted, currency, locale), usdSubtext };
  };

  if (loading) {
    return (
      <div className="glass border border-border rounded-2xl p-6">
        <div className="text-center text-primary animate-pulse font-heading">Loading plans...</div>
      </div>
    );
  }

  if (plans.length === 0) return null;

  return (
    <div className="glass border border-border rounded-2xl p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-heading font-semibold text-foreground">Available Plans</h2>
        <div className="flex items-center gap-3">
          <CurrencySelector />
          {hasConfirmedPayment && (
            <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading">✓ Active</span>
          )}
          {hasConfirmedPayment && (
            <Button
              size="sm"
              variant={repurchase ? "outline" : "default"}
              onClick={() => setRepurchaseMode(!repurchase)}
              className="font-heading text-xs"
            >
              {repurchase ? "Cancel" : "Buy another / Upgrade"}
            </Button>
          )}
        </div>
      </div>

      {currency !== "USD" && lastUpdated && (
        <p className="text-[10px] text-muted-foreground font-heading">
          Live rate · updated {lastUpdated.toLocaleTimeString()}
        </p>
      )}

      {/* Free trial removed — paid $10 trial lives in TrialPurchaseCard above this section */}

      <div className={`grid gap-4 ${plans.length === 1 ? "" : plans.length === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-3"}`}>
        {plans.map((plan, i) => {
          const isHighlighted = plans.length >= 3 ? i === 1 : i === plans.length - 1;
          const { display, usdSubtext } = displayPrice(plan);
          const planUsd = plan.price_usd;
          const planDiscount =
            appliedDiscount && discountPlanId === plan.id ? appliedDiscount : null;
          const discountedDisplay = planDiscount
            ? formatFiat(convert(planDiscount.final_usd, currency), currency, locale)
            : null;
          const finalUsdForButton = planDiscount ? planDiscount.final_usd : planUsd;
          return (
            <div
              key={plan.id}
              className={`rounded-xl p-4 flex flex-col space-y-3 transition-transform hover:scale-[1.01] ${
                isHighlighted ? "border border-primary/50 bg-primary/5" : "border border-border bg-muted/10"
              }`}
            >
              {isHighlighted && (
                <span className="self-start text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading font-semibold">
                  Popular
                </span>
              )}
              <div>
                <h3 className="text-base font-heading font-bold text-foreground">{plan.name}</h3>
                {plan.description && <p className="text-xs text-muted-foreground mt-0.5">{plan.description}</p>}
              </div>
              <div>
                {discountedDisplay ? (
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-2xl font-heading font-bold text-foreground">{discountedDisplay}</span>
                    <span className="text-sm text-muted-foreground line-through">{display}</span>
                  </div>
                ) : (
                  <span className="text-2xl font-heading font-bold text-foreground">{display}</span>
                )}
                {usdSubtext && <p className="text-xs text-muted-foreground mt-0.5">{usdSubtext}</p>}
              </div>
              {plan.features?.length > 0 && (
                <ul className="flex-1 space-y-1">
                  {plan.features.map((f, fi) => (
                    <li key={fi} className="flex items-start gap-1.5 text-xs text-foreground/80">
                      <span className="text-primary mt-0.5">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
              {purchaseUnlocked && (
                <div className="space-y-2">
                  {planDiscount && (
                    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-center">
                      <p className="text-xs font-heading font-semibold text-emerald-400">
                        ✓ {planDiscount.code} applied — you pay ${planDiscount.final_usd.toFixed(2)}
                      </p>
                      <p className="text-[10px] text-emerald-400/80 mt-0.5">
                        Saved ${planDiscount.discount_usd.toFixed(2)} ({planDiscount.percent_off}% off)
                      </p>
                    </div>
                  )}
                  <Button
                    onClick={() => {
                      trackFunnel("funnel_plan_selected", { plan_id: plan.id, plan_name: plan.name });
                      trackFunnel("funnel_payment_method_chosen", { method: "crypto", plan_id: plan.id });
                      onSelectPlan({
                        id: plan.id,
                        name: plan.name,
                        priceUsd: planUsd,
                        billingLabel: "monthly",
                        discount: planDiscount,
                      });
                    }}
                    size="sm"
                    className={`w-full font-heading font-semibold text-xs ${
                      isHighlighted
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-muted/50 text-foreground hover:bg-muted"
                    }`}
                  >
                    Pay with Crypto — ${finalUsdForButton.toFixed(2)}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {purchaseUnlocked && plans.length > 0 && (
        <div className="pt-2 border-t border-border space-y-2">
          <p className="text-xs text-muted-foreground font-heading">
            Have a discount code? Pick a plan below, then apply.
          </p>
          <div className="flex flex-wrap gap-2">
            {plans.map((p) => (
              <button
                key={p.id}
                onClick={() => { setDiscountPlanId(p.id); setAppliedDiscount(null); }}
                className={`px-3 py-1 rounded-full text-xs font-heading transition-all ${
                  discountPlanId === p.id
                    ? "bg-primary/20 text-primary border border-primary/40"
                    : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
          {discountPlanId && (
            <CouponInput
              planId={discountPlanId}
              planUsd={plans.find((x) => x.id === discountPlanId)?.price_usd ?? null}
              applied={appliedDiscount}
              onApply={setAppliedDiscount}
            />
          )}
        </div>
      )}
    </div>
  );
}
