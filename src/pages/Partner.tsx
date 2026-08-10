import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useAdmin } from "@/hooks/useAdmin";
import { usePartner } from "@/hooks/usePartner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import JoinPartnerScreen from "@/components/partner/JoinPartnerScreen";

interface Referral {
  user_id: string;
  email_masked: string | null;
  display_name: string | null;
  attributed_at: string;
  source: string;
  confirmed_payments: number;
  total_commission_usd: number;
  last_payment_status: string | null;
  last_payment_at: string | null;
}

interface Payout {
  id: string;
  amount_usd: number;
  note: string | null;
  paid_at: string;
}

interface Breakdown {
  payment_id: string;
  user_id: string;
  email_masked: string | null;
  plan_name: string | null;
  plan_price_usd: number | null;
  amount_paid_usd: number | null;
  commission_usd: number;
  status: string;
  created_at: string;
}

interface OverrideStats {
  downline_count: number;
  override_earnings_usd: number;
  override_paid_out_usd: number;
  override_balance_usd: number;
}

interface OverrideBreakdown {
  id: string;
  payment_id: string;
  source_label: string;
  depth: number;
  commission_base_usd: number;
  override_pct: number;
  amount_usd: number;
  status: string;
  created_at: string;
}

interface OverridePayout {
  id: string;
  amount_usd: number;
  note: string | null;
  paid_at: string;
}

const fmtUsd = (n: number | null | undefined) =>
  `$${(Number(n ?? 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Partner() {
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdmin();
  const { partner, stats, loading, refresh } = usePartner();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [breakdown, setBreakdown] = useState<Breakdown[]>([]);
  const [overrideStats, setOverrideStats] = useState<OverrideStats | null>(null);
  const [overrideBreakdown, setOverrideBreakdown] = useState<OverrideBreakdown[]>([]);
  const [overridePayouts, setOverridePayouts] = useState<OverridePayout[]>([]);
  const [downlinePartnerCount, setDownlinePartnerCount] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  const loadDetails = useCallback(async () => {
    if (!partner) return;
    const [r, p, b, os, ob, op, dt] = await Promise.all([
      supabase.rpc("partner_referrals" as any, { p_partner_id: partner.id }),
      supabase
        .from("partner_payouts" as any)
        .select("id, amount_usd, note, paid_at")
        .eq("partner_id", partner.id)
        .order("paid_at", { ascending: false }),
      supabase.rpc("partner_commission_breakdown" as any, { p_partner_id: partner.id }),
      supabase.rpc("partner_override_stats" as any, { p_partner_id: partner.id }),
      supabase.rpc("partner_override_breakdown" as any, { p_partner_id: partner.id }),
      supabase
        .from("partner_override_payouts" as any)
        .select("id, amount_usd, note, paid_at")
        .eq("partner_id", partner.id)
        .order("paid_at", { ascending: false }),
      supabase.rpc("partner_downline_tree" as any, { p_partner_id: partner.id }),
    ]);
    if (Array.isArray(r.data)) setReferrals(r.data as any);
    if (Array.isArray(p.data)) setPayouts(p.data as any);
    if (Array.isArray(b.data)) setBreakdown(b.data as any);
    if (Array.isArray(os.data) && os.data.length > 0) setOverrideStats(os.data[0] as any);
    if (Array.isArray(ob.data)) setOverrideBreakdown(ob.data as any);
    if (Array.isArray(op.data)) setOverridePayouts(op.data as any);
    if (Array.isArray(dt.data)) setDownlinePartnerCount(dt.data.length);
  }, [partner]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-primary animate-pulse font-heading text-xl">Loading...</div>
      </div>
    );
  }

  if (!partner && !isAdmin) {
    return <JoinPartnerScreen onJoined={refresh} />;
  }


  if (!partner) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass neon-border rounded-2xl p-8 text-center space-y-4 max-w-sm">
          <h1 className="text-xl font-heading font-bold text-foreground">No partner profile</h1>
          <p className="text-sm text-muted-foreground">You're an admin but you don't have a partner record yet.</p>
          <Button onClick={() => navigate("/admin")} className="font-heading">Open Admin → Partners</Button>
        </div>
      </div>
    );
  }

  const shareUrl = `${window.location.origin}/?ref=${partner.code}`;

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast({ title: "Link copied! 🔗" });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  };

  const statCards = [
    { label: "Referred users", value: stats?.referred_users ?? 0, icon: "👥" },
    { label: "Confirmed sales", value: stats?.confirmed_payments ?? 0, icon: "✅" },
    { label: "Gross earnings", value: fmtUsd(stats?.gross_earnings_usd), icon: "💰" },
    { label: "Paid out", value: fmtUsd(stats?.paid_out_usd), icon: "🏦" },
    { label: "Balance owed", value: fmtUsd(stats?.balance_owed_usd), icon: "🧾" },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border glass px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-heading font-bold gradient-text">Elite Swap</h1>
          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading font-semibold">
            PARTNER
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground font-heading hidden sm:inline">{user?.email}</span>
          <Button variant="outline" size="sm" onClick={() => refresh().then(loadDetails)} className="font-heading text-xs">
            Refresh
          </Button>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => navigate("/admin")} className="font-heading text-xs">
              Admin
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={async () => { await signOut(); navigate("/"); }} className="font-heading text-xs">
            Sign Out
          </Button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6 space-y-6 max-w-6xl w-full mx-auto">
        <div className="space-y-2">
          <h2 className="text-2xl font-heading font-bold text-foreground">
            Welcome, {partner.display_name || partner.code}
          </h2>
          <p className="text-sm text-muted-foreground font-body">
            You earn <span className="text-primary font-semibold">{partner.commission_pct}%</span> of every confirmed plan purchase from users who sign up through your link or code.
          </p>
        </div>

        <div className="glass neon-border rounded-xl p-4 space-y-3">
          <div className="text-sm font-heading font-semibold text-foreground">Your referral link</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <code className="flex-1 bg-muted/30 rounded-lg px-3 py-2 text-xs font-mono text-foreground/80 break-all">
              {shareUrl}
            </code>
            <Button onClick={copyShare} className="font-heading bg-primary text-primary-foreground hover:bg-primary/90">
              {copied ? "Copied ✓" : "Copy link"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Or share your code: <span className="font-mono font-semibold text-primary">{partner.code}</span> — users can enter it at signup or in their dashboard.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {statCards.map((s) => (
            <div key={s.label} className="glass neon-border rounded-xl p-4 text-center space-y-1">
              <div className="text-xl">{s.icon}</div>
              <div className="text-xl md:text-2xl font-heading font-bold text-foreground">{s.value}</div>
              <div className="text-[11px] text-muted-foreground font-heading">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="glass neon-border rounded-xl p-4 space-y-3">
          <h3 className="font-heading font-semibold text-foreground">Your referrals</h3>
          {referrals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No referrals yet — share your link to get started.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Joined via</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="text-center">Confirmed</TableHead>
                    <TableHead>Last status</TableHead>
                    <TableHead className="text-right">Earned</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {referrals.map((r) => (
                    <TableRow key={r.user_id}>
                      <TableCell className="font-mono text-xs">{r.email_masked || "—"}</TableCell>
                      <TableCell className="text-xs">{r.source}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.attributed_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-center text-xs">{r.confirmed_payments}</TableCell>
                      <TableCell className="text-xs">
                        {r.last_payment_status ? (
                          <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                            r.last_payment_status === "confirmed" ? "bg-primary/20 text-primary" :
                            r.last_payment_status === "rejected" ? "bg-destructive/20 text-destructive" :
                            "bg-amber-500/20 text-amber-400"
                          }`}>{r.last_payment_status}</span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-heading font-semibold">{fmtUsd(r.total_commission_usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="glass neon-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-heading font-semibold text-foreground">Commission breakdown</h3>
            <span className="text-[11px] text-muted-foreground font-heading">
              Per-payment detail · {partner.commission_pct}% of plan price on confirmed payments
            </span>
          </div>
          {breakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments from your referrals yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Plan price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Commission</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((b) => (
                    <TableRow key={b.payment_id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(b.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b.email_masked || "—"}</TableCell>
                      <TableCell className="text-xs">{b.plan_name || "—"}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(b.plan_price_usd)}</TableCell>
                      <TableCell className="text-xs">
                        <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                          b.status === "confirmed" ? "bg-primary/20 text-primary" :
                          b.status === "rejected" ? "bg-destructive/20 text-destructive" :
                          "bg-amber-500/20 text-amber-400"
                        }`}>{b.status}</span>
                      </TableCell>
                      <TableCell className={`text-right font-heading font-semibold ${
                        b.status === "confirmed" ? "text-primary" : "text-muted-foreground"
                      }`}>
                        {b.status === "confirmed" ? fmtUsd(b.commission_usd) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="glass neon-border rounded-xl p-4 space-y-3">
          <h3 className="font-heading font-semibold text-foreground">Payout history</h3>
          {payouts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payouts recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs text-muted-foreground">{new Date(p.paid_at).toLocaleString()}</TableCell>
                      <TableCell className="text-right font-heading font-semibold">{fmtUsd(p.amount_usd)}</TableCell>
                      <TableCell className="text-xs">{p.note || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {((overrideStats?.downline_count ?? 0) > 0 || overrideBreakdown.length > 0 || overridePayouts.length > 0 || downlinePartnerCount > 0) && (
          <>
            <div className="space-y-2 pt-2">
              <h2 className="text-xl font-heading font-bold text-foreground">Downline bonuses</h2>
              <p className="text-sm text-muted-foreground font-body">
                Extra earnings you receive on confirmed sales from partners in your downline. Paid in addition to your direct commissions.
              </p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: "Downline partners", value: downlinePartnerCount, icon: "👥" },
                { label: "Downline payments", value: overrideStats?.downline_count ?? 0, icon: "🌐" },
                { label: "Total earned", value: fmtUsd(overrideStats?.override_earnings_usd), icon: "💎" },
                { label: "Paid out", value: fmtUsd(overrideStats?.override_paid_out_usd), icon: "🏦" },
                { label: "Balance owed", value: fmtUsd(overrideStats?.override_balance_usd), icon: "🧾" },
              ].map((s) => (
                <div key={s.label} className="glass neon-border rounded-xl p-4 text-center space-y-1">
                  <div className="text-xl">{s.icon}</div>
                  <div className="text-xl md:text-2xl font-heading font-bold text-foreground">{s.value}</div>
                  <div className="text-[11px] text-muted-foreground font-heading">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="glass neon-border rounded-xl p-4 space-y-3">
              <h3 className="font-heading font-semibold text-foreground">Downline bonus breakdown</h3>
              {overrideBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground">No downline bonuses yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead className="text-right">Base</TableHead>
                        <TableHead className="text-right">%</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Bonus</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {overrideBreakdown.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(b.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-xs font-mono">{b.source_label}</TableCell>
                          <TableCell className="text-right text-xs">{fmtUsd(b.commission_base_usd)}</TableCell>
                          <TableCell className="text-right text-xs">{Number(b.override_pct)}%</TableCell>
                          <TableCell className="text-xs">
                            <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                              b.status === "accrued" ? "bg-primary/20 text-primary" :
                              b.status === "void" ? "bg-destructive/20 text-destructive" :
                              "bg-amber-500/20 text-amber-400"
                            }`}>{b.status}</span>
                          </TableCell>
                          <TableCell className={`text-right font-heading font-semibold ${
                            b.status === "accrued" ? "text-primary" : "text-muted-foreground"
                          }`}>
                            {b.status === "accrued" ? fmtUsd(b.amount_usd) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="glass neon-border rounded-xl p-4 space-y-3">
              <h3 className="font-heading font-semibold text-foreground">Downline payout history</h3>
              {overridePayouts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No downline payouts recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {overridePayouts.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="text-xs text-muted-foreground">{new Date(p.paid_at).toLocaleString()}</TableCell>
                          <TableCell className="text-right font-heading font-semibold">{fmtUsd(p.amount_usd)}</TableCell>
                          <TableCell className="text-xs">{p.note || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
