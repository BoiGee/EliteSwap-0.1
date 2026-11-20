import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Elite AI background usage (admins only; the RPC refuses everyone else). Each row in
// studio_background_segments is a stretch the background was on during a studio session. The
// background is a second Vidu stream, so every second on costs one extra Vidu credit.

interface UserUsage { user_id: string; email: string | null; seconds: number; sessions: number; last_used: string }
interface Segment { id: string; session_id: string; email: string | null; started_at: string; ended_at: string | null; seconds: number; end_reason: string | null; resolution: string | null }
interface Usage {
  since: string;
  total_seconds: number;
  segments: number;
  sessions: number;
  users: number;
  live_now: number;
  studio_seconds: number;
  by_user: UserUsage[];
  recent: Segment[];
}

// Vidu list price: 1 credit per second, ¥0.03125 per credit; about $0.0047 at ~¥6.7 per dollar.
const USD_PER_CREDIT = 0.03125 / 6.7;

const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
const REASONS: Record<string, string> = {
  turned_off: "Switched off",
  session_ended: "Session ended",
  disconnected: "Disconnected",
  page_closed: "Page closed",
  start_failed: "Didn't start",
  cancelled: "Cancelled",
};
const reasonLabel = (r: string | null) => (r ? REASONS[r] ?? (r.startsWith("failed:") ? "Stopped by error" : r) : "On now");

export function BackgroundUsageCard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: res, error: err } = await supabase.rpc("admin_studio_background_usage" as never, { p_days: days } as never);
    if (err) { setError(err.message); setData(null); } else { setError(null); setData(res as unknown as Usage); }
    setLoading(false);
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const share = data && data.studio_seconds > 0 ? Math.round((data.total_seconds / data.studio_seconds) * 100) : 0;

  return (
    <div className="glass neon-border rounded-xl p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-heading font-semibold text-foreground text-sm">Elite AI background usage</div>
          <p className="text-xs text-muted-foreground">Each background minute runs a second video stream: one extra provider credit per second. Admins only.</p>
        </div>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <Button key={d} size="sm" variant={days === d ? "default" : "outline"} className="h-7 text-xs" onClick={() => setDays(d)}>{d} days</Button>
          ))}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()} disabled={loading}>{loading ? "…" : "Refresh"}</Button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Background time" value={mins(data.total_seconds)} />
            <Stat label="Share of studio time" value={`${share}%`} />
            <Stat label="Extra provider cost" value={`≈ $${(data.total_seconds * USD_PER_CREDIT).toFixed(2)}`} hint={`${Math.round(data.total_seconds).toLocaleString()} credits`} />
            <Stat label="Users / sessions" value={`${data.users} / ${data.sessions}`} />
            <Stat label="On right now" value={String(data.live_now)} />
          </div>

          {data.by_user.length === 0 ? (
            <p className="text-xs text-muted-foreground">No background use recorded in this period. Recording started on 23 Nov 2026.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow><TableHead>User</TableHead><TableHead className="text-right">Background time</TableHead><TableHead className="text-right">Sessions</TableHead><TableHead className="text-right">Last used</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {data.by_user.map((u) => (
                    <TableRow key={u.user_id}>
                      <TableCell className="text-xs">{u.email ?? u.user_id}</TableCell>
                      <TableCell className="text-xs text-right">{mins(u.seconds)}</TableCell>
                      <TableCell className="text-xs text-right">{u.sessions}</TableCell>
                      <TableCell className="text-xs text-right">{new Date(u.last_used).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Recent background stretches ({data.recent.length})</summary>
                <div className="mt-2 space-y-1">
                  {data.recent.map((s) => (
                    <div key={s.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
                      <span>{s.email ?? "?"}</span>
                      <span className="text-muted-foreground">{new Date(s.started_at).toLocaleString()} · {mins(s.seconds)}{s.resolution ? ` · ${s.resolution}` : ""}</span>
                      <span className={s.ended_at ? "text-muted-foreground" : "text-primary"}>{reasonLabel(s.end_reason)}</span>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass rounded-xl p-3 text-center">
      <div className="text-lg font-heading font-bold text-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}
