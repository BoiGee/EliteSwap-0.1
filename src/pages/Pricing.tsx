import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useFiatRates } from "@/hooks/useFiatRates";
import { CurrencySelector, formatFiat } from "@/components/CurrencySelector";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";


interface PricingPlan {
  id: string;
  name: string;
  description: string | null;
  price_usd: number;
  price_usd_annual: number | null;
  features: string[];
  sort_order: number;
}

export default function Pricing() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const { currency, locale } = useDisplayLocale();
  const { convert, lastUpdated, loading: ratesLoading } = useFiatRates();

  useEffect(() => {
    supabase
      .from("pricing_plans_public" as any)
      .select("id, name, description, price_usd, price_usd_annual, features, sort_order")
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        if (data) setPlans(data as unknown as PricingPlan[]);
        setLoading(false);
      });
  }, []);

  const displayPrice = (plan: PricingPlan) => {
    const usd = plan.price_usd;
    const converted = convert(usd, currency);
    return {
      display: formatFiat(converted, currency, locale),
      usdSubtext: currency !== "USD" ? `≈ $${usd.toFixed(2)} USD` : null,
    };
  };


  return (
    <div className="min-h-screen flex flex-col items-center p-4 relative overflow-hidden">
      <Helmet>
        <title>EliteSwap Pricing — Plans for Realtime AI Face Swap</title>
        <meta name="description" content="Compare EliteSwap plans and pick the realtime AI face & character swap subscription that fits your streaming setup." />
        <link rel="canonical" href="https://eliteswap.online/pricing" />
        <meta property="og:title" content="EliteSwap Pricing" />
        <meta property="og:description" content="Plans for EliteSwap realtime AI face & character swap." />
        <meta property="og:url" content="https://eliteswap.online/pricing" />
      </Helmet>
      <div className="absolute inset-0 scanline pointer-events-none opacity-30" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[120px]" />

      <main className="w-full max-w-5xl relative z-10 py-16 space-y-12">

        {/* Header */}
        <div className="text-center space-y-4">
          <button onClick={() => navigate("/")} className="text-3xl font-heading font-bold gradient-text mb-2">Elite Swap</button>
          <h1 className="text-4xl md:text-5xl font-heading font-bold text-foreground">Choose Your Plan</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            Unlock realtime AI character swap with the plan that fits your needs.
          </p>
          <div className="flex flex-col items-center gap-2 pt-2">
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
              const { display, usdSubtext } = displayPrice(plan);
              return (
                <div
                  key={plan.id}
                  className={`glass rounded-2xl p-6 flex flex-col space-y-5 transition-transform hover:scale-[1.02] ${
                    isHighlighted ? "neon-border ring-1 ring-primary/30" : "border border-border"
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
                  <div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-heading font-bold text-foreground">{display}</span>
                    </div>
                    {usdSubtext && <p className="text-xs text-muted-foreground mt-1">{usdSubtext}</p>}
                  </div>
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
                        ? "bg-primary text-primary-foreground hover:bg-primary/90 neon-glow"
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

        <div className="text-center">
          <Button variant="ghost" onClick={() => navigate("/")} className="font-heading text-muted-foreground">
            ← Back to Home
          </Button>
        </div>
      </main>
    </div>

  );
}
