import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

interface LiveRow {
  id: string;                 // studio_sessions.id (stable React key per session)
  session_id: string;
  api_key_id: string;
  user_id: string;
  label: string | null;
  is_trial: boolean;
  started_at: string;
  last_heartbeat_at: string;
  expires_at: string | null;
  remaining_ms: number | null;
}

interface RecentRow {
  id: string;
  user_id: string;
  label: string | null;
  remaining_ms: number | null;
  expires_at: string | null;
  is_active: boolean;
  last_session_ended_at?: string | null;
}

interface ActiveKeyRow {
  id: string;
  user_id: string;
  label: string | null;
  is_active: boolean;
  remaining_ms: number | null;
  expires_at: string | null;
  active_session_id: string | null;
  active_session_started_at: string | null;
  last_session_ended_at: string | null;
  created_at: string;
}

interface HistoryRow {
  id: string;
  api_key_id: string;
  user_id: string;
  key_label: string | null;
  is_trial: boolean;
  session_id: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  end_reason: string | null;
  duration_ms: number | null;
  remaining_ms_at_start: number | null;
  remaining_ms_at_end: number | null;
}

// Server-time offset (serverNowMs - Date.now()) refreshed periodically from
// `server_now_ms` RPC. Applied to every "now" reference in this admin view so
// a skewed device wall clock (the classic cause of "0m 00s" connected +
// negative heartbeat age on a live session) no longer corrupts durations.
let SERVER_OFFSET_MS = 0;
const serverNow = () => Date.now() + SERVER_OFFSET_MS;

function fmtRel(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((serverNow() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ${s}s`;
  }
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// Always render in GMT/UTC, independent of admin's locale.
function fmtUTC(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function statusOf(row: LiveRow): { label: string; cls: string; ageSec: number } {
  const ageSec = row.last_heartbeat_at
    ? Math.max(0, Math.floor((serverNow() - new Date(row.last_heartbeat_at).getTime()) / 1000))
    : 9999;
  if (ageSec < 60) return { label: "Live", cls: "bg-primary/20 text-primary", ageSec };
  if (ageSec < 90) return { label: "Stale", cls: "bg-amber-500/20 text-amber-400", ageSec };
  return { label: "Orphaned", cls: "bg-destructive/20 text-destructive", ageSec };
}

type HistorySortKey =
  | "started_desc" | "started_asc"
  | "ended_desc" | "ended_asc"
  | "duration_desc" | "duration_asc"
  | "user_asc" | "key_asc" | "reason_asc"
  | "most_connected";

type HistoryFilter = "all" | "paid" | "trial" | "live" | "ended_today" | "ended_week";

export default function LiveConnectionsManager() {
  const { toast } = useToast();
  const [live, setLive] = useState<LiveRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [activeKeys, setActiveKeys] = useState<ActiveKeyRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const releasingRef = useRef<Set<string>>(new Set());

  const [historySort, setHistorySort] = useState<HistorySortKey>("started_desc");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    let alive = true;

    // Sync client<->server clock offset so all duration/age math below
    // is immune to admin device wall-clock skew.
    const syncClock = async () => {
      const t0 = Date.now();
      const { data, error } = await supabase.rpc("server_now_ms" as any);
      if (!alive || error || data == null) return;
      const rtt = Date.now() - t0;
      SERVER_OFFSET_MS = Number(data) + Math.floor(rtt / 2) - Date.now();
      setTick((t) => t + 1);
    };
    void syncClock();
    const clockInterval = setInterval(syncClock, 30000);



    // Live sessions come from studio_sessions (ended_at IS NULL) so multiple
    // concurrent users / keys are all represented, not just whatever
    // happens to be stamped on api_keys.active_session_id.
    const fetchLive = async () => {
      const { data: sessions, error: sErr } = await supabase
        .from("studio_sessions" as any)
        .select("id, session_id, api_key_id, user_id, key_label, is_trial, started_at, last_heartbeat_at")
        .is("ended_at", null)
        .order("started_at", { ascending: false });
      if (!alive) return;
      if (sErr) { console.error("[LiveConnections] fetchLive sessions error", sErr); return; }
      const rows = ((sessions ?? []) as unknown) as Array<{
        id: string; session_id: string; api_key_id: string; user_id: string;
        key_label: string | null; is_trial: boolean;
        started_at: string; last_heartbeat_at: string;
      }>;

      // Enrich with current expires_at / remaining_ms from api_keys.
      const keyIds = Array.from(new Set(rows.map((r) => r.api_key_id)));
      let keyMap = new Map<string, { expires_at: string | null; remaining_ms: number | null; label: string | null }>();
      if (keyIds.length > 0) {
        const { data: keys } = await supabase
          .from("api_keys")
          .select("id, expires_at, remaining_ms, label")
          .in("id", keyIds);
        (keys ?? []).forEach((k: any) => keyMap.set(k.id, {
          expires_at: k.expires_at ?? null,
          remaining_ms: k.remaining_ms ?? null,
          label: k.label ?? null,
        }));
      }

      const merged: LiveRow[] = rows.map((r) => {
        const k = keyMap.get(r.api_key_id);
        return {
          id: r.id,
          session_id: r.session_id,
          api_key_id: r.api_key_id,
          user_id: r.user_id,
          label: r.key_label ?? k?.label ?? null,
          is_trial: !!r.is_trial,
          started_at: r.started_at,
          last_heartbeat_at: r.last_heartbeat_at,
          expires_at: k?.expires_at ?? null,
          remaining_ms: k?.remaining_ms ?? null,
        };
      });
      setLive(merged);
    };

    const fetchRecent = async () => {
      const since = new Date(serverNow() - 10 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("api_keys")
        .select("id, user_id, label, remaining_ms, expires_at, is_active, last_session_ended_at")
        .is("active_session_id", null)
        .not("last_session_ended_at", "is", null)
        .gte("last_session_ended_at", since)
        .order("last_session_ended_at", { ascending: false })
        .limit(20);
      if (!alive) return;
      if (error) {
        console.error("[LiveConnections] fetchRecent error", error);
        return;
      }
      setRecent(((data ?? []) as any) as RecentRow[]);
    };

    // Include trial keys so the count matches the API Keys tab.
    const fetchActiveKeys = async () => {
      const { data, error } = await supabase
        .from("api_keys")
        .select("id, user_id, label, is_active, remaining_ms, expires_at, active_session_id, active_session_started_at, last_session_ended_at, created_at")
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (!alive) return;
      if (error) { console.error("[LiveConnections] fetchActiveKeys error", error); return; }
      setActiveKeys((data ?? []) as ActiveKeyRow[]);
    };

    const fetchHistory = async () => {
      const { data, error } = await supabase
        .from("studio_sessions" as any)
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1000);
      if (!alive) return;
      if (error) { console.error("[LiveConnections] fetchHistory error", error); return; }
      setHistory(((data ?? []) as unknown) as HistoryRow[]);
    };

    fetchLive();
    fetchRecent();
    fetchActiveKeys();
    fetchHistory();

    // Realtime: react instantly to session start / heartbeat / end and to
    // key changes that affect remaining time.
    const channel = supabase
      .channel("admin-live-connections")
      .on("postgres_changes", { event: "*", schema: "public", table: "studio_sessions" }, () => {
        fetchLive();
        fetchHistory();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "api_keys" }, () => {
        fetchLive();
        fetchActiveKeys();
        fetchRecent();
      })
      .subscribe();

    // Safety-net polling in case the realtime socket drops.
    const a = setInterval(fetchLive, 5000);
    const b = setInterval(fetchRecent, 15000);
    const d = setInterval(fetchActiveKeys, 10000);
    const e = setInterval(fetchHistory, 30000);
    const c = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      supabase.removeChannel(channel);
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
      clearInterval(d);
      clearInterval(e);
      clearInterval(clockInterval);
    };
  }, []);


  useEffect(() => {
    const ids = new Set<string>();
    live.forEach((r) => ids.add(r.user_id));
    recent.forEach((r) => ids.add(r.user_id));
    activeKeys.forEach((r) => ids.add(r.user_id));
    history.forEach((r) => ids.add(r.user_id));
    const missing = Array.from(ids).filter((id) => !(id in emails));
    if (missing.length === 0) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, email")
        .in("user_id", missing);
      if (!data) return;
      setEmails((prev) => {
        const next = { ...prev };
        (data as any[]).forEach((p) => {
          next[p.user_id] = p.email ?? p.user_id.slice(0, 8);
        });
        missing.forEach((id) => {
          if (!(id in next)) next[id] = id.slice(0, 8);
        });
        return next;
      });
    })();
  }, [live, recent, activeKeys, history, emails]);

  const counts = useMemo(() => {
    let l = 0, s = 0, o = 0;
    live.forEach((r) => {
      const st = statusOf(r);
      if (st.label === "Live") l++;
      else if (st.label === "Stale") s++;
      else o++;
    });
    return { live: l, stale: s, orphaned: o };
  }, [live, tick]);

  const activeKeyCounts = useMemo(() => {
    let trial = 0, paid = 0;
    activeKeys.forEach((k) => {
      const isTrial = (k.label ?? "").toLowerCase().startsWith("free trial");
      if (isTrial) trial++; else paid++;
    });
    return { total: activeKeys.length, trial, paid };
  }, [activeKeys]);

  const closeViaRpc = async (apiKeyId: string, reason: "force_release" | "orphaned_auto") => {
    const { error } = await supabase.rpc("close_studio_session" as any, {
      p_api_key_id: apiKeyId,
      p_reason: reason,
    });
    if (error) throw error;
  };

  const releaseRow = async (row: LiveRow, opts: { silent?: boolean; reason?: "force_release" | "orphaned_auto" } = {}) => {
    if (releasingRef.current.has(row.id)) return;
    releasingRef.current.add(row.id);
    try {
      await closeViaRpc(row.api_key_id, opts.reason ?? "force_release");
      if (!opts.silent) {
        toast({ title: "Session released" });
      }
      setLive((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e: any) {
      if (!opts.silent) {
        toast({ title: "Release failed", description: e?.message ?? String(e), variant: "destructive" });
      } else {
        console.error("[LiveConnections] auto-release failed", e);
      }
    } finally {
      releasingRef.current.delete(row.id);
    }
  };

  const forceRelease = (row: LiveRow) => releaseRow(row, { silent: false, reason: "force_release" });

  const releaseActive = async (row: ActiveKeyRow) => {
    if (releasingRef.current.has(row.id)) return;
    releasingRef.current.add(row.id);
    try {
      await closeViaRpc(row.id, "force_release");
      toast({ title: "Session released" });
      setActiveKeys((prev) =>
        prev.map((p) =>
          p.id === row.id
            ? { ...p, active_session_id: null, active_session_started_at: null, last_session_ended_at: new Date().toISOString() }
            : p
        )
      );
      setLive((prev) => prev.filter((r) => r.api_key_id !== row.id));
    } catch (e: any) {
      toast({ title: "Release failed", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      releasingRef.current.delete(row.id);
    }
  };


  const deactivateKey = async (row: ActiveKeyRow) => {
    if (!confirm(`Deactivate ${row.label ?? "this key"} for ${emails[row.user_id] ?? row.user_id.slice(0, 8)}? They will lose access immediately.`)) return;
    try {
      const update: any = {
        is_active: false,
        active_session_id: null,
        active_session_started_at: null,
        last_session_ended_at: new Date().toISOString(),
      };
      const { error } = await supabase.from("api_keys").update(update).eq("id", row.id);
      if (error) throw error;
      toast({ title: "Key deactivated", description: "User access revoked." });
      setActiveKeys((prev) => prev.filter((p) => p.id !== row.id));
    } catch (e: any) {
      toast({ title: "Deactivate failed", description: e?.message ?? String(e), variant: "destructive" });
    }
  };

  // Auto-release orphaned sessions (calls the RPC so it gets logged)
  useEffect(() => {
    live.forEach((r) => {
      const st = statusOf(r);
      if (st.label === "Orphaned" && !releasingRef.current.has(r.id)) {
        releaseRow(r, { silent: true, reason: "orphaned_auto" });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, tick]);

  // ---- History view (filter + sort + paginate) ----
  const historyView = useMemo(() => {
    const todayUTC = new Date();
    const startOfTodayUTC = Date.UTC(
      todayUTC.getUTCFullYear(), todayUTC.getUTCMonth(), todayUTC.getUTCDate(),
    );
    const startOfWeekUTC = startOfTodayUTC - 6 * 24 * 60 * 60 * 1000;
    const q = historySearch.trim().toLowerCase();

    let rows = history.filter((r) => {
      if (historyFilter === "paid" && r.is_trial) return false;
      if (historyFilter === "trial" && !r.is_trial) return false;
      if (historyFilter === "live" && r.ended_at !== null) return false;
      if (historyFilter === "ended_today") {
        if (!r.ended_at) return false;
        if (new Date(r.ended_at).getTime() < startOfTodayUTC) return false;
      }
      if (historyFilter === "ended_week") {
        if (!r.ended_at) return false;
        if (new Date(r.ended_at).getTime() < startOfWeekUTC) return false;
      }
      if (q) {
        const email = (emails[r.user_id] ?? "").toLowerCase();
        const label = (r.key_label ?? "").toLowerCase();
        if (!email.includes(q) && !label.includes(q)) return false;
      }
      return true;
    });

    const liveDurationMs = (r: HistoryRow) =>
      r.duration_ms ?? Math.max(0, serverNow() - new Date(r.started_at).getTime());

    if (historySort === "most_connected") {
      const counts = new Map<string, number>();
      rows.forEach((r) => counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1));
      rows.sort((a, b) => (counts.get(b.user_id)! - counts.get(a.user_id)!) || (new Date(b.started_at).getTime() - new Date(a.started_at).getTime()));
    } else {
      const cmpStarted = (a: HistoryRow, b: HistoryRow) =>
        new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
      const cmpEnded = (a: HistoryRow, b: HistoryRow) => {
        const av = a.ended_at ? new Date(a.ended_at).getTime() : Infinity;
        const bv = b.ended_at ? new Date(b.ended_at).getTime() : Infinity;
        return av - bv;
      };
      const cmpDuration = (a: HistoryRow, b: HistoryRow) => liveDurationMs(a) - liveDurationMs(b);
      const cmpUser = (a: HistoryRow, b: HistoryRow) =>
        (emails[a.user_id] ?? "").localeCompare(emails[b.user_id] ?? "");
      const cmpKey = (a: HistoryRow, b: HistoryRow) =>
        (a.key_label ?? "").localeCompare(b.key_label ?? "");
      const cmpReason = (a: HistoryRow, b: HistoryRow) =>
        (a.end_reason ?? "").localeCompare(b.end_reason ?? "");

      const sorters: Record<Exclude<HistorySortKey, "most_connected">, (a: HistoryRow, b: HistoryRow) => number> = {
        started_desc: (a, b) => -cmpStarted(a, b),
        started_asc:  cmpStarted,
        ended_desc:   (a, b) => -cmpEnded(a, b),
        ended_asc:    cmpEnded,
        duration_desc:(a, b) => -cmpDuration(a, b),
        duration_asc: cmpDuration,
        user_asc:     cmpUser,
        key_asc:      cmpKey,
        reason_asc:   cmpReason,
      };
      rows.sort(sorters[historySort]);
    }

    return rows;
  }, [history, historyFilter, historySearch, historySort, emails, tick]);

  const pagedHistory = useMemo(() => {
    const start = historyPage * PAGE_SIZE;
    return historyView.slice(start, start + PAGE_SIZE);
  }, [historyView, historyPage]);

  useEffect(() => { setHistoryPage(0); }, [historyFilter, historySearch, historySort]);

  const toggleSort = (asc: HistorySortKey, desc: HistorySortKey) =>
    setHistorySort((cur) => (cur === desc ? asc : desc));

  const exportCsv = () => {
    const header = ["user_email","key_label","type","session_id","started_at_utc","ended_at_utc","duration_ms","end_reason","remaining_ms_at_start","remaining_ms_at_end"];
    const lines = [header.join(",")];
    historyView.forEach((r) => {
      const liveDur = r.duration_ms ?? Math.max(0, serverNow() - new Date(r.started_at).getTime());
      const cells = [
        emails[r.user_id] ?? r.user_id,
        r.key_label ?? "",
        r.is_trial ? "trial" : "paid",
        r.session_id,
        new Date(r.started_at).toISOString(),
        r.ended_at ? new Date(r.ended_at).toISOString() : "",
        String(liveDur),
        r.end_reason ?? (r.ended_at ? "" : "live"),
        r.remaining_ms_at_start ?? "",
        r.remaining_ms_at_end ?? "",
      ];
      lines.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `studio-connections-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reasonBadge = (r: HistoryRow) => {
    if (!r.ended_at) return <span className="px-2 py-0.5 rounded-full font-heading bg-primary/20 text-primary">live</span>;
    const reason = r.end_reason ?? "unknown";
    const cls =
      reason === "user_pause" ? "bg-muted/40 text-muted-foreground"
      : reason === "expired" ? "bg-amber-500/20 text-amber-400"
      : reason === "force_release" ? "bg-destructive/20 text-destructive"
      : reason === "orphaned_auto" ? "bg-destructive/15 text-destructive"
      : "bg-muted/30 text-muted-foreground";
    return <span className={`px-2 py-0.5 rounded-full font-heading ${cls}`}>{reason}</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Live Studio Connections</h2>
        <span className="text-xs text-muted-foreground font-heading">realtime · times in GMT/UTC</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="glass neon-border rounded-xl p-4 text-center space-y-1">
          <div className="text-3xl font-heading font-bold text-primary">{counts.live}</div>
          <div className="text-xs text-muted-foreground font-heading">Live now</div>
        </div>
        <div className="glass rounded-xl p-4 text-center space-y-1 border border-amber-500/30">
          <div className="text-3xl font-heading font-bold text-amber-400">{counts.stale}</div>
          <div className="text-xs text-muted-foreground font-heading">Stale (60–90s)</div>
        </div>
        <div className="glass rounded-xl p-4 text-center space-y-1 border border-destructive/30">
          <div className="text-3xl font-heading font-bold text-destructive">{counts.orphaned}</div>
          <div className="text-xs text-muted-foreground font-heading">Orphaned (draining)</div>
        </div>
      </div>

      <div className="glass neon-border rounded-xl p-4 space-y-2">
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No active studio sessions right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground font-heading">
                <tr className="text-left border-b border-border">
                  <th className="py-2 px-2">User</th>
                  <th className="py-2 px-2">Key</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Session</th>
                  <th className="py-2 px-2">Started (UTC)</th>
                  <th className="py-2 px-2">Connected for</th>
                  <th className="py-2 px-2">Heartbeat</th>
                  <th className="py-2 px-2">Time left</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {live.map((r) => {
                  const st = statusOf(r);
                  const remainingMs = r.expires_at
                    ? Math.max(0, new Date(r.expires_at).getTime() - serverNow())
                    : r.remaining_ms ?? 0;
                  const isTrial = r.is_trial || (r.label ?? "").toLowerCase().startsWith("free trial");
                  const connectedMs = Math.max(0, serverNow() - new Date(r.started_at).getTime());
                  return (
                    <tr key={r.id} className="border-b border-border/40 hover:bg-muted/10">
                      <td className="py-2 px-2 text-foreground">{emails[r.user_id] ?? r.user_id.slice(0, 8)}</td>
                      <td className="py-2 px-2 font-heading">{r.label ?? "—"}</td>
                      <td className="py-2 px-2">
                        <span className={`px-2 py-0.5 rounded-full font-heading ${isTrial ? "bg-amber-500/15 text-amber-400" : "bg-primary/15 text-primary"}`}>
                          {isTrial ? "Free Trial" : "Paid"}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-mono text-muted-foreground" title={r.session_id}>{r.session_id.slice(0, 8)}…</td>
                      <td className="py-2 px-2 font-mono text-muted-foreground">{fmtUTC(r.started_at)}</td>
                      <td className="py-2 px-2 font-mono text-foreground">{fmtDuration(connectedMs)}</td>
                      <td className="py-2 px-2 text-muted-foreground">{st.ageSec}s</td>
                      <td className="py-2 px-2 font-mono text-foreground">{fmtDuration(remainingMs)}</td>
                      <td className="py-2 px-2">
                        <span className={`px-2 py-0.5 rounded-full font-heading font-semibold ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="py-2 px-2">
                        <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => forceRelease(r)}>
                          Force release
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

          </div>
        )}
      </div>

      <details className="glass rounded-xl p-4">
        <summary className="cursor-pointer text-sm font-heading text-foreground">Recently disconnected (last 10 min)</summary>
        <div className="mt-3 space-y-2">
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing recent.</p>
          ) : (
            recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-xs bg-muted/15 rounded-lg px-3 py-2">
                <span className="text-foreground">{emails[r.user_id] ?? r.user_id.slice(0, 8)}</span>
                <span className="font-heading text-muted-foreground">{r.label ?? "—"}</span>
                <span className="font-mono">{fmtDuration(r.remaining_ms ?? 0)} left</span>
                <span className={`px-2 py-0.5 rounded-full font-heading ${r.is_active ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"}`}>
                  {r.is_active ? "Active" : "Inactive"}
                </span>
              </div>
            ))
          )}
        </div>
      </details>

      <div className="glass rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-heading font-bold text-foreground">
            Active keys: {activeKeyCounts.total}{" "}
            <span className="text-xs text-muted-foreground font-normal">
              ({activeKeyCounts.paid} paid · {activeKeyCounts.trial} trial)
            </span>
          </h3>
          <span className="text-[10px] text-muted-foreground font-heading">refreshes every 3s</span>
        </div>
        {activeKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No active keys right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground font-heading">
                <tr className="text-left border-b border-border">
                  <th className="py-2 px-2">User</th>
                  <th className="py-2 px-2">Key</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2">Activity</th>
                  <th className="py-2 px-2">Last seen</th>
                  <th className="py-2 px-2">Time left</th>
                  <th className="py-2 px-2 text-right">Override</th>
                </tr>
              </thead>
              <tbody>
                {activeKeys.map((r) => {
                  const inSession = !!r.active_session_id;
                  const ageSec = r.active_session_started_at
                    ? Math.floor((serverNow() - new Date(r.active_session_started_at).getTime()) / 1000)
                    : null;
                  const isLive = inSession && ageSec !== null && ageSec < 60;
                  const isStale = inSession && ageSec !== null && ageSec >= 60 && ageSec < 90;
                  const remainingMs = r.expires_at
                    ? Math.max(0, new Date(r.expires_at).getTime() - serverNow())
                    : r.remaining_ms ?? 0;
                  const lastSeen = r.active_session_started_at ?? r.last_session_ended_at;
                  const isTrial = (r.label ?? "").toLowerCase().startsWith("free trial");
                  return (
                    <tr key={r.id} className="border-b border-border/40 hover:bg-muted/10">
                      <td className="py-2 px-2 text-foreground">{emails[r.user_id] ?? r.user_id.slice(0, 8)}</td>
                      <td className="py-2 px-2 font-heading">{r.label ?? "—"}</td>
                      <td className="py-2 px-2">
                        <span className={`px-2 py-0.5 rounded-full font-heading ${isTrial ? "bg-amber-500/15 text-amber-400" : "bg-primary/15 text-primary"}`}>
                          {isTrial ? "Trial" : "Paid"}
                        </span>
                      </td>
                      <td className="py-2 px-2">
                        <span className={`px-2 py-0.5 rounded-full font-heading ${
                          isLive ? "bg-primary/15 text-primary"
                          : isStale ? "bg-amber-500/15 text-amber-400"
                          : inSession ? "bg-destructive/15 text-destructive"
                          : "bg-muted/30 text-muted-foreground"
                        }`}>
                          {isLive ? "Streaming" : isStale ? "Stale" : inSession ? "Orphaned" : "Idle"}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">{fmtRel(lastSeen)}</td>
                      <td className="py-2 px-2 font-mono text-foreground">{fmtDuration(remainingMs)}</td>
                      <td className="py-2 px-2 text-right space-x-2 whitespace-nowrap">
                        {inSession && (
                          <Button size="sm" variant="outline" className="font-heading text-xs" onClick={() => releaseActive(r)}>
                            End session
                          </Button>
                        )}
                        <Button size="sm" variant="destructive" className="font-heading text-xs" onClick={() => deactivateKey(r)}>
                          Revoke key
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- Connection history ---------- */}
      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-heading font-bold text-foreground">
            Connection history <span className="text-xs text-muted-foreground font-normal">({historyView.length} matching)</span>
          </h3>
          <Button size="sm" variant="outline" className="font-heading text-xs" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          {(["all","paid","trial","live","ended_today","ended_week"] as HistoryFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setHistoryFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-heading transition ${
                historyFilter === f ? "bg-primary/20 text-primary neon-border" : "bg-muted/20 text-muted-foreground hover:bg-muted/30"
              }`}
            >
              {f === "all" ? "All"
                : f === "paid" ? "Paid"
                : f === "trial" ? "Trial"
                : f === "live" ? "Live now"
                : f === "ended_today" ? "Ended today (UTC)"
                : "Ended this week"}
            </button>
          ))}
          <Input
            placeholder="Search email or key label…"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            className="h-8 text-xs max-w-xs"
          />
          <div className="flex gap-1 ml-auto">
            <Button size="sm" variant={historySort === "started_desc" ? "default" : "outline"} className="font-heading text-xs h-7"
              onClick={() => setHistorySort("started_desc")}>Latest</Button>
            <Button size="sm" variant={historySort === "started_asc" ? "default" : "outline"} className="font-heading text-xs h-7"
              onClick={() => setHistorySort("started_asc")}>Earliest</Button>
            <Button size="sm" variant={historySort === "most_connected" ? "default" : "outline"} className="font-heading text-xs h-7"
              onClick={() => setHistorySort("most_connected")}>Most connected</Button>
            <Button size="sm" variant={historySort === "duration_desc" ? "default" : "outline"} className="font-heading text-xs h-7"
              onClick={() => setHistorySort("duration_desc")}>Longest</Button>
          </div>
        </div>

        {pagedHistory.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No connection history matches these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground font-heading">
                <tr className="text-left border-b border-border">
                  <th className="py-2 px-2 cursor-pointer hover:text-foreground" onClick={() => toggleSort("user_asc","user_asc")}>User</th>
                  <th className="py-2 px-2 cursor-pointer hover:text-foreground" onClick={() => toggleSort("key_asc","key_asc")}>Key</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2 cursor-pointer hover:text-foreground" onClick={() => toggleSort("started_asc","started_desc")}>Started (UTC)</th>
                  <th className="py-2 px-2 cursor-pointer hover:text-foreground" onClick={() => toggleSort("ended_asc","ended_desc")}>Ended (UTC)</th>
                  <th className="py-2 px-2 cursor-pointer hover:text-foreground" onClick={() => toggleSort("duration_asc","duration_desc")}>Duration</th>
                  <th className="py-2 px-2 cursor-pointer hover:text-foreground" onClick={() => toggleSort("reason_asc","reason_asc")}>End reason</th>
                  <th className="py-2 px-2">Left at end</th>
                </tr>
              </thead>
              <tbody>
                {pagedHistory.map((r) => {
                  const liveDur = r.duration_ms ?? Math.max(0, serverNow() - new Date(r.started_at).getTime());
                  return (
                    <tr key={r.id} className="border-b border-border/40 hover:bg-muted/10">
                      <td className="py-2 px-2 text-foreground">{emails[r.user_id] ?? r.user_id.slice(0, 8)}</td>
                      <td className="py-2 px-2 font-heading">{r.key_label ?? "—"}</td>
                      <td className="py-2 px-2">
                        <span className={`px-2 py-0.5 rounded-full font-heading ${r.is_trial ? "bg-amber-500/15 text-amber-400" : "bg-primary/15 text-primary"}`}>
                          {r.is_trial ? "Trial" : "Paid"}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-mono text-muted-foreground">{fmtUTC(r.started_at)}</td>
                      <td className="py-2 px-2 font-mono text-muted-foreground">{fmtUTC(r.ended_at)}</td>
                      <td className="py-2 px-2 font-mono text-foreground">{fmtDuration(liveDur)}</td>
                      <td className="py-2 px-2">{reasonBadge(r)}</td>
                      <td className="py-2 px-2 font-mono text-muted-foreground">
                        {r.remaining_ms_at_end != null ? fmtDuration(r.remaining_ms_at_end) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {historyView.length > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-muted-foreground font-heading">
              Page {historyPage + 1} of {Math.ceil(historyView.length / PAGE_SIZE)}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="font-heading text-xs" disabled={historyPage === 0}
                onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}>Previous</Button>
              <Button size="sm" variant="outline" className="font-heading text-xs"
                disabled={(historyPage + 1) * PAGE_SIZE >= historyView.length}
                onClick={() => setHistoryPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
