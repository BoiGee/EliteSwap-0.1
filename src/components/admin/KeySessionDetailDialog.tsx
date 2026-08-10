import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type SessionRow = {
  id: string;
  session_id: string;
  started_at: string;
  first_heartbeat_at: string | null;
  last_heartbeat_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  is_trial: boolean;
  billed_ms: number;
  wall_ms: number;
  remaining_ms_at_start: number | null;
  remaining_ms_at_end: number | null;
  min_bill_ms: number | null;
  reconciled_ms: number;
  is_open: boolean;
};

type MintRow = {
  id: string;
  minted_at: string;
  expires_at: string | null;
  ok: boolean;
  reason: string | null;
  linked_session_id: string | null;
  settled_at: string | null;
  penalty_ms: number;
  penalty_reason: string | null;
  admin_debited_ms: number;
};

type Detail = {
  key: Record<string, unknown>;
  sessions: SessionRow[];
  mints: MintRow[];
};

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");
const fmtMs = (ms?: number | null) => {
  if (!ms || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
};

export default function KeySessionDetailDialog({ keyId, onClose }: { keyId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!keyId) { setDetail(null); return; }
    setLoading(true);
    supabase.rpc("admin_key_session_detail" as any, { p_key_id: keyId }).then(({ data, error }) => {
      setLoading(false);
      if (!error && data) setDetail(data as unknown as Detail);
    });
  }, [keyId]);

  return (
    <Dialog open={!!keyId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-heading">Session &amp; mint audit trail</DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!loading && detail && (
          <div className="space-y-6">
            <div>
              <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider mb-2">
                Sessions ({detail.sessions.length})
              </h4>
              <div className="space-y-1.5">
                {detail.sessions.map((s) => (
                  <div key={s.id} className="bg-muted/20 rounded-lg px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-muted-foreground">{fmt(s.started_at)} → {s.is_open ? "still open" : fmt(s.ended_at)}</span>
                      <span className={`font-heading px-2 py-0.5 rounded-full ${
                        s.is_open ? "bg-blue-500/20 text-blue-400" : "bg-muted text-muted-foreground"
                      }`}>{s.is_open ? "open" : (s.end_reason ?? "—")}</span>
                    </div>
                    <div className="flex items-center gap-4 flex-wrap text-muted-foreground">
                      <span>Billed: <span className="text-foreground font-heading">{fmtMs(s.billed_ms)}</span></span>
                      <span>Wall clock: {fmtMs(s.wall_ms)}</span>
                      {!s.first_heartbeat_at && <span className="text-amber-400">no heartbeat ever received</span>}
                      {s.reconciled_ms > 0 && (
                        <span className="text-amber-400">+{fmtMs(s.reconciled_ms)} floor top-up applied</span>
                      )}
                    </div>
                  </div>
                ))}
                {detail.sessions.length === 0 && <p className="text-xs text-muted-foreground">No sessions.</p>}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-heading text-muted-foreground uppercase tracking-wider mb-2">
                Mint attempts ({detail.mints.length})
              </h4>
              <div className="space-y-1.5">
                {detail.mints.map((m) => (
                  <div key={m.id} className="bg-muted/20 rounded-lg px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-muted-foreground">{fmt(m.minted_at)}</span>
                      <span className={`font-heading px-2 py-0.5 rounded-full ${
                        m.ok ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"
                      }`}>{m.ok ? "ok" : (m.reason ?? "failed")}</span>
                    </div>
                    {m.penalty_ms > 0 && (
                      <div className="text-amber-400">
                        Handshake burn: {fmtMs(m.penalty_ms)} debited ({m.penalty_reason ?? "no reason logged"}) — credential was issued but never connected
                      </div>
                    )}
                  </div>
                ))}
                {detail.mints.length === 0 && <p className="text-xs text-muted-foreground">No mint attempts recorded.</p>}
              </div>
            </div>
          </div>
        )}

        {!loading && !detail && <p className="text-sm text-muted-foreground">No data.</p>}
      </DialogContent>
    </Dialog>
  );
}
