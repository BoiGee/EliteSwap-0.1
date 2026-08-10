import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getSafeErrorMessage } from "@/lib/errors";

interface PricingPlan {
  id: string;
  name: string;
  description: string | null;
  price_usd: number;
  price_usd_annual: number | null;
  features: string[];
  is_active: boolean;
  sort_order: number;
  created_at: string;
  key_duration_minutes: number | null;
  low_stock_threshold: number;
}

interface PlanForm {
  name: string;
  description: string;
  price_usd: string;
  price_usd_annual: string;
  features: string;
  is_active: boolean;
  sort_order: string;
  key_duration_minutes: string;
  low_stock_threshold: string;
}

const emptyForm: PlanForm = {
  name: "",
  description: "",
  price_usd: "0",
  price_usd_annual: "",
  features: "",
  is_active: true,
  sort_order: "0",
  key_duration_minutes: "",
  low_stock_threshold: "3",
};

export default function PricingManager() {
  const { toast } = useToast();
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<PlanForm>(emptyForm);
  const [showForm, setShowForm] = useState(false);

  const fetchPlans = useCallback(async () => {
    const { data } = await supabase
      .from("pricing_plans")
      .select("*")
      .order("sort_order", { ascending: true });
    if (data) setPlans(data as unknown as PricingPlan[]);
  }, []);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditing(null);
    setShowForm(false);
  };

  const startEdit = (plan: PricingPlan) => {
    setForm({
      name: plan.name,
      description: plan.description ?? "",
      price_usd: String(plan.price_usd),
      price_usd_annual: plan.price_usd_annual != null ? String(plan.price_usd_annual) : "",
      features: (plan.features ?? []).join("\n"),
      is_active: plan.is_active,
      sort_order: String(plan.sort_order),
      key_duration_minutes: plan.key_duration_minutes != null ? String(plan.key_duration_minutes) : "",
      low_stock_threshold: String(plan.low_stock_threshold ?? 3),
    });
    setEditing(plan.id);
    setShowForm(true);
  };

  const savePlan = async () => {
    const payload = {
      name: form.name,
      description: form.description || null,
      price_usd: parseFloat(form.price_usd) || 0,
      price_usd_annual: form.price_usd_annual ? parseFloat(form.price_usd_annual) : null,
      features: form.features.split("\n").map((f) => f.trim()).filter(Boolean),
      is_active: form.is_active,
      sort_order: parseInt(form.sort_order) || 0,
      key_duration_minutes: form.key_duration_minutes ? parseInt(form.key_duration_minutes) : null,
      low_stock_threshold: parseInt(form.low_stock_threshold) || 3,
    };

    if (editing) {
      const { error } = await supabase.from("pricing_plans").update(payload).eq("id", editing);
      if (error) {
        console.error('[internal]', error);
        toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
        return;
      }
      toast({ title: "Plan updated ✅" });
    } else {
      const { error } = await supabase.from("pricing_plans").insert(payload);
      if (error) {
        console.error('[internal]', error);
        toast({ title: "Error", description: getSafeErrorMessage(error.code), variant: "destructive" });
        return;
      }
      toast({ title: "Plan created ✅" });
    }
    resetForm();
    fetchPlans();
  };

  const deletePlan = async (id: string) => {
    const { error } = await supabase.from("pricing_plans").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Plan deleted 🗑️" });
      fetchPlans();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Pricing Plans</h2>
        {!showForm && (
          <Button onClick={() => { setShowForm(true); setEditing(null); setForm(emptyForm); }} className="font-heading text-xs">
            + New Plan
          </Button>
        )}
      </div>

      {showForm && (
        <div className="glass neon-border rounded-xl p-4 space-y-3">
          <h3 className="font-heading font-semibold text-foreground">
            {editing ? "Edit Plan" : "New Plan"}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground font-heading">Name</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pro" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-heading">Price (USD)</label>
              <Input value={form.price_usd} onChange={(e) => setForm({ ...form, price_usd: e.target.value })} type="number" min="0" step="0.01" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-heading">Description</label>
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short description" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-heading">Features (one per line)</label>
            <Textarea value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder={"Unlimited API calls\n24/7 support\nPriority processing"} rows={4} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground font-heading">Key duration (minutes)</label>
              <Input value={form.key_duration_minutes} onChange={(e) => setForm({ ...form, key_duration_minutes: e.target.value })} type="number" min="0" placeholder="e.g. 45 — leave blank to never auto-issue" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground font-heading">Low-stock threshold</label>
              <Input value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: e.target.value })} type="number" min="0" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div>
              <label className="text-xs text-muted-foreground font-heading">Sort Order</label>
              <Input value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} type="number" className="w-24" />
            </div>
            <div className="flex items-center gap-2 mt-4">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
              <span className="text-xs font-heading text-muted-foreground">Active</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={savePlan} className="font-heading text-xs">{editing ? "Update" : "Create"}</Button>
            <Button variant="outline" onClick={resetForm} className="font-heading text-xs">Cancel</Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {plans.map((plan) => (
          <div key={plan.id} className="glass rounded-xl px-4 py-3 flex items-center gap-4 text-sm">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-heading font-semibold text-foreground">{plan.name}</span>
                <span className="font-heading font-bold text-primary">${plan.price_usd}</span>
                {plan.key_duration_minutes != null && (
                  <span className="text-xs font-heading bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                    {plan.key_duration_minutes} min/key
                  </span>
                )}
                <span className={`text-xs font-heading px-2 py-0.5 rounded-full ${plan.is_active ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"}`}>
                  {plan.is_active ? "Active" : "Inactive"}
                </span>
              </div>
              {plan.description && <div className="text-xs text-muted-foreground mt-0.5">{plan.description}</div>}
              {plan.features?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {plan.features.map((f, i) => (
                    <span key={i} className="text-xs bg-muted/50 text-muted-foreground px-2 py-0.5 rounded-full">{f}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => startEdit(plan)} className="font-heading text-xs">Edit</Button>
              <Button size="sm" variant="outline" onClick={() => deletePlan(plan.id)} className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs">Delete</Button>
            </div>
          </div>
        ))}
        {plans.length === 0 && !showForm && <p className="text-sm text-muted-foreground">No pricing plans yet. Create one to get started.</p>}
      </div>
    </div>
  );
}
