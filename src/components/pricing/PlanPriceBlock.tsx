import { formatFiat } from "@/components/CurrencySelector";
import { useFiatRates } from "@/hooks/useFiatRates";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";
import {
  annualSavingsPercent,
  formatSaleEnd,
  planMinutes,
  quote,
  type BillingPeriod,
  type PublicPlan,
} from "@/lib/planPricing";

export function BillingPeriodToggle({
  value,
  onChange,
  bestSavings,
}: {
  value: BillingPeriod;
  onChange: (p: BillingPeriod) => void;
  /** Largest annual saving across plans, shown on the Annual option. */
  bestSavings?: number | null;
}) {
  const option = (p: BillingPeriod, label: string) => (
    <button
      type="button"
      onClick={() => onChange(p)}
      className={`px-4 py-1.5 rounded-full text-xs font-heading font-semibold transition-colors ${
        value === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      aria-pressed={value === p}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/20 p-1">
      {option("monthly", "Monthly pack")}
      {option("annual", bestSavings ? `Annual · save up to ${bestSavings}%` : "Annual")}
    </div>
  );
}

interface Props {
  plan: PublicPlan;
  period: BillingPeriod;
  /** A validated discount code's percentage for this plan, if one is applied. */
  codePercent?: number | null;
  size?: "lg" | "md";
}

// Price area of a plan card: sale/code price with the list price struck through, the minutes
// the purchase adds, the annual saving and the sale's end date.
export default function PlanPriceBlock({ plan, period, codePercent, size = "md" }: Props) {
  const { convert } = useFiatRates();
  const { currency, locale } = useDisplayLocale();
  const q = quote(plan, period, codePercent);
  const minutes = planMinutes(plan, period);
  const money = (usd: number) => formatFiat(convert(usd, currency), currency, locale);
  const big = size === "lg" ? "text-4xl" : "text-2xl";

  if (!(Number(plan.price_usd) > 0)) {
    return (
      <div>
        <span className={`${big} font-heading font-bold text-foreground`}>Custom</span>
        <p className="text-xs text-muted-foreground mt-0.5">Priced for your volume</p>
      </div>
    );
  }
  if (!q) {
    return <p className="text-sm text-muted-foreground">{period === "annual" ? "Monthly packs only" : "Annual only"}</p>;
  }

  const saving = period === "annual" ? annualSavingsPercent(plan) : null;
  const saleEnds = q.source === "sale" ? formatSaleEnd(plan.promo_ends_at) : null;

  return (
    <div className="space-y-1">
      {q.percent > 0 && (
        <span className="inline-block text-[11px] font-heading font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">
          {q.source === "sale" ? `${plan.promo_label || "Sale"}: ${q.percent}% off` : `Code applied: ${q.percent}% off`}
        </span>
      )}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`${big} font-heading font-bold text-foreground`}>{money(q.final)}</span>
        {q.percent > 0 && <span className="text-sm text-muted-foreground line-through">{money(q.list)}</span>}
        <span className="text-xs text-muted-foreground">{period === "annual" ? "/ year" : "/ pack"}</span>
      </div>
      {currency !== "USD" && <p className="text-xs text-muted-foreground">≈ ${q.final.toFixed(2)} USD</p>}
      {minutes != null && (
        <p className="text-sm font-heading font-semibold text-primary">
          {minutes.toLocaleString()} studio minutes{period === "annual" ? " · 12 months' worth, one key" : ""}
        </p>
      )}
      {saving != null && <p className="text-[11px] text-emerald-400">Save {saving}% vs 12 monthly packs</p>}
      {saleEnds && <p className="text-[11px] text-amber-400">Sale ends {saleEnds}</p>}
    </div>
  );
}
