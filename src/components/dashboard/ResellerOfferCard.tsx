import { Check, MessageCircle } from "lucide-react";
import { fmtUsd, type Storefront } from "@/lib/reseller";

/**
 * Shown in place of Elite Swap's own plans for customers who buy through a reseller:
 * his prices and contact. Plan checkout with Elite Swap is refused server-side for them.
 */
export default function ResellerOfferCard({ store }: { store: Storefront }) {
  return (
    <div className="glass border border-primary/30 rounded-2xl p-5 space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-heading uppercase tracking-wider text-primary">Your Elite Swap reseller</p>
        <h2 className="text-lg font-heading font-semibold text-foreground">Buy your minutes from {store.display_name}</h2>
        <p className="text-sm text-muted-foreground">
          Pay {store.display_name} for the plan you want. As soon as they record your purchase, your key appears in Step 2 below.
        </p>
        {store.contact && (
          <p className="inline-flex items-center gap-2 text-sm font-heading text-foreground bg-primary/10 border border-primary/30 rounded-full px-3 py-1 mt-1">
            <MessageCircle className="w-4 h-4 text-primary" /> {store.contact}
          </p>
        )}
      </div>
      {store.plans.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {store.plans.map((p) => (
            <div key={p.plan_id} className="rounded-xl border border-border bg-muted/10 p-4 space-y-2">
              <div className="font-heading font-semibold text-foreground">{p.name}</div>
              {p.monthly_price_usd != null && (
                <div className="text-sm"><span className="font-heading font-bold text-foreground">{fmtUsd(p.monthly_price_usd)}</span> <span className="text-xs text-muted-foreground">· {p.minutes} min</span></div>
              )}
              {p.annual_price_usd != null && (
                <div className="text-xs"><span className="font-heading font-semibold text-foreground">{fmtUsd(p.annual_price_usd)}</span> <span className="text-muted-foreground">annual · {(p.minutes * 12).toLocaleString()} min</span></div>
              )}
              {p.features && p.features.length > 0 && (
                <ul className="space-y-1 text-[11px] text-foreground/75">
                  {p.features.slice(0, 4).map((f) => (
                    <li key={f} className="flex gap-1.5"><Check className="w-3 h-3 text-primary shrink-0 mt-0.5" />{f}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{store.display_name} hasn't listed prices yet. Contact them for a quote.</p>
      )}
    </div>
  );
}
