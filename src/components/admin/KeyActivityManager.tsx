import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import UserDetailDrawer from "./UserDetailDrawer";
import KeySessionDetailDialog from "./KeySessionDetailDialog";

type Row = {
  key_id: string;
  user_id: string;
  user_email: string | null;
  label: string | null;
  assigned_at: string | null;
  expires_at: string | null;
  remaining_ms: number | null;
  is_active: boolean;
  active_session_id: string | null;
  is_trial: boolean;
  sessions_count: number;
  first_session_at: string | null;
  last_activity_at: string | null;
  total_used_ms: number;
  handshake_burn_ms: number;
  unlinked_mint_count: number;
  debt_collected_ms: number;
  pending_debt_ms: number;
  status: string;
};

type PendingDebt = {
  user_id: string;
  user_email: string | null;
  display_name: string | null;
  pending_ms: number;
  debt_count: number;
  oldest_debt_at: string;
};

type Filter = "all" | "never_used" | "active" | "expired_unused" | "trial";

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");
const fmtMs = (ms: number) => {
  if (!ms || ms <= 0) return "0m";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${h}h ${m}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
};

const statusStyle = (s: string) => {
  switch (s) {
    case "in_use": return { label: "In use", cls: "bg-blue-500/20 text-blue-400" };
    case "active": return { label: "Active", cls: "bg-primary/20 text-primary" };
    case "exhausted": return { label: "Exhausted", cls: "bg-destructive/20 text-destructive" };
    case "expired_unused": return { label: "Never used", cls: "bg-amber-500/20 text-amber-400" };
    case "expired_used": return { label: "Expired", cls: "bg-muted text-muted-foreground" };
    default: return { label: s, cls: "bg-muted text-muted-foreground" };
  }
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "never_used", label: "Never used" },
  { id: "active", label: "Active" },
  { id: "expired_unused", label: "Expired (unused)" },
  { id: "trial", label: "Trial only" },
];

export default function KeyActivityManager() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [days, setDays] = useState(90);
  const [search, setSearch] = useState("");
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [openKeyDetail, setOpenKeyDetail] = useState<string | null>(null);
  const [pendingDebts, setPendingDebts] = useState<PendingDebt[]>([]);
  const [showDebts, setShowDebts] = useState(false);

  const fetchRows = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const [{ data, error }, debtRes] = await Promise.all([
      supabase.rpc("admin_list_key_activity" as any, { p_days: days, p_filter: filter }),
      supabase.rpc("admin_list_pending_time_debts" as any),
    ]);
    if (!opts?.silent) setLoading(false);
    if (!error && data) setRows(data as Row[]);
    if (!debtRes.error && debtRes.data) setPendingDebts(debtRes.data as PendingDebt[]);
  }, [days, filter]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Live refresh: poll every 15s + react to studio_sessions/api_keys changes
  // so the admin view stays in sync without a manual reload.
  useEffect(() => {
    const poll = setInterval(() => { fetchRows({ silent: true }); }, 15000);
    const ch = supabase
      .channel("admin-key-activity-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "studio_sessions" }, () => fetchRows({ silent: true }))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "api_keys" }, () => fetchRows({ silent: true }))
      .subscribe();
    return () => { clearInterval(poll); supabase.removeChannel(ch); };
  }, [fetchRows]);

  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (r.user_email ?? "").toLowerCase().includes(q) || (r.label ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <h2 className="text-lg font-heading font-bold">Key Activity</h2>
          <p className="text-xs text-muted-foreground">Per-key assignment & connection history. Surfaces keys that were assigned but never connected.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-background border border-border rounded px-2 py-1 text-xs font-heading"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by email or label…"
            className="bg-background border border-border rounded px-2 py-1 text-xs w-full sm:w-56"
          />
          <Button size="sm" variant="outline" onClick={() => fetchRows()} className="font-heading text-xs">Refresh</Button>
        </div>
      </div>

      {pendingDebts.length > 0 && (
        <div className="glass rounded-xl border border-amber-500/30 p-3 text-xs">
          <button
            onClick={() => setShowDebts((v) => !v)}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <span className="text-amber-400 font-heading font-semibold">
              ⚠ {pendingDebts.length} user{pendingDebts.length === 1 ? "" : "s"} with pending time-debt (
              {fmtMs(pendingDebts.reduce((sum, d) => sum + d.pending_ms, 0))} total) — silently deducted from their
              next balance increase, no session/mint will show for it
            </span>
            <span className="text-muted-foreground">{showDebts ? "Hide" : "Show"}</span>
          </button>
          {showDebts && (
            <div className="mt-2 space-y-1">
              {pendingDebts.map((d) => (
                <button
                  key={d.user_id}
                  onClick={() => setOpenUser(d.user_id)}
                  className="w-full flex items-center justify-between gap-2 bg-muted/20 hover:bg-muted/30 rounded-lg px-3 py-1.5 text-left"
                >
                  <span className="truncate">{d.user_email ?? d.user_id.slice(0, 8)} {d.display_name ? `(${d.display_name})` : ""}</span>
                  <span className="text-amber-400 font-heading shrink-0">
                    {fmtMs(d.pending_ms)} owed since {new Date(d.oldest_debt_at).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1 rounded-full text-xs font-heading transition ${filter === f.id ? "bg-primary/20 text-primary neon-border" : "bg-muted/30 text-muted-foreground hover:bg-muted/50"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="glass rounded-xl overflow-hidden border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground font-heading uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2">Assigned</th>
                <th className="text-left px-3 py-2">Expires</th>
                <th className="text-left px-3 py-2">Connections</th>
                <th className="text-left px-3 py-2">First connect</th>
                <th className="text-left px-3 py-2">Last activity</th>
                <th className="text-left px-3 py-2">Used / Remaining</th>
                <th className="text-left px-3 py-2" title="Real Decart credential issued but the client never sent a heartbeat — penalized so the mint isn't a free burn">Handshake burns</th>
                <th className="text-left px-3 py-2" title="Reclaimed waste (short sessions / handshake burns) collected from this key once it had balance — see the Audit trail for exactly when">Debt collected</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={12} className="text-center px-3 py-6 text-muted-foreground">Loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={12} className="text-center px-3 py-6 text-muted-foreground">No keys match these filters.</td></tr>
              )}
              {!loading && filtered.map((r) => {
                const st = statusStyle(r.status);
                return (
                  <tr
                    key={r.key_id}
                    className="border-t border-border/40 hover:bg-muted/20 cursor-pointer"
                    onClick={() => setOpenUser(r.user_id)}
                  >
                    <td className="px-3 py-2 max-w-[220px] truncate" title={r.user_email ?? ""}>
                      {r.user_email ?? r.user_id.slice(0, 8)}
                      {r.pending_debt_ms > 0 && (
                        <span className="ml-1 text-amber-400" title={`${fmtMs(r.pending_debt_ms)} of pending time-debt will silently deduct from this user's next balance increase`}>⚠</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.label || "Default"}
                      {r.is_trial && <span className="ml-1 text-[10px] text-amber-400">trial</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt(r.assigned_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt(r.expires_at)}</td>
                    <td className="px-3 py-2 font-heading">{r.sessions_count}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt(r.first_session_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt(r.last_activity_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtMs(r.total_used_ms)} / {fmtMs(Number(r.remaining_ms ?? 0))}</td>
                    <td className="px-3 py-2">
                      {r.unlinked_mint_count > 0 ? (
                        <span className="text-amber-400" title={`${r.unlinked_mint_count} mint(s) never connected`}>
                          {fmtMs(r.handshake_burn_ms)} ({r.unlinked_mint_count})
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.debt_collected_ms > 0 ? (
                        <span className="text-amber-400" title="Reclaimed time-debt taken from this key's balance — see Audit for the collection event(s)">
                          {fmtMs(r.debt_collected_ms)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded ${st.cls} font-heading`}>{st.label}</span></td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="font-heading text-xs h-6 px-2"
                        onClick={(e) => { e.stopPropagation(); setOpenKeyDetail(r.key_id); }}
                      >
                        Audit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <UserDetailDrawer userId={openUser} onClose={() => setOpenUser(null)} />
      <KeySessionDetailDialog keyId={openKeyDetail} onClose={() => setOpenKeyDetail(null)} />
    </div>
  );
}
