import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";

interface DiscountCode {
  id: string;
  code: string;
  description: string | null;
  percent_off: number;
  redemption_mode: "single_per_user" | "multi_use_capped";
  max_redemptions: number | null;
  times_redeemed: number;
  applies_to_plan_ids: string[] | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

interface Plan { id: string; name: string }

interface Redemption {
  id: string;
  code_id: string;
  user_id: string;
  payment_id: string | null;
  discount_amount_usd: number;
  redeemed_at: string;
}

interface FormState {
  code: string;
  description: string;
  percent_off: number;
  redemption_mode: "single_per_user" | "multi_use_capped";
  max_redemptions: string;
  applies_to_plan_ids: string[];
  expires_at: string;
  is_active: boolean;
}

const emptyForm: FormState = {
  code: "",
  description: "",
  percent_off: 10,
  redemption_mode: "single_per_user",
  max_redemptions: "",
  applies_to_plan_ids: [],
  expires_at: "",
  is_active: true,
};

export default function DiscountManager({ emailForUser }: { emailForUser: (id: string) => string }) {
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const { toast } = useToast();

  // Redemptions are fetched per-code, on demand, rather than one shared
  // list capped at 200 rows total — a single popular code could otherwise
  // push another code's redemptions out of view entirely, or silently
  // truncate its own history. discount_codes.times_redeemed (an atomic
  // counter, not derived from this list) is always the accurate count.
  const [redemptionsByCode, setRedemptionsByCode] = useState<Record<string, Redemption[]>>({});
  const [loadingRedemptions, setLoadingRedemptions] = useState<Record<string, boolean>>({});
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [c, p] = await Promise.all([
      supabase.from("discount_codes" as any).select("*").order("created_at", { ascending: false }),
      supabase.from("pricing_plans").select("id, name").order("sort_order"),
    ]);
    if (c.data) setCodes(c.data as unknown as DiscountCode[]);
    if (p.data) setPlans(p.data as Plan[]);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const toggleRedemptions = async (codeId: string) => {
    if (expandedCode === codeId) { setExpandedCode(null); return; }
    setExpandedCode(codeId);
    if (redemptionsByCode[codeId]) return;
    setLoadingRedemptions((s) => ({ ...s, [codeId]: true }));
    const { data, error } = await supabase
      .from("discount_redemptions" as any)
      .select("*")
      .eq("code_id", codeId)
      .order("redeemed_at", { ascending: false })
      .limit(500);
    setLoadingRedemptions((s) => ({ ...s, [codeId]: false }));
    if (error) {
      toast({ title: "Error loading redemptions", description: error.message, variant: "destructive" });
      return;
    }
    setRedemptionsByCode((s) => ({ ...s, [codeId]: (data ?? []) as unknown as Redemption[] }));
  };

  const startCreate = () => { setForm(emptyForm); setCreating(true); setEditing(null); };
  const startEdit = (c: DiscountCode) => {
    setForm({
      code: c.code,
      description: c.description ?? "",
      percent_off: c.percent_off,
      redemption_mode: c.redemption_mode,
      max_redemptions: c.max_redemptions != null ? String(c.max_redemptions) : "",
      applies_to_plan_ids: c.applies_to_plan_ids ?? [],
      expires_at: c.expires_at ? c.expires_at.slice(0, 16) : "",
      is_active: c.is_active,
    });
    setEditing(c.id);
    setCreating(false);
  };

  const save = async () => {
    if (!form.code.trim()) { toast({ title: "Code required", variant: "destructive" }); return; }
    if (form.redemption_mode === "multi_use_capped" && (!form.max_redemptions || Number(form.max_redemptions) < 1)) {
      toast({ title: "Max redemptions required for capped codes", variant: "destructive" });
      return;
    }
    const payload: any = {
      code: form.code.trim().toUpperCase(),
      description: form.description.trim() || null,
      percent_off: form.percent_off,
      redemption_mode: form.redemption_mode,
      max_redemptions: form.redemption_mode === "multi_use_capped" ? Number(form.max_redemptions) : null,
      applies_to_plan_ids: form.applies_to_plan_ids.length > 0 ? form.applies_to_plan_ids : null,
      expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
      is_active: form.is_active,
    };
    const { error } = editing
      ? await supabase.from("discount_codes" as any).update(payload).eq("id", editing)
      : await supabase.from("discount_codes" as any).insert(payload);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: editing ? "Code updated ✏️" : "Code created 🎉" });
    setEditing(null); setCreating(false); setForm(emptyForm);
    fetchAll();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this discount code? Redemption history will be removed too.")) return;
    const { error } = await supabase.from("discount_codes" as any).delete().eq("id", id);
    if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); return; }
    toast({ title: "Deleted 🗑️" });
    fetchAll();
  };

  const toggleActive = async (c: DiscountCode) => {
    const { error } = await supabase.from("discount_codes" as any).update({ is_active: !c.is_active }).eq("id", c.id);
    if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); return; }
    fetchAll();
  };

  const togglePlan = (planId: string) => {
    setForm((f) => ({
      ...f,
      applies_to_plan_ids: f.applies_to_plan_ids.includes(planId)
        ? f.applies_to_plan_ids.filter((p) => p !== planId)
        : [...f.applies_to_plan_ids, planId],
    }));
  };

  const planNames = (ids: string[] | null) =>
    !ids || ids.length === 0 ? "All plans" : ids.map((id) => plans.find((p) => p.id === id)?.name ?? "?").join(", ");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Discount Codes</h2>
        {!creating && !editing && (
          <Button onClick={startCreate} size="sm" className="font-heading text-xs bg-primary text-primary-foreground hover:bg-primary/90">
            + New Code
          </Button>
        )}
      </div>

      {(creating || editing) && (
        <div className="glass neon-border rounded-xl p-4 space-y-4">
          <h3 className="font-heading font-semibold text-foreground">{editing ? "Edit code" : "Create code"}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-heading text-muted-foreground">Code</label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className="font-mono uppercase" maxLength={32} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-heading text-muted-foreground">Description (admin only)</label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={200} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">
              Percent off: <span className="text-primary font-bold">{form.percent_off}%</span>
            </label>
            <Slider value={[form.percent_off]} min={1} max={20} step={1} onValueChange={(v) => setForm({ ...form, percent_off: v[0] })} />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">Redemption mode</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, redemption_mode: "single_per_user" })}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-heading transition-all ${
                  form.redemption_mode === "single_per_user" ? "bg-primary/20 text-primary neon-border" : "bg-muted/30 text-muted-foreground"
                }`}
              >
                Single per user
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, redemption_mode: "multi_use_capped" })}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-heading transition-all ${
                  form.redemption_mode === "multi_use_capped" ? "bg-primary/20 text-primary neon-border" : "bg-muted/30 text-muted-foreground"
                }`}
              >
                Multi-use (capped)
              </button>
            </div>
          </div>

          {form.redemption_mode === "multi_use_capped" && (
            <div className="space-y-1">
              <label className="text-xs font-heading text-muted-foreground">Max total redemptions</label>
              <Input type="number" min="1" value={form.max_redemptions} onChange={(e) => setForm({ ...form, max_redemptions: e.target.value })} />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">Applies to plans (none selected = all plans)</label>
            <div className="flex flex-wrap gap-2">
              {plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePlan(p.id)}
                  className={`px-3 py-1 rounded-full text-xs font-heading transition-all ${
                    form.applies_to_plan_ids.includes(p.id)
                      ? "bg-primary/20 text-primary neon-border"
                      : "bg-muted/30 text-muted-foreground"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-heading text-muted-foreground">Expires at (optional)</label>
              <Input type="datetime-local" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
              <span className="text-xs font-heading">{form.is_active ? "Active" : "Inactive"}</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={save} size="sm" className="font-heading text-xs">{editing ? "Save changes" : "Create code"}</Button>
            <Button onClick={() => { setCreating(false); setEditing(null); setForm(emptyForm); }} variant="outline" size="sm" className="font-heading text-xs">Cancel</Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {codes.map((c) => {
          const isExpanded = expandedCode === c.id;
          const codeRedemptions = redemptionsByCode[c.id] ?? [];
          return (
            <div key={c.id} className="glass rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono font-bold text-primary text-sm">{c.code}</span>
                <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-heading">{c.percent_off}% off</span>
                <span className="text-xs bg-muted/40 px-2 py-0.5 rounded-full font-heading">
                  {c.redemption_mode === "single_per_user" ? "1 per user" : `Capped · ${c.times_redeemed}/${c.max_redemptions}`}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-heading ${c.is_active ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"}`}>
                  {c.is_active ? "Active" : "Inactive"}
                </span>
                {c.expires_at && (
                  <span className="text-xs text-muted-foreground font-heading">expires {new Date(c.expires_at).toLocaleDateString()}</span>
                )}
                <span className="text-xs text-muted-foreground font-heading ml-auto">{planNames(c.applies_to_plan_ids)}</span>
              </div>
              {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => startEdit(c)} className="font-heading text-xs">Edit</Button>
                <Button size="sm" variant="outline" onClick={() => toggleActive(c)} className="font-heading text-xs">
                  {c.is_active ? "Deactivate" : "Activate"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => remove(c.id)} className="font-heading text-xs border-destructive/30 text-destructive hover:bg-destructive/10">
                  Delete
                </Button>
              </div>

              {c.times_redeemed > 0 && (
                <div className="text-xs">
                  <button
                    onClick={() => toggleRedemptions(c.id)}
                    className="cursor-pointer text-muted-foreground font-heading hover:text-foreground"
                  >
                    {isExpanded ? "Hide" : "Show"} redemptions ({c.times_redeemed})
                  </button>
                  {isExpanded && (
                    <div className="mt-2 space-y-1">
                      {loadingRedemptions[c.id] && <p className="text-muted-foreground">Loading…</p>}
                      {!loadingRedemptions[c.id] && codeRedemptions.map((r) => (
                        <div key={r.id} className="flex items-center gap-3 bg-muted/20 rounded-lg px-2 py-1">
                          <span className="text-muted-foreground">{emailForUser(r.user_id)}</span>
                          <span className="font-heading text-primary">−${Number(r.discount_amount_usd).toFixed(2)}</span>
                          <span className="text-muted-foreground ml-auto">{new Date(r.redeemed_at).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {codes.length === 0 && <p className="text-sm text-muted-foreground">No discount codes yet.</p>}
      </div>
    </div>
  );
}
