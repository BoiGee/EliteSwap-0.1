import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

interface PartnerRow {
  id: string;
  user_id: string;
  code: string;
  display_name: string | null;
  commission_pct: number;
  is_active: boolean;
  created_at: string;
  parent_partner_id: string | null;
  override_pct: number;
}

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

interface Props {
  profiles: Profile[];
  onRefresh: () => void;
}

interface OverrideStats {
  downline_count: number;
  override_earnings_usd: number;
  override_paid_out_usd: number;
  override_balance_usd: number;
}

interface PartnerWithStats extends PartnerRow {
  stats?: {
    referred_users: number;
    confirmed_payments: number;
    gross_earnings_usd: number;
    paid_out_usd: number;
    balance_owed_usd: number;
  };
  override?: OverrideStats;
}

const fmtUsd = (n: number | null | undefined) =>
  `$${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface PayoutRow {
  id: string;
  partner_id: string;
  amount_usd: number;
  note: string | null;
  paid_at: string;
}

export default function PartnerManager({ profiles }: Props) {
  const { toast } = useToast();
  const [partners, setPartners] = useState<PartnerWithStats[]>([]);
  const [payoutsByPartner, setPayoutsByPartner] = useState<Record<string, PayoutRow[]>>({});
  const [overridePayoutsByPartner, setOverridePayoutsByPartner] = useState<Record<string, PayoutRow[]>>({});
  const [expandedPayouts, setExpandedPayouts] = useState<Record<string, boolean>>({});
  const [expandedOverridePayouts, setExpandedOverridePayouts] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  // create partner form
  const [searchEmail, setSearchEmail] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pct, setPct] = useState<string>("30");
  const [creating, setCreating] = useState(false);

  // payout form per partner
  const [payoutAmount, setPayoutAmount] = useState<Record<string, string>>({});
  const [payoutNote, setPayoutNote] = useState<Record<string, string>>({});

  // edit commission % per partner
  const [pctDraft, setPctDraft] = useState<Record<string, string>>({});
  const [savingPct, setSavingPct] = useState<Record<string, boolean>>({});

  // edit override % + parent per partner
  const [overridePctDraft, setOverridePctDraft] = useState<Record<string, string>>({});
  const [savingOverride, setSavingOverride] = useState<Record<string, boolean>>({});
  const [parentDraft, setParentDraft] = useState<Record<string, string>>({});
  const [savingParent, setSavingParent] = useState<Record<string, boolean>>({});

  // override payout form per partner
  const [overrideAmount, setOverrideAmount] = useState<Record<string, string>>({});
  const [overrideNote, setOverrideNote] = useState<Record<string, string>>({});

  const saveCommissionPct = async (p: PartnerRow) => {
    const raw = pctDraft[p.id] ?? String(p.commission_pct);
    const next = Number(raw);
    if (!Number.isFinite(next) || next <= 0 || next > 100) {
      toast({ title: "Commission % must be between 0 and 100", variant: "destructive" });
      return;
    }
    if (next === Number(p.commission_pct)) {
      toast({ title: "No change" });
      return;
    }
    setSavingPct((s) => ({ ...s, [p.id]: true }));
    const { error } = await supabase
      .from("partners" as any)
      .update({ commission_pct: next } as any)
      .eq("id", p.id);
    setSavingPct((s) => ({ ...s, [p.id]: false }));
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: `Updated to ${next}% — applies to new payments only ✅` });
    setPctDraft((s) => { const n = { ...s }; delete n[p.id]; return n; });
    loadPartners();
  };

  const saveOverridePct = async (p: PartnerRow) => {
    const raw = overridePctDraft[p.id] ?? String(p.override_pct);
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      toast({ title: "Override % must be between 0 and 100", variant: "destructive" });
      return;
    }
    if (next === Number(p.override_pct)) { toast({ title: "No change" }); return; }
    setSavingOverride((s) => ({ ...s, [p.id]: true }));
    const { error } = await supabase
      .from("partners" as any)
      .update({ override_pct: next } as any)
      .eq("id", p.id);
    setSavingOverride((s) => ({ ...s, [p.id]: false }));
    if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); return; }
    toast({ title: `Override updated to ${next}% — applies to new payments only ✅` });
    setOverridePctDraft((s) => { const n = { ...s }; delete n[p.id]; return n; });
    loadPartners();
  };

  const saveParent = async (p: PartnerRow) => {
    const raw = parentDraft[p.id] ?? (p.parent_partner_id ?? "");
    const nextParent = raw === "" || raw === "__none__" ? null : raw;
    if (nextParent === p.parent_partner_id) { toast({ title: "No change" }); return; }
    setSavingParent((s) => ({ ...s, [p.id]: true }));
    const { error } = await supabase.rpc("admin_set_partner_parent" as any, {
      p_partner_id: p.id,
      p_parent_partner_id: nextParent,
    });
    setSavingParent((s) => ({ ...s, [p.id]: false }));
    if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); return; }
    toast({ title: "Parent updated ✅" });
    setParentDraft((s) => { const n = { ...s }; delete n[p.id]; return n; });
    loadPartners();
  };

  const recordOverridePayout = async (partnerId: string) => {
    const amt = Number(overrideAmount[partnerId]);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" }); return;
    }
    const { data: { user: caller } } = await supabase.auth.getUser();
    const { error } = await supabase.from("partner_override_payouts" as any).insert({
      partner_id: partnerId,
      amount_usd: amt,
      note: overrideNote[partnerId]?.trim() || null,
      created_by: caller?.id ?? null,
    } as any);
    if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); return; }
    setOverrideAmount((s) => ({ ...s, [partnerId]: "" }));
    setOverrideNote((s) => ({ ...s, [partnerId]: "" }));
    toast({ title: "Override payout recorded ✅" });
    loadPartners();
  };

  // referrals view per partner
  const [expandedPartnerId, setExpandedPartnerId] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<Record<string, Referral[]>>({});
  const [referralsLoading, setReferralsLoading] = useState<Record<string, boolean>>({});
  const [referralSearch, setReferralSearch] = useState<Record<string, string>>({});
  const [referralStatus, setReferralStatus] = useState<Record<string, string>>({});
  const [referralPaying, setReferralPaying] = useState<Record<string, string>>({});

  const loadReferrals = useCallback(async (partnerId: string) => {
    setReferralsLoading((s) => ({ ...s, [partnerId]: true }));
    const { data, error } = await supabase.rpc("partner_referrals" as any, { p_partner_id: partnerId });
    if (error) {
      toast({ title: "Error loading referrals", description: error.message, variant: "destructive" });
    } else {
      setReferrals((s) => ({ ...s, [partnerId]: (data ?? []) as Referral[] }));
    }
    setReferralsLoading((s) => ({ ...s, [partnerId]: false }));
  }, [toast]);

  const toggleReferrals = (partnerId: string) => {
    if (expandedPartnerId === partnerId) {
      setExpandedPartnerId(null);
    } else {
      setExpandedPartnerId(partnerId);
      if (!referrals[partnerId]) loadReferrals(partnerId);
    }
  };

  const loadPartners = useCallback(async () => {
    setLoading(true);
    const { data: rows } = await supabase
      .from("partners" as any)
      .select("*")
      .order("created_at", { ascending: false });
    const list = (rows ?? []) as unknown as PartnerRow[];
    const [withStats, payRes, opRes] = await Promise.all([
      Promise.all(
        list.map(async (p) => {
          const [{ data: s }, { data: o }] = await Promise.all([
            supabase.rpc("partner_stats" as any, { p_partner_id: p.id }),
            supabase.rpc("partner_override_stats" as any, { p_partner_id: p.id }),
          ]);
          return {
            ...p,
            stats: Array.isArray(s) && s.length > 0 ? (s[0] as any) : undefined,
            override: Array.isArray(o) && o.length > 0 ? (o[0] as any) : undefined,
          } as PartnerWithStats;
        })
      ),
      supabase
        .from("partner_payouts" as any)
        .select("id, partner_id, amount_usd, note, paid_at")
        .order("paid_at", { ascending: false }),
      supabase
        .from("partner_override_payouts" as any)
        .select("id, partner_id, amount_usd, note, paid_at")
        .order("paid_at", { ascending: false }),
    ]);
    setPartners(withStats);
    const groupBy = (arr: any[]): Record<string, PayoutRow[]> => {
      const out: Record<string, PayoutRow[]> = {};
      for (const r of arr ?? []) {
        (out[r.partner_id] ||= []).push(r as PayoutRow);
      }
      return out;
    };
    setPayoutsByPartner(groupBy((payRes.data as any[]) ?? []));
    setOverridePayoutsByPartner(groupBy((opRes.data as any[]) ?? []));
    setLoading(false);
  }, []);

  useEffect(() => {
    loadPartners();
  }, [loadPartners]);

  const matchedProfiles = profiles.filter((p) =>
    searchEmail.length >= 2 && (p.email ?? "").toLowerCase().includes(searchEmail.toLowerCase())
  ).slice(0, 8);

  const createPartner = async () => {
    if (!selectedUserId || !code.trim()) {
      toast({ title: "Pick a user and a code", variant: "destructive" });
      return;
    }
    setCreating(true);
    const pctNum = Number(pct);
    if (!Number.isFinite(pctNum) || pctNum <= 0 || pctNum > 100) {
      toast({ title: "Commission % must be between 0 and 100", variant: "destructive" });
      setCreating(false);
      return;
    }
    const { error } = await supabase.rpc("admin_create_partner" as any, {
      p_user_id: selectedUserId,
      p_code: code.trim(),
      p_display_name: displayName.trim() || null,
      p_commission_pct: pctNum,
    });
    setCreating(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Partner created 🎉" });
    setSearchEmail("");
    setSelectedUserId("");
    setCode("");
    setDisplayName("");
    setPct("30");
    loadPartners();
  };

  const togglePartner = async (p: PartnerRow) => {
    const { error } = await supabase.from("partners" as any).update({ is_active: !p.is_active } as any).eq("id", p.id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    loadPartners();
  };

  const recordPayout = async (partnerId: string) => {
    const raw = payoutAmount[partnerId];
    const amt = Number(raw);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    const { data: { user: caller } } = await supabase.auth.getUser();
    const { error } = await supabase.from("partner_payouts" as any).insert({
      partner_id: partnerId,
      amount_usd: amt,
      note: payoutNote[partnerId]?.trim() || null,
      created_by: caller?.id ?? null,
    } as any);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    setPayoutAmount((s) => ({ ...s, [partnerId]: "" }));
    setPayoutNote((s) => ({ ...s, [partnerId]: "" }));
    toast({ title: "Payout recorded ✅" });
    loadPartners();
  };

  const emailFor = (uid: string) => profiles.find((p) => p.user_id === uid)?.email ?? uid.slice(0, 8);

  // Compute downline tree client-side from partners list (admin already has all rows).
  const downlineMap = useMemo(() => {
    const byParent = new Map<string, PartnerWithStats[]>();
    for (const p of partners) {
      if (!p.parent_partner_id) continue;
      const arr = byParent.get(p.parent_partner_id) ?? [];
      arr.push(p);
      byParent.set(p.parent_partner_id, arr);
    }
    const collectDescendants = (rootId: string): { partner: PartnerWithStats; depth: number }[] => {
      const out: { partner: PartnerWithStats; depth: number }[] = [];
      const walk = (id: string, depth: number) => {
        if (depth > 20) return;
        for (const child of byParent.get(id) ?? []) {
          out.push({ partner: child, depth });
          walk(child.id, depth + 1);
        }
      };
      walk(rootId, 1);
      return out;
    };
    const map = new Map<string, { partner: PartnerWithStats; depth: number }[]>();
    for (const p of partners) map.set(p.id, collectDescendants(p.id));
    return map;
  }, [partners]);

  const [expandedTreeId, setExpandedTreeId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-heading font-bold text-foreground">Partners</h2>

      <Tabs defaultValue="partners" className="space-y-6">
        <TabsList>
          <TabsTrigger value="partners" className="font-heading">Partners</TabsTrigger>
          <TabsTrigger value="downline" className="font-heading">Downline tree</TabsTrigger>
        </TabsList>

        <TabsContent value="partners" className="space-y-6 mt-0">

      <div className="glass neon-border rounded-xl p-4 space-y-3">
        <h3 className="font-heading font-semibold text-foreground">Create partner</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">Find user by email</label>
            <Input
              value={searchEmail}
              onChange={(e) => { setSearchEmail(e.target.value); setSelectedUserId(""); }}
              placeholder="Type at least 2 chars…"
              className="bg-muted/30 border-border"
            />
            {searchEmail.length >= 2 && !selectedUserId && (
              <div className="bg-muted/30 rounded-lg max-h-40 overflow-auto">
                {matchedProfiles.map((p) => (
                  <button
                    key={p.user_id}
                    onClick={() => { setSelectedUserId(p.user_id); setSearchEmail(p.email ?? ""); }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition"
                  >
                    {p.email}
                  </button>
                ))}
                {matchedProfiles.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>
                )}
              </div>
            )}
            {selectedUserId && (
              <div className="text-xs text-primary font-heading">✓ Selected: {emailFor(selectedUserId)}</div>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">Referral code</label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ONION"
              maxLength={32}
              className="bg-muted/30 border-border uppercase"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">Display name (optional)</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="OnionRouter"
              className="bg-muted/30 border-border"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-heading text-muted-foreground">Commission %</label>
            <Input
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              type="number"
              min={1}
              max={100}
              className="bg-muted/30 border-border"
            />
          </div>
        </div>
        <Button
          onClick={createPartner}
          disabled={creating || !selectedUserId || !code.trim()}
          className="font-heading bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {creating ? "Creating…" : "Create partner"}
        </Button>
      </div>

      <div className="space-y-4">
        <h3 className="font-heading font-semibold text-foreground">All partners ({partners.length})</h3>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && partners.length === 0 && (
          <p className="text-sm text-muted-foreground">No partners yet.</p>
        )}
        {partners.map((p) => (
          <div key={p.id} className="glass rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-heading font-semibold text-foreground">
                  {p.display_name || p.code}{" "}
                  <span className="text-xs text-muted-foreground">({emailFor(p.user_id)})</span>
                </div>
                <div className="text-xs text-muted-foreground font-mono flex flex-wrap items-center gap-2">
                  <span>Code: <span className="text-primary">{p.code}</span></span>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={pctDraft[p.id] ?? String(p.commission_pct)}
                      onChange={(e) => setPctDraft((s) => ({ ...s, [p.id]: e.target.value }))}
                      className="bg-muted/30 border-border h-7 w-20 text-xs"
                    />
                    <span>%</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => saveCommissionPct(p)}
                      disabled={savingPct[p.id] || (pctDraft[p.id] ?? String(p.commission_pct)) === String(p.commission_pct)}
                      className="h-7 font-heading text-xs"
                      title="New % applies to future confirmed payments only. Past commissions are preserved."
                    >
                      {savingPct[p.id] ? "Saving…" : "Save %"}
                    </Button>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-heading font-semibold px-2 py-0.5 rounded-full ${
                  p.is_active ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"
                }`}>
                  {p.is_active ? "Active" : "Inactive"}
                </span>
                <Button size="sm" variant="outline" onClick={() => togglePartner(p)} className="font-heading text-xs">
                  {p.is_active ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
              <Stat label="Referrals" value={String(p.stats?.referred_users ?? 0)} />
              <Stat label="Confirmed" value={String(p.stats?.confirmed_payments ?? 0)} />
              <Stat label="Gross" value={fmtUsd(p.stats?.gross_earnings_usd)} />
              <Stat label="Paid" value={fmtUsd(p.stats?.paid_out_usd)} />
              <Stat label="Owed" value={fmtUsd(p.stats?.balance_owed_usd)} highlight />
            </div>

            <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border">
              <Input
                placeholder="Amount USD"
                type="number"
                value={payoutAmount[p.id] ?? ""}
                onChange={(e) => setPayoutAmount((s) => ({ ...s, [p.id]: e.target.value }))}
                className="bg-muted/30 border-border sm:w-32"
              />
              <Input
                placeholder="Note (optional)"
                value={payoutNote[p.id] ?? ""}
                onChange={(e) => setPayoutNote((s) => ({ ...s, [p.id]: e.target.value }))}
                className="bg-muted/30 border-border flex-1"
              />
              <Button onClick={() => recordPayout(p.id)} className="font-heading">Record payout</Button>
            </div>

            {(payoutsByPartner[p.id]?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExpandedPayouts((s) => ({ ...s, [p.id]: !s[p.id] }))}
                  className="font-heading text-xs"
                >
                  {expandedPayouts[p.id]
                    ? `Hide payout history (${payoutsByPartner[p.id].length})`
                    : `View payout history (${payoutsByPartner[p.id].length})`}
                </Button>
                {expandedPayouts[p.id] && (
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
                        {payoutsByPartner[p.id].map((po) => (
                          <TableRow key={po.id}>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {new Date(po.paid_at).toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right font-heading font-semibold">{fmtUsd(po.amount_usd)}</TableCell>
                            <TableCell className="text-xs">{po.note || "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}

            <div className="pt-3 border-t border-border space-y-3">
              <div className="text-xs font-heading font-semibold text-muted-foreground uppercase tracking-wide">
                Upline / override settings
              </div>
              <div className="flex flex-col sm:flex-row gap-2 flex-wrap items-stretch sm:items-center">
                <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                  <span className="text-xs text-muted-foreground font-heading whitespace-nowrap">Parent partner</span>
                  <Select
                    value={parentDraft[p.id] ?? (p.parent_partner_id ?? "__none__")}
                    onValueChange={(v) => setParentDraft((s) => ({ ...s, [p.id]: v }))}
                  >
                    <SelectTrigger className="bg-muted/30 border-border h-8 text-xs flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value="__none__">— None (top-level) —</SelectItem>
                      {partners.filter((pp) => pp.id !== p.id).map((pp) => (
                        <SelectItem key={pp.id} value={pp.id}>
                          {pp.code}{pp.display_name ? ` · ${pp.display_name}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => saveParent(p)}
                    disabled={savingParent[p.id] || (parentDraft[p.id] ?? (p.parent_partner_id ?? "__none__")) === (p.parent_partner_id ?? "__none__")}
                    className="h-8 font-heading text-xs">
                    {savingParent[p.id] ? "Saving…" : "Save"}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-heading whitespace-nowrap">Override % to ancestors</span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={overridePctDraft[p.id] ?? String(p.override_pct)}
                    onChange={(e) => setOverridePctDraft((s) => ({ ...s, [p.id]: e.target.value }))}
                    className="bg-muted/30 border-border h-8 w-20 text-xs"
                  />
                  <span className="text-xs">%</span>
                  <Button size="sm" variant="outline" onClick={() => saveOverridePct(p)}
                    disabled={savingOverride[p.id] || (overridePctDraft[p.id] ?? String(p.override_pct)) === String(p.override_pct)}
                    className="h-8 font-heading text-xs"
                    title="Paid by the house to each ancestor on this partner's confirmed sales. New % applies to future payments only.">
                    {savingOverride[p.id] ? "Saving…" : "Save %"}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
                <Stat label="Downline payments" value={String(p.override?.downline_count ?? 0)} />
                <Stat label="Override earned" value={fmtUsd(p.override?.override_earnings_usd)} />
                <Stat label="Override paid" value={fmtUsd(p.override?.override_paid_out_usd)} />
                <Stat label="Override owed" value={fmtUsd(p.override?.override_balance_usd)} highlight />
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  placeholder="Override payout USD"
                  type="number"
                  value={overrideAmount[p.id] ?? ""}
                  onChange={(e) => setOverrideAmount((s) => ({ ...s, [p.id]: e.target.value }))}
                  className="bg-muted/30 border-border sm:w-40"
                />
                <Input
                  placeholder="Note (optional)"
                  value={overrideNote[p.id] ?? ""}
                  onChange={(e) => setOverrideNote((s) => ({ ...s, [p.id]: e.target.value }))}
                  className="bg-muted/30 border-border flex-1"
                />
                <Button onClick={() => recordOverridePayout(p.id)} variant="outline" className="font-heading">
                  Record override payout
                </Button>
              </div>

              {(overridePayoutsByPartner[p.id]?.length ?? 0) > 0 && (
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setExpandedOverridePayouts((s) => ({ ...s, [p.id]: !s[p.id] }))}
                    className="font-heading text-xs"
                  >
                    {expandedOverridePayouts[p.id]
                      ? `Hide override payout history (${overridePayoutsByPartner[p.id].length})`
                      : `View override payout history (${overridePayoutsByPartner[p.id].length})`}
                  </Button>
                  {expandedOverridePayouts[p.id] && (
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
                          {overridePayoutsByPartner[p.id].map((po) => (
                            <TableRow key={po.id}>
                              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                {new Date(po.paid_at).toLocaleString()}
                              </TableCell>
                              <TableCell className="text-right font-heading font-semibold">{fmtUsd(po.amount_usd)}</TableCell>
                              <TableCell className="text-xs">{po.note || "—"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                onClick={() => toggleReferrals(p.id)}
                className="font-heading text-xs w-full sm:w-auto"
              >
                {expandedPartnerId === p.id ? "Hide referred users" : `View referred users (${p.stats?.referred_users ?? 0})`}
              </Button>

              {expandedPartnerId === p.id && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      placeholder="Search by email or name…"
                      value={referralSearch[p.id] ?? ""}
                      onChange={(e) => setReferralSearch((s) => ({ ...s, [p.id]: e.target.value }))}
                      className="bg-muted/30 border-border flex-1"
                    />
                    <Select
                      value={referralStatus[p.id] ?? "all"}
                      onValueChange={(v) => setReferralStatus((s) => ({ ...s, [p.id]: v }))}
                    >
                      <SelectTrigger className="bg-muted/30 border-border sm:w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All statuses</SelectItem>
                        <SelectItem value="confirmed">Has confirmed payment</SelectItem>
                        <SelectItem value="pending">Pending / pending review</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                        <SelectItem value="none">No payment yet</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={referralPaying[p.id] ?? "all"}
                      onValueChange={(v) => setReferralPaying((s) => ({ ...s, [p.id]: v }))}
                    >
                      <SelectTrigger className="bg-muted/30 border-border sm:w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Paying & non-paying</SelectItem>
                        <SelectItem value="paying">Paying only (≥1 confirmed)</SelectItem>
                        <SelectItem value="nonpaying">Non-paying only</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={() => loadReferrals(p.id)} className="font-heading text-xs">
                      Refresh
                    </Button>
                  </div>

                  {referralsLoading[p.id] ? (
                    <p className="text-xs text-muted-foreground">Loading referrals…</p>
                  ) : (
                    (() => {
                      const all = referrals[p.id] ?? [];
                      const q = (referralSearch[p.id] ?? "").trim().toLowerCase();
                      const stat = referralStatus[p.id] ?? "all";
                      const pay = referralPaying[p.id] ?? "all";
                      const filtered = all.filter((r) => {
                        if (q && !((r.email_masked ?? "").toLowerCase().includes(q) || (r.display_name ?? "").toLowerCase().includes(q))) return false;
                        if (stat === "confirmed" && r.last_payment_status !== "confirmed") return false;
                        if (stat === "pending" && !(r.last_payment_status === "pending" || r.last_payment_status === "pending_review")) return false;
                        if (stat === "rejected" && r.last_payment_status !== "rejected") return false;
                        if (stat === "none" && r.last_payment_status != null) return false;
                        if (pay === "paying" && (r.confirmed_payments ?? 0) < 1) return false;
                        if (pay === "nonpaying" && (r.confirmed_payments ?? 0) >= 1) return false;
                        return true;
                      });
                      if (all.length === 0) return <p className="text-xs text-muted-foreground">No referrals yet.</p>;
                      return (
                        <div className="rounded-lg overflow-hidden border border-border">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-border">
                                <TableHead className="font-heading text-xs">User</TableHead>
                                <TableHead className="font-heading text-xs">Source</TableHead>
                                <TableHead className="font-heading text-xs">Joined</TableHead>
                                <TableHead className="font-heading text-xs">Confirmed</TableHead>
                                <TableHead className="font-heading text-xs">Commission</TableHead>
                                <TableHead className="font-heading text-xs">Last payment</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filtered.map((r) => (
                                <TableRow key={r.user_id} className="border-border">
                                  <TableCell className="text-xs">
                                    <div className="font-heading">{r.email_masked || "—"}</div>
                                    {r.display_name && <div className="text-muted-foreground">{r.display_name}</div>}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">{r.source}</TableCell>
                                  <TableCell className="text-xs text-muted-foreground">{new Date(r.attributed_at).toLocaleDateString()}</TableCell>
                                  <TableCell className="text-xs font-mono">{r.confirmed_payments}</TableCell>
                                  <TableCell className="text-xs font-mono text-primary">{fmtUsd(r.total_commission_usd)}</TableCell>
                                  <TableCell className="text-xs">
                                    {r.last_payment_status ? (
                                      <span className="text-foreground">
                                        {r.last_payment_status.replace("_", " ")}
                                        {r.last_payment_at && (
                                          <span className="text-muted-foreground ml-1">· {new Date(r.last_payment_at).toLocaleDateString()}</span>
                                        )}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground">No payment</span>
                                    )}
                                  </TableCell>
                                </TableRow>
                              ))}
                              {filtered.length === 0 && (
                                <TableRow>
                                  <TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-4">
                                    No referrals match these filters.
                                  </TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })()
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

        </TabsContent>

        <TabsContent value="downline" className="space-y-4 mt-0">
          <div className="glass neon-border rounded-xl p-4 space-y-3">
            <h3 className="font-heading font-semibold text-foreground">Downline tree</h3>
            <p className="text-xs text-muted-foreground">
              Recursive list of every partner sitting below each partner in the referral chain.
              Counts include direct children and all deeper descendants.
            </p>
          </div>

          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && partners.length === 0 && (
            <p className="text-sm text-muted-foreground">No partners yet.</p>
          )}

          {partners.map((p) => {
            const descendants = downlineMap.get(p.id) ?? [];
            const isOpen = expandedTreeId === p.id;
            return (
              <div key={p.id} className="glass rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-heading font-semibold text-foreground">
                      {p.display_name || p.code}{" "}
                      <span className="text-xs text-muted-foreground">({emailFor(p.user_id)})</span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      Code: <span className="text-primary">{p.code}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-heading font-semibold px-2 py-0.5 rounded-full bg-primary/20 text-primary">
                      Downline partners: {descendants.length}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setExpandedTreeId(isOpen ? null : p.id)}
                      className="font-heading text-xs"
                      disabled={descendants.length === 0}
                    >
                      {isOpen ? "Hide tree" : "View tree"}
                    </Button>
                  </div>
                </div>

                {isOpen && descendants.length > 0 && (
                  <div className="border-t border-border pt-3 space-y-1">
                    {descendants.map((d) => (
                      <div
                        key={d.partner.id}
                        className="flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded hover:bg-muted/30"
                        style={{ paddingLeft: `${0.5 + (d.depth - 1) * 1.25}rem` }}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${d.partner.is_active ? "bg-primary" : "bg-destructive"}`} />
                          <span className="text-muted-foreground font-mono">L{d.depth}</span>
                          <span className="font-heading font-semibold text-foreground truncate">
                            {d.partner.display_name || d.partner.code}
                          </span>
                          <span className="text-muted-foreground font-mono truncate">
                            ({d.partner.code})
                          </span>
                        </div>
                        <span className="text-muted-foreground font-mono whitespace-nowrap">
                          {Number(d.partner.commission_pct)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`bg-muted/20 rounded-lg p-2 ${highlight ? "ring-1 ring-primary/40" : ""}`}>
      <div className="text-sm font-heading font-bold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground font-heading uppercase tracking-wide">{label}</div>
    </div>
  );
}
