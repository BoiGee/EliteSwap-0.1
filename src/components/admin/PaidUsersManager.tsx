import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import UserDetailDrawer from "./UserDetailDrawer";

interface Profile { user_id: string; email: string | null; display_name: string | null; created_at: string; last_seen_at?: string | null; }
interface Payment { id: string; user_id: string; amount_usd: number | null; status: string; created_at: string; plan_id?: string | null; }

interface Props {
  profiles: Profile[];
  payments: Payment[];
}

type SortKey = "spend" | "count" | "last_paid" | "last_seen" | "email";

export default function PaidUsersManager({ profiles, payments }: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("spend");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, string>>({});
  const [sessionsByUser, setSessionsByUser] = useState<Record<string, number>>({});
  const [attributions, setAttributions] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const [pl, sess, attrs, parts] = await Promise.all([
        supabase.from("pricing_plans").select("id,name"),
        supabase.from("studio_sessions" as any).select("user_id,duration_ms"),
        supabase.from("partner_attributions" as any).select("user_id,partner_id"),
        supabase.from("partners" as any).select("id,code"),
      ]);
      const planMap: Record<string, string> = {};
      (pl.data ?? []).forEach((p: any) => { planMap[p.id] = p.name; });
      setPlans(planMap);
      const totals: Record<string, number> = {};
      (sess.data as any[] ?? []).forEach((s) => { totals[s.user_id] = (totals[s.user_id] ?? 0) + Number(s.duration_ms ?? 0); });
      setSessionsByUser(totals);
      const partMap: Record<string, string> = {};
      (parts.data as any[] ?? []).forEach((p: any) => { partMap[p.id] = p.code; });
      const attrMap: Record<string, string> = {};
      (attrs.data as any[] ?? []).forEach((a: any) => { attrMap[a.user_id] = partMap[a.partner_id] ?? "—"; });
      setAttributions(attrMap);
    })();
  }, []);

  const rows = useMemo(() => {
    const byUser: Record<string, { spend: number; count: number; lastPaid: number; planIds: Set<string> }> = {};
    for (const p of payments) {
      if (p.status !== "confirmed") continue;
      const u = byUser[p.user_id] ?? { spend: 0, count: 0, lastPaid: 0, planIds: new Set<string>() };
      u.spend += Number(p.amount_usd ?? 0);
      u.count += 1;
      const t = new Date(p.created_at).getTime();
      if (t > u.lastPaid) u.lastPaid = t;
      if (p.plan_id) u.planIds.add(p.plan_id);
      byUser[p.user_id] = u;
    }
    const q = search.toLowerCase().trim();
    const list = profiles
      .filter((p) => byUser[p.user_id])
      .filter((p) => !q || p.email?.toLowerCase().includes(q) || p.display_name?.toLowerCase().includes(q))
      .map((p) => {
        const u = byUser[p.user_id];
        return {
          profile: p,
          spend: u.spend,
          count: u.count,
          lastPaid: u.lastPaid,
          plans: Array.from(u.planIds).map((id) => plans[id] ?? "—").join(", ") || "—",
          studioMs: sessionsByUser[p.user_id] ?? 0,
          partner: attributions[p.user_id] ?? "—",
        };
      });
    list.sort((a, b) => {
      switch (sort) {
        case "count": return b.count - a.count;
        case "last_paid": return b.lastPaid - a.lastPaid;
        case "last_seen": return new Date(b.profile.last_seen_at ?? 0).getTime() - new Date(a.profile.last_seen_at ?? 0).getTime();
        case "email": return (a.profile.email ?? "").localeCompare(b.profile.email ?? "");
        case "spend":
        default: return b.spend - a.spend;
      }
    });
    return list;
  }, [profiles, payments, search, sort, plans, sessionsByUser, attributions]);

  const totalRevenue = rows.reduce((s, r) => s + r.spend, 0);

  const fmtMs = (ms: number) => {
    if (!ms) return "—";
    const h = Math.floor(ms / 3_600_000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Paid Users</h2>
        <div className="flex gap-2 text-xs">
          <span className="bg-primary/10 text-primary px-3 py-1.5 rounded-full font-heading">{rows.length} customers</span>
          <span className="bg-primary/10 text-primary px-3 py-1.5 rounded-full font-heading">${totalRevenue.toFixed(2)} lifetime</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Input placeholder="Search by email or name…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm h-9 text-sm" />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-9 px-2 rounded-md bg-background border border-input text-sm font-heading">
          <option value="spend">Sort: Lifetime spend</option>
          <option value="count">Sort: # payments</option>
          <option value="last_paid">Sort: Last paid</option>
          <option value="last_seen">Sort: Last seen</option>
          <option value="email">Sort: Email A-Z</option>
        </select>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-heading text-xs">User</TableHead>
              <TableHead className="font-heading text-xs">Plan(s)</TableHead>
              <TableHead className="font-heading text-xs text-right">Spend</TableHead>
              <TableHead className="font-heading text-xs text-right">#</TableHead>
              <TableHead className="font-heading text-xs">Last paid</TableHead>
              <TableHead className="font-heading text-xs">Studio time</TableHead>
              <TableHead className="font-heading text-xs">Last seen</TableHead>
              <TableHead className="font-heading text-xs">Partner</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.profile.user_id} className="cursor-pointer" onClick={() => setSelectedUser(r.profile.user_id)}>
                <TableCell>
                  <div className="font-heading text-foreground text-sm">{r.profile.display_name || r.profile.email || "—"}</div>
                  {r.profile.display_name && r.profile.email && <div className="text-xs text-muted-foreground">{r.profile.email}</div>}
                </TableCell>
                <TableCell className="text-xs">{r.plans}</TableCell>
                <TableCell className="text-right font-heading text-primary">${r.spend.toFixed(2)}</TableCell>
                <TableCell className="text-right text-xs">{r.count}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.lastPaid ? new Date(r.lastPaid).toLocaleDateString() : "—"}</TableCell>
                <TableCell className="text-xs">{fmtMs(r.studioMs)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.profile.last_seen_at ? new Date(r.profile.last_seen_at).toLocaleDateString() : "—"}</TableCell>
                <TableCell className="text-xs">{r.partner}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground text-sm py-8">No paid users yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <UserDetailDrawer userId={selectedUser} onClose={() => setSelectedUser(null)} />
    </div>
  );
}
