import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, KeyRound, RefreshCw } from "lucide-react";

interface Plan {
  id: string;
  name: string;
  key_duration_minutes: number | null;
  low_stock_threshold: number;
  is_active: boolean;
}

interface PoolRow {
  id: string;
  api_key: string;
  plan_id: string | null;
  status: "available" | "assigned" | "disabled";
  assigned_to_user_id: string | null;
  assigned_payment_id: string | null;
  assigned_at: string | null;
  note: string | null;
  created_at: string;
}

interface PendingPayment {
  id: string;
  user_id: string;
  plan_id: string | null;
  amount_usd: number | null;
  created_at: string;
}

export default function KeyPoolManager() {
  const { toast } = useToast();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [pool, setPool] = useState<PoolRow[]>([]);
  const [pending, setPending] = useState<PendingPayment[]>([]);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<"all" | "available" | "assigned" | "disabled">("all");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [bulkKeys, setBulkKeys] = useState("");
  const [bulkPlan, setBulkPlan] = useState<string>("");
  const [bulkNote, setBulkNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});


  const fetchAll = useCallback(async () => {
    const [pl, pp, payPending, profs] = await Promise.all([
      supabase.from("pricing_plans").select("id,name,key_duration_minutes,low_stock_threshold,is_active").order("sort_order"),
      supabase.from("api_key_pool" as any).select("*").order("created_at", { ascending: false }),
      supabase.from("payments").select("id,user_id,plan_id,amount_usd,created_at").eq("pending_key_assignment", true).eq("status", "confirmed"),
      supabase.from("profiles").select("user_id,email"),
    ]);
    if (pl.data) setPlans(pl.data as any);
    if (pp.data) setPool(pp.data as any);
    if (payPending.data) setPending(payPending.data as any);
    if (profs.data) {
      const m: Record<string, string> = {};
      (profs.data as any[]).forEach((p) => { if (p.email) m[p.user_id] = p.email; });
      setEmails(m);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const planName = (id: string | null) => id ? (plans.find((p) => p.id === id)?.name ?? "—") : "Any plan";
  const emailFor = (uid: string | null) => uid ? (emails[uid] ?? uid.slice(0, 8)) : "—";

  const stockByPlan = useMemo(() => {
    const m: Record<string, { available: number; assigned: number; disabled: number }> = {};
    for (const plan of plans) m[plan.id] = { available: 0, assigned: 0, disabled: 0 };
    m["__unbound"] = { available: 0, assigned: 0, disabled: 0 };
    for (const row of pool) {
      const key = row.plan_id ?? "__unbound";
      if (!m[key]) m[key] = { available: 0, assigned: 0, disabled: 0 };
      m[key][row.status] += 1;
    }
    return m;
  }, [pool, plans]);

  const filtered = useMemo(() => {
    return pool.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (planFilter !== "all") {
        if (planFilter === "__unbound" && r.plan_id !== null) return false;
        if (planFilter !== "__unbound" && r.plan_id !== planFilter) return false;
      }
      return true;
    });
  }, [pool, statusFilter, planFilter]);

  const addKeys = async () => {
    const keys = bulkKeys
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      toast({ title: "Paste at least one key", variant: "destructive" });
      return;
    }
    setSaving(true);
    const rows = keys.map((k) => ({
      api_key: k,
      plan_id: bulkPlan || null,
      note: bulkNote.trim() || null,
    }));
    const { error, data } = await supabase.from("api_key_pool" as any).insert(rows).select("id");
    setSaving(false);
    if (error) {
      toast({ title: "Couldn't add keys", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: `Added ${data?.length ?? rows.length} key(s) to the pool 🔑` });
    setBulkKeys(""); setBulkNote(""); setShowAdd(false);
    fetchAll();
  };

  const setStatus = async (id: string, status: PoolRow["status"]) => {
    const { error } = await supabase.from("api_key_pool" as any).update({ status }).eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: `Key ${status}` });
      fetchAll();
    }
  };

  const deleteRow = async (id: string) => {
    const { error } = await supabase.from("api_key_pool" as any).delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Key removed from pool" });
      fetchAll();
    }
  };

  const retryAssign = async (paymentId: string) => {
    const { data, error } = await supabase.rpc("issue_api_key_for_payment" as any, { p_payment_id: paymentId });
    if (error) {
      toast({ title: "Couldn't assign", description: error.message, variant: "destructive" });
    } else if (!data) {
      toast({ title: "Still no key available", description: "Add stock to the pool first.", variant: "destructive" });
    } else {
      toast({ title: "Key assigned ✅" });
    }
    fetchAll();
  };

  const mask = (k: string) => k.length <= 10 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;

  const revealKey = async (row: PoolRow) => {
    // Audit every reveal so any future key leak has a paper trail.
    const { error: auditErr } = await supabase.rpc("log_api_key_pool_reveal" as any, { p_pool_id: row.id });
    if (auditErr) {
      toast({ title: "Reveal blocked", description: auditErr.message, variant: "destructive" });
      return;
    }
    setRevealedKeys((s) => ({ ...s, [row.id]: true }));
    try {
      await navigator.clipboard.writeText(row.api_key);
      toast({ title: "Key revealed & copied to clipboard", description: "This action was logged in the admin audit trail." });
    } catch {
      toast({ title: "Key revealed", description: "This action was logged in the admin audit trail." });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-primary" /> Key Pool
        </h2>
        <Button onClick={() => setShowAdd(true)} className="font-heading text-xs">+ Add keys</Button>
      </div>

      {pending.length > 0 && (
        <div className="glass border border-amber-500/40 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-400 font-heading text-sm">
            <AlertTriangle className="w-4 h-4" />
            {pending.length} confirmed payment{pending.length === 1 ? "" : "s"} waiting for a key
          </div>
          <div className="space-y-1.5">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between bg-muted/20 rounded-lg px-3 py-2 text-xs">
                <div className="flex flex-col">
                  <span className="text-foreground">{emailFor(p.user_id)}</span>
                  <span className="text-muted-foreground">{planName(p.plan_id)} · ${p.amount_usd ?? 0}</span>
                </div>
                <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => retryAssign(p.id)}>
                  <RefreshCw className="w-3 h-3 mr-1" /> Retry assignment
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {plans.filter((p) => p.is_active && p.key_duration_minutes).map((plan) => {
          const s = stockByPlan[plan.id] ?? { available: 0, assigned: 0, disabled: 0 };
          const low = s.available < (plan.low_stock_threshold ?? 3);
          return (
            <div key={plan.id} className={`glass rounded-xl p-3 space-y-1 border ${low ? "border-destructive/50" : "border-border"}`}>
              <div className="flex items-center justify-between">
                <span className="font-heading font-semibold text-foreground text-sm">{plan.name}</span>
                <span className="text-xs text-muted-foreground">{plan.key_duration_minutes}m</span>
              </div>
              <div className="text-2xl font-heading font-bold text-foreground">{s.available}</div>
              <div className="text-xs text-muted-foreground">{s.assigned} assigned · {s.disabled} disabled</div>
              {low && <div className="text-xs text-destructive font-heading">Low stock (&lt; {plan.low_stock_threshold})</div>}
            </div>
          );
        })}
        <div className="glass rounded-xl p-3 space-y-1 border border-border">
          <div className="flex items-center justify-between">
            <span className="font-heading font-semibold text-foreground text-sm">Unbound</span>
            <span className="text-xs text-muted-foreground">any plan</span>
          </div>
          <div className="text-2xl font-heading font-bold text-foreground">{stockByPlan["__unbound"]?.available ?? 0}</div>
          <div className="text-xs text-muted-foreground">
            {stockByPlan["__unbound"]?.assigned ?? 0} assigned · {stockByPlan["__unbound"]?.disabled ?? 0} disabled
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="h-9 px-2 rounded-md bg-background border border-input text-sm font-heading">
          <option value="all">All statuses</option>
          <option value="available">Available</option>
          <option value="assigned">Assigned</option>
          <option value="disabled">Disabled</option>
        </select>
        <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)} className="h-9 px-2 rounded-md bg-background border border-input text-sm font-heading">
          <option value="all">All plans</option>
          <option value="__unbound">Unbound (any plan)</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="text-xs text-muted-foreground ml-auto">{filtered.length} of {pool.length}</span>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-heading text-xs">Key</TableHead>
              <TableHead className="font-heading text-xs">Plan</TableHead>
              <TableHead className="font-heading text-xs">Status</TableHead>
              <TableHead className="font-heading text-xs">Assigned to</TableHead>
              <TableHead className="font-heading text-xs">Added</TableHead>
              <TableHead className="font-heading text-xs text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">
                  {revealedKeys[r.id] ? (
                    <span className="break-all">{r.api_key}</span>
                  ) : (
                    <button
                      type="button"
                      className="text-left hover:text-primary underline decoration-dotted"
                      onClick={() => revealKey(r)}
                      title="Click to reveal & copy (audited)"
                    >
                      {mask(r.api_key)}
                    </button>
                  )}
                </TableCell>
                <TableCell className="text-xs">{planName(r.plan_id)}</TableCell>
                <TableCell>
                  <span className={`text-xs font-heading px-2 py-0.5 rounded-full ${
                    r.status === "available" ? "bg-primary/20 text-primary"
                      : r.status === "assigned" ? "bg-muted/40 text-muted-foreground"
                      : "bg-destructive/20 text-destructive"
                  }`}>{r.status}</span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{emailFor(r.assigned_to_user_id)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-1 justify-end">
                    {r.status === "available" && (
                      <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => setStatus(r.id, "disabled")}>Disable</Button>
                    )}
                    {r.status === "disabled" && (
                      <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => setStatus(r.id, "available")}>Enable</Button>
                    )}
                    {r.status !== "assigned" && (
                      <Button size="sm" variant="outline" className="font-heading text-xs border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => deleteRow(r.id)}>Delete</Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-sm py-8">No keys match this filter.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Add keys to the pool</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Bind to plan (optional)</Label>
              <select value={bulkPlan} onChange={(e) => setBulkPlan(e.target.value)} className="w-full h-9 px-2 rounded-md bg-background border border-input text-sm font-heading">
                <option value="">Unbound (use for any plan)</option>
                {plans.filter((p) => p.is_active && p.key_duration_minutes).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.key_duration_minutes}m</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Keys (one per line, or comma-separated)</Label>
              <Textarea value={bulkKeys} onChange={(e) => setBulkKeys(e.target.value)} rows={8} placeholder={"sk-decart-xxxx\nsk-decart-yyyy\nsk-decart-zzzz"} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="font-heading text-xs">Note (optional)</Label>
              <Input value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} placeholder="e.g. batch from Dec 5" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)} className="font-heading text-xs">Cancel</Button>
            <Button onClick={addKeys} disabled={saving} className="font-heading text-xs">{saving ? "Adding…" : "Add to pool"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
