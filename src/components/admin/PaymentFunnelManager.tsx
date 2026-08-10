import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FUNNEL_STAGE_LABELS } from "@/lib/paymentFunnel";
import PaymentNudgeDialog, { type NudgeTarget } from "./PaymentNudgeDialog";

interface FunnelProfile {
  user_id: string;
  email: string | null;
  display_name: string | null;
  payment_funnel_stage: number;
  payment_funnel_updated_at: string | null;
  last_payment_nudge_sent_at: string | null;
  created_at: string;
}

interface ConfirmedPayment {
  user_id: string;
}

const STAGE_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

export default function PaymentFunnelManager() {
  const [profiles, setProfiles] = useState<FunnelProfile[]>([]);
  const [confirmedUserIds, setConfirmedUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [stageFilter, setStageFilter] = useState<number | "all" | "abandoned">("abandoned");
  const [search, setSearch] = useState("");
  const [nudgeTarget, setNudgeTarget] = useState<NudgeTarget | null>(null);
  const [nudgeOpen, setNudgeOpen] = useState(false);

  const [nudgeCountByUser, setNudgeCountByUser] = useState<Record<string, number>>({});

  const fetchData = async () => {
    setLoading(true);
    const [pRes, payRes, nudgeRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("user_id, email, display_name, payment_funnel_stage, payment_funnel_updated_at, last_payment_nudge_sent_at, created_at")
        .order("payment_funnel_updated_at", { ascending: false, nullsFirst: false }),
      supabase.from("payments").select("user_id").eq("status", "confirmed"),
      supabase.from("payment_nudge_history").select("user_id"),
    ]);
    if (pRes.data) setProfiles(pRes.data as FunnelProfile[]);
    if (payRes.data) setConfirmedUserIds(new Set((payRes.data as ConfirmedPayment[]).map((p) => p.user_id)));
    if (nudgeRes.data) {
      const counts: Record<string, number> = {};
      for (const row of nudgeRes.data as { user_id: string }[]) {
        counts[row.user_id] = (counts[row.user_id] || 0) + 1;
      }
      setNudgeCountByUser(counts);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Stage counts (only count users who entered the funnel at least once)
  const stageCounts = useMemo(() => {
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
    for (const p of profiles) {
      counts[p.payment_funnel_stage] = (counts[p.payment_funnel_stage] || 0) + 1;
    }
    return counts;
  }, [profiles]);

  const totalEntered = profiles.filter((p) => p.payment_funnel_stage >= 1).length;
  const abandonedCount = profiles.filter(
    (p) => p.payment_funnel_stage >= 1 && p.payment_funnel_stage < 8 && !confirmedUserIds.has(p.user_id)
  ).length;

  const filtered = useMemo(() => {
    let list = profiles;
    if (stageFilter === "abandoned") {
      list = list.filter(
        (p) => p.payment_funnel_stage >= 1 && p.payment_funnel_stage < 8 && !confirmedUserIds.has(p.user_id)
      );
    } else if (stageFilter !== "all") {
      list = list.filter((p) => p.payment_funnel_stage === stageFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          (p.email || "").toLowerCase().includes(q) ||
          (p.display_name || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [profiles, stageFilter, search, confirmedUserIds]);

  const openNudge = (p: FunnelProfile) => {
    if (!p.email) return;
    setNudgeTarget({
      user_id: p.user_id,
      email: p.email,
      display_name: p.display_name,
      payment_funnel_stage: p.payment_funnel_stage,
      last_payment_nudge_sent_at: p.last_payment_nudge_sent_at,
    });
    setNudgeOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-heading font-bold text-foreground">Payment Funnel</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Track where users drop off and nudge them with a tailored email.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading} className="font-heading text-xs">
          {loading ? "Loading..." : "Refresh"}
        </Button>
      </div>

      {/* Funnel chart */}
      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <h3 className="font-heading font-semibold text-foreground text-sm">Drop-off by stage</h3>
        <div className="space-y-2">
          {STAGE_ORDER.filter((s) => s >= 1).map((stage) => {
            const count = stageCounts[stage] || 0;
            const pct = totalEntered > 0 ? (count / totalEntered) * 100 : 0;
            const isFinal = stage === 8;
            return (
              <button
                key={stage}
                onClick={() => setStageFilter(stage)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-all ${
                  stageFilter === stage ? "bg-primary/10 neon-border" : "bg-muted/20 hover:bg-muted/30"
                }`}
              >
                <span className="text-xs font-heading text-muted-foreground w-6">#{stage}</span>
                <span className="text-xs font-heading text-foreground flex-1 truncate">
                  {FUNNEL_STAGE_LABELS[stage]}
                </span>
                <div className="flex-[2] bg-muted/30 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isFinal ? "bg-emerald-500" : "bg-primary"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-foreground/70 w-16 text-right">
                  {count} ({pct.toFixed(0)}%)
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Cohort filters */}
      <div className="glass rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setStageFilter("abandoned")}
              className={`px-3 py-1.5 rounded-full text-xs font-heading font-semibold transition-all ${
                stageFilter === "abandoned"
                  ? "bg-destructive/20 text-destructive neon-border"
                  : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
              }`}
            >
              ⚠ Abandoned ({abandonedCount})
            </button>
            <button
              onClick={() => setStageFilter("all")}
              className={`px-3 py-1.5 rounded-full text-xs font-heading font-semibold transition-all ${
                stageFilter === "all"
                  ? "bg-primary/20 text-primary neon-border"
                  : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
              }`}
            >
              All users ({profiles.length})
            </button>
          </div>
          <Input
            placeholder="Search email or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs text-xs"
          />
        </div>

        {/* User table */}
        <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {loading ? "Loading..." : "No users match this filter."}
            </p>
          ) : (
            filtered.map((p) => {
              const isConfirmed = confirmedUserIds.has(p.user_id);
              const updated = p.payment_funnel_updated_at
                ? new Date(p.payment_funnel_updated_at).toLocaleString()
                : "—";
              const lastNudge = p.last_payment_nudge_sent_at
                ? `last nudge ${new Date(p.last_payment_nudge_sent_at).toLocaleDateString()}`
                : null;
              const nudgeCount = nudgeCountByUser[p.user_id] || 0;
              return (
                <div
                  key={p.user_id}
                  className="bg-muted/20 rounded-lg px-3 py-2 flex items-center gap-3 text-xs flex-wrap"
                >
                  <div className="flex-1 min-w-[200px]">
                    <div className="text-foreground font-heading font-semibold truncate">
                      {p.email || p.user_id.slice(0, 8)}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {p.display_name || "—"} · last activity {updated}
                      {nudgeCount > 0 && (
                        <span className="text-amber-400"> · {nudgeCount} nudge{nudgeCount === 1 ? "" : "s"}{lastNudge ? `, ${lastNudge}` : ""}</span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`font-heading font-semibold px-2 py-0.5 rounded-full text-[10px] ${
                      isConfirmed
                        ? "bg-emerald-500/20 text-emerald-400"
                        : p.payment_funnel_stage === 0
                        ? "bg-muted/40 text-muted-foreground"
                        : p.payment_funnel_stage >= 6
                        ? "bg-amber-500/20 text-amber-400"
                        : "bg-primary/20 text-primary"
                    }`}
                  >
                    #{p.payment_funnel_stage} {FUNNEL_STAGE_LABELS[p.payment_funnel_stage]}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!p.email || isConfirmed}
                    onClick={() => openNudge(p)}
                    className="font-heading text-xs h-7"
                  >
                    {isConfirmed ? "✓ Paid" : "Nudge"}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <PaymentNudgeDialog
        target={nudgeTarget}
        open={nudgeOpen}
        onOpenChange={setNudgeOpen}
        onSent={fetchData}
      />
    </div>
  );
}
