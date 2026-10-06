import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import UserDetailDrawer from "./UserDetailDrawer";

interface Profile { user_id: string; email: string | null; display_name: string | null; created_at: string; last_seen_at?: string | null; }
interface Payment { id: string; user_id: string; amount_usd: number | null; status: string; created_at: string; plan_id?: string | null; }

interface Props {
  profiles: Profile[];
  payments: Payment[];
}

interface UserStats {
  studioMs: number;
  lastStudioAt: string | null;
  partner: string | null;
  trialSpend: number;
  trialCount: number;
  lastTrialAt: number;
}

type SortKey = "spend" | "count" | "last_paid" | "last_seen" | "studio" | "email";
// $10 trials are a separate product from plan payments (Finance keeps them out of P&L too),
// so plan buyers stay the default view.
type Scope = "plans" | "all" | "trial_only";

export default function PaidUsersManager({ profiles, payments }: Props) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("spend");
  const [scope, setScope] = useState<Scope>("plans");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<Record<string, UserStats>>({});
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const loadSeq = useRef(0);

  // Studio time, partner attribution and $10 trial purchases are aggregated server-side by
  // admin_paid_user_stats(): studio_sessions alone is far past PostgREST's 1000-row cap.
  const loadStats = useCallback(async (quiet = false) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    const [pl, st] = await Promise.all([
      supabase.from("pricing_plans").select("id,name"),
      supabase.rpc("admin_paid_user_stats" as any),
    ]);
    if (seq !== loadSeq.current) return;
    setLoading(false);
    const err = pl.error ?? st.error;
    if (err) {
      // Keep the last good data on screen rather than blanking every column.
      if (!quiet) toast({ title: "Paid users didn't fully load", description: err.message, variant: "destructive" });
      console.error("[PaidUsersManager] load failed", err);
      if (pl.error && st.error) return;
    }
    if (!pl.error) {
      const planMap: Record<string, string> = {};
      (pl.data ?? []).forEach((p: any) => { planMap[p.id] = p.name; });
      setPlans(planMap);
    }
    if (!st.error) {
      const map: Record<string, UserStats> = {};
      ((st.data as any[]) ?? []).forEach((s) => {
        map[s.user_id] = {
          studioMs: Number(s.studio_ms ?? 0),
          lastStudioAt: s.last_studio_at ?? null,
          partner: s.partner_code ?? null,
          trialSpend: Number(s.trial_spend_usd ?? 0),
          trialCount: Number(s.trial_count ?? 0),
          lastTrialAt: s.last_trial_at ? new Date(s.last_trial_at).getTime() : 0,
        };
      });
      setStats(map);
      setLoadedAt(new Date());
    }
  }, [toast]);

  useEffect(() => { loadStats(); }, [loadStats]);

  // Studio time changes from real usage with no admin action, so poll; a postgres_changes
  // subscription would fire on every session heartbeat. Plan payments and profiles come from
  // the Admin page, which already refreshes them live. Paused while the tab is hidden.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") loadStats(true);
    }, 30000);
    const onVisible = () => { if (document.visibilityState === "visible") loadStats(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadStats]);

  const { rows, missingAmountTotal } = useMemo(() => {
    const byUser: Record<string, { spend: number; count: number; missingAmount: number; lastPaid: number; planIds: Set<string> }> = {};
    for (const p of payments) {
      if (p.status !== "confirmed" || !p.user_id) continue;
      const u = byUser[p.user_id] ?? { spend: 0, count: 0, missingAmount: 0, lastPaid: 0, planIds: new Set<string>() };
      // amount_usd is what the customer paid, after any discount. A few legacy crypto
      // payments have no amount recorded; they count as payments but add nothing.
      if (p.amount_usd == null) u.missingAmount += 1;
      else u.spend += Number(p.amount_usd);
      u.count += 1;
      const t = new Date(p.created_at).getTime();
      if (t > u.lastPaid) u.lastPaid = t;
      if (p.plan_id) u.planIds.add(p.plan_id);
      byUser[p.user_id] = u;
    }

    const profileById = new Map(profiles.map((p) => [p.user_id, p]));
    const ids = new Set<string>();
    if (scope !== "trial_only") Object.keys(byUser).forEach((id) => ids.add(id));
    if (scope !== "plans") {
      Object.entries(stats).forEach(([id, s]) => { if (s.trialCount > 0) ids.add(id); });
    }
    if (scope === "trial_only") Object.keys(byUser).forEach((id) => ids.delete(id));

    const q = search.toLowerCase().trim();
    const list = Array.from(ids).map((id) => {
      const u = byUser[id];
      const s = stats[id];
      const withTrials = scope !== "plans";
      const trialSpend = withTrials ? s?.trialSpend ?? 0 : 0;
      const trialCount = withTrials ? s?.trialCount ?? 0 : 0;
      return {
        userId: id,
        // Payments outlive a deleted account's profile; they still count toward revenue.
        profile: profileById.get(id) ?? null,
        planSpend: u?.spend ?? 0,
        trialSpend,
        spend: (u?.spend ?? 0) + trialSpend,
        planCount: u?.count ?? 0,
        trialCount,
        count: (u?.count ?? 0) + trialCount,
        missingAmount: u?.missingAmount ?? 0,
        lastPaid: Math.max(u?.lastPaid ?? 0, withTrials ? s?.lastTrialAt ?? 0 : 0),
        plans: u ? Array.from(u.planIds).map((pid) => plans[pid] ?? "—").join(", ") || "—" : "—",
        studioMs: s?.studioMs ?? 0,
        lastStudioAt: s?.lastStudioAt ?? null,
        partner: s?.partner ?? "—",
      };
    }).filter((r) => !q
      || r.profile?.email?.toLowerCase().includes(q)
      || r.profile?.display_name?.toLowerCase().includes(q)
      || r.userId.toLowerCase().startsWith(q)
      || r.partner.toLowerCase().includes(q));

    list.sort((a, b) => {
      switch (sort) {
        case "count": return b.count - a.count;
        case "last_paid": return b.lastPaid - a.lastPaid;
        case "last_seen": return new Date(b.profile?.last_seen_at ?? 0).getTime() - new Date(a.profile?.last_seen_at ?? 0).getTime();
        case "studio": return b.studioMs - a.studioMs;
        case "email": return (a.profile?.email ?? "~").localeCompare(b.profile?.email ?? "~");
        case "spend":
        default: return b.spend - a.spend;
      }
    });
    return { rows: list, missingAmountTotal: list.reduce((n, r) => n + r.missingAmount, 0) };
  }, [profiles, payments, search, sort, scope, plans, stats]);

  const totalRevenue = rows.reduce((s, r) => s + r.spend, 0);

  const fmtMs = (ms: number) => {
    if (!ms) return "—";
    const h = Math.floor(ms / 3_600_000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h === 0 && m === 0) return `${Math.max(1, Math.round(ms / 1000))}s`;
    return `${h}h ${m}m`;
  };

  const exportCsv = () => {
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["user_id", "email", "name", "plans", "plan_spend_usd", "plan_payments", "trial_spend_usd", "trial_purchases", "payments_missing_amount", "last_paid", "studio_minutes", "last_seen", "partner"];
    const lines = rows.map((r) => [
      r.userId, r.profile?.email ?? "", r.profile?.display_name ?? "", r.plans, r.planSpend.toFixed(2), r.planCount,
      r.trialSpend.toFixed(2), r.trialCount, r.missingAmount,
      r.lastPaid ? new Date(r.lastPaid).toISOString() : "", Math.round(r.studioMs / 60000),
      r.profile?.last_seen_at ?? "", r.partner === "—" ? "" : r.partner,
    ].map(cell).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `paid-users-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const showTrials = scope !== "plans";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-heading font-bold text-foreground">Paid Users</h2>
        <div className="flex flex-wrap gap-2 text-xs items-center">
          <span className="bg-primary/10 text-primary px-3 py-1.5 rounded-full font-heading">{rows.length} customers</span>
          <span className="bg-primary/10 text-primary px-3 py-1.5 rounded-full font-heading" title="What customers paid, after discounts">${totalRevenue.toFixed(2)} lifetime</span>
          {missingAmountTotal > 0 && (
            <span className="bg-yellow-500/10 text-yellow-500 px-3 py-1.5 rounded-full font-heading" title="Confirmed payments with no amount recorded; not included in spend">
              {missingAmountTotal} payment{missingAmountTotal === 1 ? "" : "s"} with no amount
            </span>
          )}
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0} className="font-heading text-xs">CSV</Button>
          <Button variant="outline" size="sm" onClick={() => loadStats()} disabled={loading} className="font-heading text-xs">{loading ? "…" : "Refresh"}</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Input placeholder="Search email, name, partner code…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm h-9 text-sm" />
        <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className="h-9 px-2 rounded-md bg-background border border-input text-sm font-heading">
          <option value="plans">Plan buyers</option>
          <option value="all">Plan + $10 trial buyers</option>
          <option value="trial_only">$10 trial only (never bought a plan)</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-9 px-2 rounded-md bg-background border border-input text-sm font-heading">
          <option value="spend">Sort: Lifetime spend</option>
          <option value="count">Sort: # payments</option>
          <option value="last_paid">Sort: Last paid</option>
          <option value="last_seen">Sort: Last seen</option>
          <option value="studio">Sort: Studio time</option>
          <option value="email">Sort: Email A-Z</option>
        </select>
        {loadedAt && <span className="text-xs text-muted-foreground">Studio time updated {loadedAt.toLocaleTimeString()}</span>}
      </div>

      <div className="glass rounded-xl overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-heading text-xs">User</TableHead>
              <TableHead className="font-heading text-xs">Plan(s)</TableHead>
              <TableHead className="font-heading text-xs text-right">Spend</TableHead>
              <TableHead className="font-heading text-xs text-right">#</TableHead>
              {showTrials && <TableHead className="font-heading text-xs text-right">$10 trials</TableHead>}
              <TableHead className="font-heading text-xs">Last paid</TableHead>
              <TableHead className="font-heading text-xs">Studio time</TableHead>
              <TableHead className="font-heading text-xs">Last seen</TableHead>
              <TableHead className="font-heading text-xs">Partner</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.userId} className={r.profile ? "cursor-pointer" : ""} onClick={() => r.profile && setSelectedUser(r.userId)}>
                <TableCell>
                  {r.profile ? (
                    <>
                      <div className="font-heading text-foreground text-sm">{r.profile.display_name || r.profile.email || "—"}</div>
                      {r.profile.display_name && r.profile.email && <div className="text-xs text-muted-foreground">{r.profile.email}</div>}
                    </>
                  ) : (
                    <>
                      <div className="font-heading text-muted-foreground text-sm">Deleted account</div>
                      <div className="text-xs text-muted-foreground font-mono">{r.userId.slice(0, 8)}…</div>
                    </>
                  )}
                </TableCell>
                <TableCell className="text-xs">{r.plans}</TableCell>
                <TableCell className="text-right font-heading text-primary">
                  ${r.spend.toFixed(2)}
                  {r.missingAmount > 0 && <div className="text-[10px] text-yellow-500 font-normal">+{r.missingAmount} no amount</div>}
                </TableCell>
                <TableCell className="text-right text-xs">{r.count}</TableCell>
                {showTrials && <TableCell className="text-right text-xs">{r.trialCount ? `${r.trialCount} · $${r.trialSpend.toFixed(2)}` : "—"}</TableCell>}
                <TableCell className="text-xs text-muted-foreground">{r.lastPaid ? new Date(r.lastPaid).toLocaleDateString() : "—"}</TableCell>
                <TableCell className="text-xs" title={r.lastStudioAt ? `Last session ${new Date(r.lastStudioAt).toLocaleString()}` : undefined}>{fmtMs(r.studioMs)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.profile?.last_seen_at ? new Date(r.profile.last_seen_at).toLocaleDateString() : "—"}</TableCell>
                <TableCell className="text-xs">{r.partner}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={showTrials ? 9 : 8} className="text-center text-muted-foreground text-sm py-8">{search ? "No paid users match this search." : "No paid users yet."}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <UserDetailDrawer userId={selectedUser} onClose={() => setSelectedUser(null)} />
    </div>
  );
}
