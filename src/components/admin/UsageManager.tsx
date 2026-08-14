import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

interface UsageRow {
  user_id: string | null;
  email: string | null;
  display_name: string | null;
  total_sessions: number;
  total_duration_ms: number;
  first_session_at: string | null;
  last_session_at: string | null;
  avg_duration_ms: number;
  is_currently_live: boolean;
  first_payment_at: string | null;
}

type SortKey =
  | "total_duration_ms"
  | "total_sessions"
  | "first_session_at"
  | "last_session_at"
  | "avg_duration_ms";

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function UsageManager() {
  const { toast } = useToast();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeTrial, setIncludeTrial] = useState(true);
  const [onlyLive, setOnlyLive] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_duration_ms");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const fetchData = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("admin_paid_user_usage" as any, {
      p_from: from ? new Date(from).toISOString() : null,
      p_to: to ? new Date(to).toISOString() : null,
      p_include_trial: includeTrial,
    });
    setLoading(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    setRows((data as UsageRow[]) ?? []);
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let r = rows;
    if (onlyLive) r = r.filter((x) => x.is_currently_live);
    if (q) {
      r = r.filter(
        (x) =>
          (x.email ?? "").toLowerCase().includes(q) ||
          (x.display_name ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...r].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (av == null && bv == null) cmp = 0;
      else if (av == null) cmp = -1;
      else if (bv == null) cmp = 1;
      else if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
      else cmp = (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, search, onlyLive, sortKey, sortDir]);

  const totals = useMemo(() => {
    const sumMs = filtered.reduce((acc, x) => acc + (x.total_duration_ms || 0), 0);
    const sumSessions = filtered.reduce((acc, x) => acc + (x.total_sessions || 0), 0);
    return { sumMs, sumSessions };
  }, [filtered]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const exportCsv = () => {
    const headers = [
      "email",
      "display_name",
      "total_sessions",
      "total_duration_ms",
      "total_duration_human",
      "first_session_at",
      "last_session_at",
      "avg_duration_ms",
      "currently_live",
      "first_payment_at",
    ];
    const lines = [headers.join(",")];
    for (const r of filtered) {
      lines.push(
        [
          JSON.stringify(r.email ?? ""),
          JSON.stringify(r.display_name ?? ""),
          r.total_sessions,
          r.total_duration_ms,
          JSON.stringify(fmtDuration(r.total_duration_ms)),
          r.first_session_at ?? "",
          r.last_session_at ?? "",
          r.avg_duration_ms,
          r.is_currently_live,
          r.first_payment_at ?? "",
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `paid-user-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const SortHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <TableHead>
      <button
        onClick={() => toggleSort(k)}
        className="font-heading text-xs flex items-center gap-1 hover:text-primary"
      >
        {label}
        {sortKey === k && <span>{sortDir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </TableHead>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-heading font-bold text-foreground">Paid User Usage</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} className="font-heading text-xs">
            Export CSV
          </Button>
          <Button size="sm" onClick={fetchData} disabled={loading} className="font-heading text-xs">
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="glass neon-border rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <div className="space-y-1.5">
          <Label className="font-heading text-xs">Search</Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="email or name"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="font-heading text-xs">Session from</Label>
          <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="font-heading text-xs">Session to</Label>
          <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="font-heading text-xs">Include trial</Label>
          <Switch checked={includeTrial} onCheckedChange={setIncludeTrial} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="font-heading text-xs">Only live now</Label>
          <Switch checked={onlyLive} onCheckedChange={setOnlyLive} />
        </div>
        <div className="md:col-span-5">
          <Button size="sm" onClick={fetchData} disabled={loading} className="font-heading text-xs">
            Apply server filters
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="glass rounded-xl p-3 text-center">
          <div className="text-xs text-muted-foreground font-heading">Paid users</div>
          <div className="text-2xl font-heading font-bold">{filtered.length}</div>
        </div>
        <div className="glass rounded-xl p-3 text-center">
          <div className="text-xs text-muted-foreground font-heading">Total sessions</div>
          <div className="text-2xl font-heading font-bold">{totals.sumSessions}</div>
        </div>
        <div className="glass rounded-xl p-3 text-center">
          <div className="text-xs text-muted-foreground font-heading">Total time</div>
          <div className="text-2xl font-heading font-bold">{fmtDuration(totals.sumMs)}</div>
        </div>
      </div>

      <div className="glass neon-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="font-heading text-xs">User</TableHead>
              <SortHeader k="total_sessions" label="Sessions" />
              <SortHeader k="total_duration_ms" label="Total time" />
              <SortHeader k="avg_duration_ms" label="Avg" />
              <SortHeader k="first_session_at" label="First connection" />
              <SortHeader k="last_session_at" label="Last connection" />
              <TableHead className="font-heading text-xs">Live</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r, i) => (
              <TableRow key={r.user_id ?? `deleted-${i}`}>
                <TableCell className="text-xs">
                  <div className="font-heading">{r.email ?? (r.user_id ? r.user_id.slice(0, 8) : "deleted account")}</div>
                  {r.display_name && (
                    <div className="text-muted-foreground">{r.display_name}</div>
                  )}
                </TableCell>
                <TableCell className="text-xs font-mono">{r.total_sessions}</TableCell>
                <TableCell className="text-xs font-mono">
                  {fmtDuration(r.total_duration_ms)}
                </TableCell>
                <TableCell className="text-xs font-mono">
                  {fmtDuration(r.avg_duration_ms)}
                </TableCell>
                <TableCell className="text-xs">{fmtDate(r.first_session_at)}</TableCell>
                <TableCell className="text-xs">{fmtDate(r.last_session_at)}</TableCell>
                <TableCell className="text-xs">
                  {r.is_currently_live ? (
                    <span className="inline-flex items-center gap-1 text-primary">
                      <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      Live
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                  {loading ? "Loading…" : "No paid users match the filters."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
