import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight } from "lucide-react";

type KeyType = "paid" | "trial";

interface KeyRow {
  key_id: string;
  user_id: string | null;
  email: string | null;
  display_name: string | null;
  label: string | null;
  key_type: KeyType;
  is_active: boolean;
  is_live: boolean;
  created_at: string | null;
  expires_at: string | null;
  allocated_ms: number;
  used_ms: number;
  remaining_ms: number;
  sessions: number;
  last_session_at: string | null;
}

interface UserRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  keys_count: number;
  allocated_ms: number;
  used_ms: number;
  remaining_ms: number;
  sessions: number;
  last_session_at: string | null;
  is_live: boolean;
  has_paid: boolean;
  has_trial: boolean;
}

interface Totals {
  allocated_ms: number;
  used_ms: number;
  remaining_ms: number;
  allocated_ms_paid: number;
  used_ms_paid: number;
  remaining_ms_paid: number;
  allocated_ms_trial: number;
  used_ms_trial: number;
  remaining_ms_trial: number;
  keys_total: number;
  keys_active: number;
  keys_live: number;
  used_ms_24h: number;
  used_ms_7d: number;
}

interface Ledger {
  generated_at: string;
  credits_per_second: number;
  totals: Totals;
  users: UserRow[];
  keys: KeyRow[];
}

type SortKey = "remaining_ms" | "used_ms" | "allocated_ms" | "sessions" | "last_session_at";
type TypeFilter = "all" | "paid" | "trial";
type StatusFilter = "all" | "active" | "inactive" | "live" | "exhausted";

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function credits(ms: number, cps: number): string {
  const c = Math.round((ms / 1000) * cps);
  return c.toLocaleString();
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

export default function TimeLedgerManager() {
  const { toast } = useToast();
  const [data, setData] = useState<Ledger | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("remaining_ms");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchData = async () => {
    setLoading(true);
    const { data: rpc, error } = await supabase.rpc("admin_time_ledger" as any);
    setLoading(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    setData(rpc as unknown as Ledger);
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(fetchData, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  const cps = data?.credits_per_second ?? 3.2;

  const filteredKeys = useMemo(() => {
    if (!data) return [] as KeyRow[];
    const q = search.trim().toLowerCase();
    return data.keys.filter((k) => {
      if (typeFilter !== "all" && k.key_type !== typeFilter) return false;
      if (statusFilter === "active" && !k.is_active) return false;
      if (statusFilter === "inactive" && k.is_active) return false;
      if (statusFilter === "live" && !k.is_live) return false;
      if (statusFilter === "exhausted" && k.remaining_ms > 0) return false;
      if (q) {
        const hay = [k.email, k.display_name, k.user_id, k.key_id, k.label]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, search, typeFilter, statusFilter]);

  const filteredUsers = useMemo(() => {
    if (!data) return [] as (UserRow & { keys: KeyRow[] })[];
    const byUser = new Map<string, KeyRow[]>();
    for (const k of filteredKeys) {
      if (!k.user_id) continue;
      const arr = byUser.get(k.user_id) ?? [];
      arr.push(k);
      byUser.set(k.user_id, arr);
    }
    const rows = data.users
      .filter((u) => byUser.has(u.user_id))
      .map((u) => {
        // Recompute totals from filtered keys so the user row respects filters.
        const keys = byUser.get(u.user_id)!;
        const allocated_ms = keys.reduce((a, k) => a + k.allocated_ms, 0);
        const used_ms = keys.reduce((a, k) => a + k.used_ms, 0);
        const remaining_ms = keys.reduce((a, k) => a + k.remaining_ms, 0);
        const sessions = keys.reduce((a, k) => a + k.sessions, 0);
        const is_live = keys.some((k) => k.is_live);
        const last_session_at = keys
          .map((k) => k.last_session_at)
          .filter(Boolean)
          .sort()
          .slice(-1)[0] ?? null;
        return { ...u, allocated_ms, used_ms, remaining_ms, sessions, is_live, last_session_at, keys_count: keys.length, keys };
      });
    rows.sort((a, b) => {
      const av = (a as any)[sortKey];
      const bv = (b as any)[sortKey];
      let cmp = 0;
      if (av == null && bv == null) cmp = 0;
      else if (av == null) cmp = -1;
      else if (bv == null) cmp = 1;
      else if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
      else cmp = (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data, filteredKeys, sortKey, sortDir]);

  const filteredTotals = useMemo(() => {
    const allocated_ms = filteredKeys.reduce((a, k) => a + k.allocated_ms, 0);
    const used_ms = filteredKeys.reduce((a, k) => a + k.used_ms, 0);
    const remaining_ms = filteredKeys.reduce((a, k) => a + k.remaining_ms, 0);
    const live = filteredKeys.filter((k) => k.is_live).length;
    return { allocated_ms, used_ms, remaining_ms, live };
  }, [filteredKeys]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const toggleExpand = (uid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const exportCsv = () => {
    const headers = [
      "user_id","email","display_name","key_id","label","type","active","live",
      "allocated_ms","used_ms","remaining_ms","allocated_credits","used_credits","remaining_credits",
      "sessions","created_at","expires_at","last_session_at",
    ];
    const lines = [headers.join(",")];
    for (const k of filteredKeys) {
      lines.push([
        k.user_id ?? "",
        JSON.stringify(k.email ?? ""),
        JSON.stringify(k.display_name ?? ""),
        k.key_id,
        JSON.stringify(k.label ?? ""),
        k.key_type,
        k.is_active,
        k.is_live,
        k.allocated_ms, k.used_ms, k.remaining_ms,
        Math.round((k.allocated_ms/1000)*cps),
        Math.round((k.used_ms/1000)*cps),
        Math.round((k.remaining_ms/1000)*cps),
        k.sessions,
        k.created_at ?? "", k.expires_at ?? "", k.last_session_at ?? "",
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `time-ledger-${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const t = data?.totals;

  const KpiCard = ({ label, main, sub, accent }: { label: string; main: string; sub?: string; accent?: string }) => (
    <div className="glass neon-border rounded-xl p-4">
      <div className="text-xs text-muted-foreground font-heading">{label}</div>
      <div className={`text-2xl font-heading font-bold ${accent ?? "text-foreground"}`}>{main}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1 font-mono">{sub}</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-heading font-bold text-foreground">Time Ledger</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Live totals of allocated, used and remaining studio time across every user and key.
            {data && (
              <> • Rate: <span className="font-mono">{cps}</span> credits/sec • Updated {new Date(data.generated_at).toLocaleTimeString()}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="font-heading text-xs">Auto-refresh</Label>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} className="font-heading text-xs">Export CSV</Button>
          <Button size="sm" onClick={fetchData} disabled={loading} className="font-heading text-xs">
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Total Allocated"
            main={fmtDuration(t.allocated_ms)}
            sub={`${credits(t.allocated_ms, cps)} credits`}
            accent="text-primary"
          />
          <KpiCard
            label="Total Used"
            main={fmtDuration(t.used_ms)}
            sub={`${credits(t.used_ms, cps)} credits • ${(pct(t.used_ms, t.allocated_ms)).toFixed(1)}%`}
            accent="text-amber-400"
          />
          <KpiCard
            label="Total Remaining"
            main={fmtDuration(t.remaining_ms)}
            sub={`${credits(t.remaining_ms, cps)} credits`}
            accent="text-emerald-400"
          />
          <KpiCard
            label="Live Now"
            main={`${t.keys_live}`}
            sub={`${t.keys_active} active / ${t.keys_total} total • burn ${(t.keys_live * cps).toFixed(1)} cr/s`}
            accent={t.keys_live > 0 ? "text-primary" : "text-muted-foreground"}
          />
          <KpiCard
            label="Used last 24h"
            main={fmtDuration(t.used_ms_24h)}
            sub={`${credits(t.used_ms_24h, cps)} credits`}
          />
          <KpiCard
            label="Used last 7d"
            main={fmtDuration(t.used_ms_7d)}
            sub={`${credits(t.used_ms_7d, cps)} credits`}
          />
          <KpiCard
            label="Paid — Alloc / Used / Rem"
            main={fmtDuration(t.remaining_ms_paid)}
            sub={`${fmtDuration(t.allocated_ms_paid)} / ${fmtDuration(t.used_ms_paid)}`}
          />
          <KpiCard
            label="Trial — Alloc / Used / Rem"
            main={fmtDuration(t.remaining_ms_trial)}
            sub={`${fmtDuration(t.allocated_ms_trial)} / ${fmtDuration(t.used_ms_trial)}`}
          />
        </div>
      )}

      {/* Filters */}
      <div className="glass neon-border rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <div className="space-y-1.5 md:col-span-2">
          <Label className="font-heading text-xs">Search</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="email, name, user id, key id, label" />
        </div>
        <div className="space-y-1.5">
          <Label className="font-heading text-xs">Key type</Label>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="font-heading text-xs">Status</Label>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="live">Live now</SelectItem>
              <SelectItem value="exhausted">Exhausted</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="font-heading text-xs">Sort by</Label>
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="remaining_ms">Remaining</SelectItem>
              <SelectItem value="used_ms">Used</SelectItem>
              <SelectItem value="allocated_ms">Allocated</SelectItem>
              <SelectItem value="sessions">Sessions</SelectItem>
              <SelectItem value="last_session_at">Last session</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-5 flex items-center justify-between">
          <div className="text-xs text-muted-foreground font-heading">
            Filtered: {filteredUsers.length} users • {filteredKeys.length} keys •
            {" "}Alloc {fmtDuration(filteredTotals.allocated_ms)} • Used {fmtDuration(filteredTotals.used_ms)} • Rem {fmtDuration(filteredTotals.remaining_ms)} • {filteredTotals.live} live
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setSearch(""); setTypeFilter("all"); setStatusFilter("all"); }} className="font-heading text-xs">Clear</Button>
            <Button size="sm" variant="outline" onClick={() => setSortDir((d) => d === "asc" ? "desc" : "asc")} className="font-heading text-xs">
              {sortDir === "asc" ? "▲ Asc" : "▼ Desc"}
            </Button>
          </div>
        </div>
      </div>

      {/* Per-user table */}
      <div className="glass neon-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="font-heading text-xs">User</TableHead>
              <TableHead className="font-heading text-xs">Keys</TableHead>
              <TableHead className="font-heading text-xs cursor-pointer" onClick={() => toggleSort("allocated_ms")}>Allocated</TableHead>
              <TableHead className="font-heading text-xs cursor-pointer" onClick={() => toggleSort("used_ms")}>Used</TableHead>
              <TableHead className="font-heading text-xs cursor-pointer" onClick={() => toggleSort("remaining_ms")}>Remaining</TableHead>
              <TableHead className="font-heading text-xs cursor-pointer" onClick={() => toggleSort("sessions")}>Sessions</TableHead>
              <TableHead className="font-heading text-xs cursor-pointer" onClick={() => toggleSort("last_session_at")}>Last</TableHead>
              <TableHead className="font-heading text-xs">Live</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUsers.map((u) => {
              const isOpen = expanded.has(u.user_id);
              const remPct = pct(u.remaining_ms, u.allocated_ms);
              return (
                <Fragment key={u.user_id}>
                  <TableRow key={u.user_id} className="cursor-pointer" onClick={() => toggleExpand(u.user_id)}>
                    <TableCell>
                      {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-heading">{u.display_name || u.email || u.user_id.slice(0, 8)}</div>
                      {u.email && u.display_name && <div className="text-muted-foreground">{u.email}</div>}
                      <div className="flex gap-1 mt-0.5">
                        {u.has_paid && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">paid</span>}
                        {u.has_trial && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">trial</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-mono">{u.keys_count}</TableCell>
                    <TableCell className="text-xs">
                      <div className="font-mono">{fmtDuration(u.allocated_ms)}</div>
                      <div className="text-[10px] text-muted-foreground">{credits(u.allocated_ms, cps)} cr</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-mono">{fmtDuration(u.used_ms)}</div>
                      <div className="text-[10px] text-muted-foreground">{credits(u.used_ms, cps)} cr</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-mono">{fmtDuration(u.remaining_ms)}</div>
                      <div className="text-[10px] text-muted-foreground">{credits(u.remaining_ms, cps)} cr</div>
                      <div className="w-24 h-1.5 bg-muted/40 rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${remPct}%` }} />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-mono">{u.sessions}</TableCell>
                    <TableCell className="text-xs">{fmtDate(u.last_session_at)}</TableCell>
                    <TableCell className="text-xs">
                      {u.is_live ? (
                        <span className="inline-flex items-center gap-1 text-primary">
                          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                          Live
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow key={u.user_id + ":keys"}>
                      <TableCell colSpan={9} className="bg-muted/10">
                        <div className="p-2 space-y-1">
                          {u.keys.map((k) => {
                            const kRemPct = pct(k.remaining_ms, k.allocated_ms);
                            return (
                              <div key={k.key_id} className="grid grid-cols-12 gap-2 text-xs items-center px-2 py-1.5 rounded bg-background/40">
                                <div className="col-span-3">
                                  <div className="font-heading flex items-center gap-2">
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${k.key_type === "paid" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-400"}`}>{k.key_type}</span>
                                    {k.label || k.key_id.slice(0, 8)}
                                    {k.is_live && <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground font-mono truncate">{k.key_id}</div>
                                </div>
                                <div className="col-span-2">
                                  <div className="text-[10px] text-muted-foreground">Allocated</div>
                                  <div className="font-mono">{fmtDuration(k.allocated_ms)}</div>
                                  <div className="text-[10px] text-muted-foreground">{credits(k.allocated_ms, cps)} cr</div>
                                </div>
                                <div className="col-span-2">
                                  <div className="text-[10px] text-muted-foreground">Used</div>
                                  <div className="font-mono">{fmtDuration(k.used_ms)}</div>
                                  <div className="text-[10px] text-muted-foreground">{credits(k.used_ms, cps)} cr</div>
                                </div>
                                <div className="col-span-2">
                                  <div className="text-[10px] text-muted-foreground">Remaining</div>
                                  <div className="font-mono">{fmtDuration(k.remaining_ms)}</div>
                                  <div className="w-full h-1 bg-muted/40 rounded-full mt-1 overflow-hidden">
                                    <div className="h-full bg-primary" style={{ width: `${kRemPct}%` }} />
                                  </div>
                                </div>
                                <div className="col-span-1 text-center">
                                  <div className="text-[10px] text-muted-foreground">Sessions</div>
                                  <div className="font-mono">{k.sessions}</div>
                                </div>
                                <div className="col-span-2">
                                  <div className="text-[10px] text-muted-foreground">Last / Expires</div>
                                  <div className="font-mono text-[11px]">{fmtDate(k.last_session_at)}</div>
                                  <div className="font-mono text-[10px] text-muted-foreground">{k.expires_at ? `exp ${fmtDate(k.expires_at)}` : "no expiry"}</div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
            {filteredUsers.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                  {loading ? "Loading…" : "No keys match the filters."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
