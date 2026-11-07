import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useFiatRates } from "@/hooks/useFiatRates";
import { CurrencySelector } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";
import CouponInput, { type AppliedDiscount } from "@/components/dashboard/CouponInput";
import { trackFunnel } from "@/lib/paymentFunnel";
import GatewayCheckoutButton from "@/components/dashboard/GatewayCheckoutButton";
import PlanPriceBlock, { BillingPeriodToggle } from "@/components/pricing/PlanPriceBlock";
import {
  PUBLIC_PLAN_COLUMNS,
  annualSavingsPercent,
  hasAnnual,
  listPrice,
  quote,
  type BillingPeriod,
  type PublicPlan,
} from "@/lib/planPricing";

type PricingPlan = PublicPlan;

export interface SelectedPlanInfo {
  id: string;
  name: string;
  /** List price for the billing period, before any sale or code. */
  priceUsd: number;
  billingLabel: BillingPeriod;
  /** The sale or code that applies (the better of the two), as the server will charge it. */
  discount?: AppliedDiscount | null;
}

/** Builds the selection the crypto / gateway checkout uses from a plan, period and optional code. */
export function selectionFor(plan: PublicPlan, period: BillingPeriod, code?: AppliedDiscount | null): SelectedPlanInfo | null {
  const q = quote(plan, period, code?.percent_off ?? null);
  if (!q) return null;
  const discount: AppliedDiscount | null =
    q.source === "code" && code
      ? { ...code, discount_usd: q.discount, final_usd: q.final }
      : q.source === "sale"
        ? { code: "", label: plan.promo_label || "Sale", percent_off: q.percent, discount_usd: q.discount, final_usd: q.final }
        : null;
  return { id: plan.id, name: plan.name, priceUsd: q.list, billingLabel: period, discount };
}

interface Props {
  onSelectPlan: (plan: SelectedPlanInfo) => void;
  hasConfirmedPayment: boolean;
  prefillCode?: string | null;
  onRepurchaseModeChange?: (open: boolean) => void;
  /** Set by the dashboard ("Repurchase to Launch Studio", studio "Top up") to unlock the plans. */
  repurchaseRequested?: boolean;
  /** Called when a Mobile Money / card payment is confirmed. */
  onGatewayPaid?: () => void;
}

export default function PricingSection({ onSelectPlan, hasConfirmedPayment, prefillCode, onRepurchaseModeChange, repurchaseRequested, onGatewayPaid }: Props) {
  const [gatewayEnabled, setGatewayEnabled] = useState(false);
  useEffect(() => {
    supabase.rpc("payment_options" as any).then(({ data }) => setGatewayEnabled(!!(data as any)?.gateway_checkout));
  }, []);
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriodState] = useState<BillingPeriod>("monthly");
  const { currency } = useDisplayLocale();
  const [appliedDiscount, setAppliedDiscount] = useState<AppliedDiscount | null>(null);
  const [discountPlanId, setDiscountPlanId] = useState<string | null>(null);
  const [repurchase, setRepurchase] = useState(false);
  const purchaseUnlocked = !hasConfirmedPayment || repurchase;
  const setRepurchaseMode = (v: boolean) => {
    setRepurchase(v);
    onRepurchaseModeChange?.(v);
  };
  const { lastUpdated } = useFiatRates();
  // A code was validated against one period's price; switching period drops it so the
  // shown price can't disagree with what the server charges.
  const setPeriod = (p: BillingPeriod) => {
    setPeriodState(p);
    setAppliedDiscount(null);
  };

  // The dashboard's own repurchase flag never reached this component, so "Repurchase to
  // Launch Studio" said "pick a plan below" while the plans stayed locked.
  useEffect(() => {
    if (repurchaseRequested) setRepurchase(true);
  }, [repurchaseRequested]);

  useEffect(() => {
    supabase
      .from("pricing_plans_public" as any)
      .select(PUBLIC_PLAN_COLUMNS)
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
      .rpc("validate_discount_code" as any, { p_code: prefillCode, p_plan_id: target.id, p_billing_period: period })
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
        <div className="flex items-center gap-3 flex-wrap">
          {hasAnnual(plans) && (
            <BillingPeriodToggle
              value={period}
              onChange={setPeriod}
              bestSavings={Math.max(0, ...plans.map((p) => annualSavingsPercent(p) ?? 0)) || null}
            />
          )}
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

      {/* Free trial removed; paid $10 trial lives in TrialPurchaseCard above this section */}

      <div className={`grid gap-4 ${plans.length === 1 ? "" : plans.length === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-3"}`}>
        {plans.map((plan, i) => {
          const isHighlighted = plans.length >= 3 ? i === 1 : i === plans.length - 1;
          const planUsd = plan.price_usd;
          const planDiscount =
            appliedDiscount && discountPlanId === plan.id ? appliedDiscount : null;
          const selection = selectionFor(plan, period, planDiscount);
          const codeWins = !!selection?.discount && selection.discount.code !== "";
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
              <PlanPriceBlock plan={plan} period={period} codePercent={planDiscount?.percent_off ?? null} />
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
              {!(Number(planUsd) > 0) ? (
                // 18 crypto payments were submitted against this $0 plan (16 rejected): it had the
                // same "Pay with Crypto" button as the priced plans. It's a conversation, not a checkout.
                <Button
                  onClick={() => window.dispatchEvent(new CustomEvent("open-support-chat", {
                    detail: { message: `Hi! I'm interested in the ${plan.name} plan. My expected monthly usage is: ` },
                  }))}
                  size="sm"
                  variant="outline"
                  className="w-full font-heading font-semibold text-xs"
                >
                  Message us for a quote
                </Button>
              ) : purchaseUnlocked && selection && (
                <div className="space-y-2">
                  {gatewayEnabled && (
                    <GatewayCheckoutButton
                      planId={plan.id}
                      planName={plan.name}
                      discountCode={codeWins ? planDiscount?.code ?? null : null}
                      billingPeriod={period}
                      onPaid={onGatewayPaid}
                      className={`w-full font-heading font-semibold text-xs ${isHighlighted ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}`}
                    />
                  )}
                  {planDiscount && codeWins && selection.discount && (
                    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-center">
                      <p className="text-xs font-heading font-semibold text-emerald-400">
                        ✓ {planDiscount.code} applied: you pay ${selection.discount.final_usd.toFixed(2)}
                      </p>
                      <p className="text-[10px] text-emerald-400/80 mt-0.5">
                        Saved ${selection.discount.discount_usd.toFixed(2)} ({planDiscount.percent_off}% off)
                      </p>
                    </div>
                  )}
                  {planDiscount && !codeWins && (
                    <p className="text-[11px] text-muted-foreground text-center">
                      The sale price is already better than {planDiscount.code}, so the sale applies.
                    </p>
                  )}
                  <Button
                    onClick={() => {
                      trackFunnel("funnel_plan_selected", { plan_id: plan.id, plan_name: plan.name });
                      trackFunnel("funnel_payment_method_chosen", { method: "crypto", plan_id: plan.id });
                      onSelectPlan(selection);
                    }}
                    size="sm"
                    className={`w-full font-heading font-semibold text-xs ${
                      isHighlighted
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-muted/50 text-foreground hover:bg-muted"
                    }`}
                  >
                    Pay with Crypto: ${(selection.discount?.final_usd ?? selection.priceUsd).toFixed(2)}
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
              planUsd={(() => { const p = plans.find((x) => x.id === discountPlanId); return p ? listPrice(p, period) : null; })()}
              billingPeriod={period}
              applied={appliedDiscount}
              onApply={setAppliedDiscount}
            />
          )}
        </div>
      )}
    </div>
  );
}
