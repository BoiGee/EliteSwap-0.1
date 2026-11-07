// Client mirror of the server's pricing rule (public.quote_plan_price): list price for the
// billing period, then the better of the active sale or a valid discount code, never both.
// The server recomputes every payment, so these numbers only drive what's displayed; they
// must match it to the cent so the crypto "send exactly" amount equals what's verified.

export type BillingPeriod = "monthly" | "annual";

export interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  price_usd: number;
  price_usd_annual: number | null;
  features: string[];
  sort_order: number;
  key_duration_minutes: number | null;
  promo_percent_off: number | null;
  promo_ends_at: string | null;
  promo_label: string | null;
}

export const PUBLIC_PLAN_COLUMNS =
  "id, name, description, price_usd, price_usd_annual, features, sort_order, key_duration_minutes, promo_percent_off, promo_ends_at, promo_label";

/** Price before any discount for the period; null when that period isn't sold. */
export function listPrice(plan: PublicPlan, period: BillingPeriod): number | null {
  const v = period === "annual" ? plan.price_usd_annual : plan.price_usd;
  return v != null && Number(v) > 0 ? Number(v) : null;
}

/** The sale percentage running now (0 if none). The view already filters to active sales;
 *  the end-time check also stops a page left open past the deadline from showing it. */
export function salePercent(plan: PublicPlan, now = Date.now()): number {
  if (!plan.promo_percent_off || !plan.promo_ends_at) return 0;
  return Date.parse(plan.promo_ends_at) > now ? Number(plan.promo_percent_off) : 0;
}

export interface Quote {
  list: number;
  percent: number;
  source: "sale" | "code" | null;
  discount: number;
  final: number;
}

/** Same arithmetic as the server: discount = round(list * pct / 100, 2). */
export function quote(plan: PublicPlan, period: BillingPeriod, codePercent?: number | null): Quote | null {
  const list = listPrice(plan, period);
  if (list == null) return null;
  const sale = salePercent(plan);
  const code = codePercent ?? 0;
  const useCode = code > sale;
  const percent = useCode ? code : sale;
  const discount = Math.round(list * percent) / 100;
  return { list, percent, source: percent > 0 ? (useCode ? "code" : "sale") : null, discount, final: Math.round((list - discount) * 100) / 100 };
}

/** Studio minutes the purchase adds: annual is 12 months' worth on one key. */
export function planMinutes(plan: PublicPlan, period: BillingPeriod): number | null {
  if (!plan.key_duration_minutes) return null;
  return plan.key_duration_minutes * (period === "annual" ? 12 : 1);
}

/** How much cheaper annual is than buying 12 monthly packs at list price (whole %). */
export function annualSavingsPercent(plan: PublicPlan): number | null {
  const annual = listPrice(plan, "annual");
  const monthly = listPrice(plan, "monthly");
  if (annual == null || monthly == null) return null;
  const pct = Math.round((1 - annual / (monthly * 12)) * 100);
  return pct > 0 ? pct : null;
}

export function formatSaleEnd(iso: string | null): string | null {
  if (!iso) return null;
  // The sale ends at midnight GMT, so show the last full day, not the next morning.
  const d = new Date(Date.parse(iso) - 1000);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function hasAnnual(plans: PublicPlan[]): boolean {
  return plans.some((p) => listPrice(p, "annual") != null);
}
