import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useFiatRates } from "@/hooks/useFiatRates";
import { CurrencySelector } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";
import AppHeader from "@/components/AppHeader";
import PlanPriceBlock, { BillingPeriodToggle } from "@/components/pricing/PlanPriceBlock";
import {
  PUBLIC_PLAN_COLUMNS,
  annualSavingsPercent,
  formatSaleEnd,
  hasAnnual,
  salePercent,
  type BillingPeriod,
  type PublicPlan,
} from "@/lib/planPricing";

export default function Pricing() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const { currency } = useDisplayLocale();
  const { lastUpdated, loading: ratesLoading } = useFiatRates();

  useEffect(() => {
    supabase
      .from("pricing_plans_public" as any)
      .select(PUBLIC_PLAN_COLUMNS)
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        if (data) setPlans(data as unknown as PublicPlan[]);
        setLoading(false);
      });
  }, []);

  const bestSale = Math.max(0, ...plans.map((p) => salePercent(p)));
  const saleEnd = formatSaleEnd(plans.find((p) => salePercent(p) > 0)?.promo_ends_at ?? null);
  const bestAnnualSaving = Math.max(0, ...plans.map((p) => annualSavingsPercent(p) ?? 0)) || null;


  return (
    <div className="min-h-screen flex flex-col items-center relative overflow-hidden">
      <Helmet>
        <title>EliteSwap Pricing: Plans for Realtime AI Face Swap</title>
        <meta name="description" content="Compare EliteSwap plans and pick the realtime AI face & character swap subscription that fits your streaming setup." />
        <link rel="canonical" href="https://eliteswap.online/pricing" />
        <meta property="og:title" content="EliteSwap Pricing" />
        <meta property="og:description" content="Plans for EliteSwap realtime AI face & character swap." />
        <meta property="og:url" content="https://eliteswap.online/pricing" />
      </Helmet>
      <AppHeader active="pricing" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[120px]" />

      <main className="w-full max-w-5xl relative z-10 py-16 px-4 space-y-12">

        {/* Header */}
        <div className="text-center space-y-4">
          {bestSale > 0 && (
            <div className="inline-block rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 text-sm font-heading font-semibold text-emerald-400">
              Elite Sale: up to {bestSale}% off every plan{saleEnd ? ` · ends ${saleEnd}` : ""}
            </div>
          )}
          <h1 className="text-4xl md:text-5xl font-heading font-bold text-foreground">Choose Your Plan</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            Realtime AI character swap for your streams and calls. Buy minutes once; they never expire.
          </p>
          <div className="flex flex-col items-center gap-3 pt-2">
            {hasAnnual(plans) && <BillingPeriodToggle value={period} onChange={setPeriod} bestSavings={bestAnnualSaving} />}
            <CurrencySelector />
            {currency !== "USD" && (
              <p className="text-[11px] text-muted-foreground font-heading">
                {ratesLoading
                  ? "Fetching live rate…"
                  : lastUpdated
                  ? `Live rate · updated ${lastUpdated.toLocaleTimeString()}`
                  : "Using fallback rate"}
              </p>
            )}
          </div>
        </div>

        {loading ? (
          <div className="text-center text-primary animate-pulse font-heading text-lg">Loading plans...</div>
        ) : plans.length === 0 ? (
          <div className="text-center text-muted-foreground">No plans available yet. Check back soon!</div>
        ) : (
          <div className={`grid gap-6 ${plans.length === 1 ? "max-w-sm mx-auto" : plans.length === 2 ? "grid-cols-1 md:grid-cols-2 max-w-2xl mx-auto" : "grid-cols-1 md:grid-cols-3"}`}>
            {plans.map((plan, i) => {
              const isHighlighted = plans.length >= 3 ? i === 1 : i === plans.length - 1;
              return (
                <div
                  key={plan.id}
                  className={`glass rounded-2xl p-6 flex flex-col space-y-5 transition-transform hover:scale-[1.02] border ${
                    isHighlighted ? "border-primary/50" : "border-border"
                  }`}
                >
                  {isHighlighted && (
                    <span className="self-start text-xs bg-primary/20 text-primary px-3 py-1 rounded-full font-heading font-semibold">
                      Most Popular
                    </span>
                  )}
                  <div>
                    <h2 className="text-xl font-heading font-bold text-foreground">{plan.name}</h2>
                    {plan.description && (
                      <p className="text-sm text-muted-foreground mt-1">{plan.description}</p>
                    )}
                  </div>
                  <PlanPriceBlock plan={plan} period={period} size="lg" />
                  {plan.features?.length > 0 && (
                    <ul className="flex-1 space-y-2">
                      {plan.features.map((f, fi) => (
                        <li key={fi} className="flex items-start gap-2 text-sm text-foreground/80">
                          <span className="text-primary mt-0.5">✓</span>
                          {f}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    onClick={() => navigate("/auth")}
                    className={`w-full font-heading font-semibold py-5 ${
                      isHighlighted
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-muted/50 text-foreground hover:bg-muted"
                    }`}
                  >
                    Get Started
                  </Button>
                </div>
              );
            })}
          </div>
        )}

      </main>
    </div>

  );
}
