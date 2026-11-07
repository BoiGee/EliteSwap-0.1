import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

interface Promo {
  id: string;
  plan_id: string;
  percent_off: number;
  starts_at: string;
  ends_at: string;
  label: string | null;
}

interface Plan { id: string; name: string; price_usd: number; price_usd_annual: number | null }

const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Elite Sales: per-plan, time-boxed discounts applied automatically on the pricing pages and
// at checkout (monthly and annual). The server (quote_plan_price) gives the customer the better
// of the sale or a discount code, never both, and keeps partners on their full share.
export default function PlanSalesManager() {
  const { toast } = useToast();
  const [promos, setPromos] = useState<Promo[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({ plan_id: "", percent_off: "10", starts_at: toLocalInput(new Date()), ends_at: "", label: "Elite Sale" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [p, pl] = await Promise.all([
      supabase.from("plan_promotions" as any).select("*").order("starts_at", { ascending: false }),
      supabase.from("pricing_plans").select("id, name, price_usd, price_usd_annual").gt("price_usd", 0).order("sort_order"),
    ]);
    if (p.error) toast({ title: "Sales didn't load", description: p.error.message, variant: "destructive" });
    setPromos((p.data ?? []) as unknown as Promo[]);
    setPlans((pl.data ?? []) as unknown as Plan[]);
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? "Plan";
  const now = Date.now();
  const status = (p: Promo) =>
    Date.parse(p.ends_at) <= now ? "ended" : Date.parse(p.starts_at) > now ? "scheduled" : "live";

  const create = async () => {
    const pct = Number(form.percent_off);
    if (!form.plan_id) return toast({ title: "Pick a plan", variant: "destructive" });
    if (!Number.isInteger(pct) || pct < 1 || pct > 90) return toast({ title: "Discount must be 1 to 90%", variant: "destructive" });
    if (!form.ends_at) return toast({ title: "Set when the sale ends", variant: "destructive" });
    const starts = new Date(form.starts_at), ends = new Date(form.ends_at);
    if (!(ends > starts)) return toast({ title: "The end must be after the start", variant: "destructive" });
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("plan_promotions" as any).insert({
      plan_id: form.plan_id,
      percent_off: pct,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      label: form.label.trim() || null,
      created_by: user?.id ?? null,
    } as any);
    setSaving(false);
    if (error) return toast({ title: "Couldn't create the sale", description: error.message, variant: "destructive" });
    toast({ title: `${planName(form.plan_id)}: ${pct}% off scheduled` });
    load();
  };

  const endNow = async (p: Promo) => {
    if (!confirm(`End the ${planName(p.plan_id)} sale now? Prices return to normal immediately.`)) return;
    const { error } = await supabase.from("plan_promotions" as any).update({ ends_at: new Date().toISOString() } as any).eq("id", p.id);
    if (error) return toast({ title: "Couldn't end it", description: error.message, variant: "destructive" });
    load();
  };

  const remove = async (p: Promo) => {
    if (!confirm(`Delete this ${planName(p.plan_id)} sale? Past payments keep their price.`)) return;
    const { error } = await supabase.from("plan_promotions" as any).delete().eq("id", p.id);
    if (error) return toast({ title: "Couldn't delete it", description: error.message, variant: "destructive" });
    load();
  };

  const preview = (() => {
    const plan = plans.find((p) => p.id === form.plan_id);
    const pct = Number(form.percent_off);
    if (!plan || !(pct > 0)) return null;
    const f = (v: number) => `$${(Math.round((v - Math.round(v * pct) / 100) * 100) / 100).toFixed(2)}`;
    return `${f(Number(plan.price_usd))} per pack${plan.price_usd_annual ? ` · ${f(Number(plan.price_usd_annual))} annual` : ""}`;
  })();

  return (
    <div className="glass rounded-xl p-4 space-y-3">
      <div>
        <div className="font-heading font-semibold text-foreground text-sm">Elite Sales</div>
        <p className="text-xs text-muted-foreground">
          Time-boxed discounts per plan, shown on the pricing pages and applied automatically at checkout (monthly and annual).
          Customers get the better of the sale or their discount code, never both. Partners keep their full share.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
        <label className="text-[11px] text-muted-foreground space-y-1 col-span-2 md:col-span-1">
          Plan
          <select value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })} className="w-full h-9 px-2 rounded-md bg-background border border-input text-sm">
            <option value="">Choose…</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-muted-foreground space-y-1">
          % off
          <Input type="number" min={1} max={90} value={form.percent_off} onChange={(e) => setForm({ ...form, percent_off: e.target.value })} className="h-9" />
        </label>
        <label className="text-[11px] text-muted-foreground space-y-1">
          Starts (your time)
          <Input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} className="h-9" />
        </label>
        <label className="text-[11px] text-muted-foreground space-y-1">
          Ends (your time)
          <Input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} className="h-9" />
        </label>
        <label className="text-[11px] text-muted-foreground space-y-1">
          Badge label
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="h-9" maxLength={40} />
        </label>
        <Button onClick={create} disabled={saving} className="h-9 font-heading text-xs">{saving ? "Saving…" : "Add sale"}</Button>
      </div>
      {preview && <p className="text-[11px] text-emerald-400">Customers would pay {preview}</p>}

      {promos.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sales yet.</p>
      ) : (
        <div className="space-y-1.5">
          {promos.map((p) => {
            const s = status(p);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-2 text-xs rounded-lg bg-muted/20 px-3 py-2">
                <span className={`px-2 py-0.5 rounded-full font-heading font-semibold ${s === "live" ? "bg-emerald-500/20 text-emerald-400" : s === "scheduled" ? "bg-amber-500/20 text-amber-400" : "bg-muted text-muted-foreground"}`}>{s}</span>
                <span className="font-heading font-semibold text-foreground">{planName(p.plan_id)} · {p.percent_off}% off</span>
                <span className="text-muted-foreground">{p.label}</span>
                <span className="text-muted-foreground">{new Date(p.starts_at).toLocaleString()} → {new Date(p.ends_at).toLocaleString()}</span>
                <div className="ml-auto flex gap-1.5">
                  {s === "live" && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => endNow(p)}>End now</Button>}
                  {s !== "live" && <Button size="sm" variant="outline" className="h-7 text-xs border-destructive/30 text-destructive" onClick={() => remove(p)}>Delete</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
