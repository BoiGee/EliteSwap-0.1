import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAdmin } from "@/hooks/useAdmin";

const fmtUsd = (n: number | null | undefined) =>
  `$${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const toCSV = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
};

const download = (filename: string, content: string) => {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

interface TrialRow {
  id: string;
  user_id: string;
  payment_method: string;
  amount_usd: number | null;
  amount_local: number | null;
  currency: string | null;
  status: string;
  provider_reference: string | null;
  usdt_network: string | null;
  assigned_key_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  needs_admin_review: boolean;
}

const binanceDepositUrl = (ref: string) =>
  `https://www.binance.com/en/my/wallet/history/deposit-crypto?search=${encodeURIComponent(ref)}`;

export default function TrialPurchaseManager() {
  const { toast } = useToast();
  const { isAdmin, isSecAdmin, loading: rolesLoading } = useAdmin();
  const canManage = isAdmin || isSecAdmin;

  const [trials, setTrials] = useState<TrialRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [profileNames, setProfileNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [trialBusy, setTrialBusy] = useState<string | null>(null);

  const [trialMethod, setTrialMethod] = useState<string>("all");
  const [trialStatus, setTrialStatus] = useState<string>("all");
  const [trialKey, setTrialKey] = useState<string>("all");
  const [trialSearch, setTrialSearch] = useState("");
  const [trialSort, setTrialSort] = useState<string>("date_desc");

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [tri, prof] = await Promise.all([
      supabase.from("trial_purchases" as any)
        .select("id,user_id,payment_method,amount_usd,amount_local,currency,status,provider_reference,usdt_network,assigned_key_id,confirmed_at,created_at,needs_admin_review")
        .order("created_at", { ascending: false })
        .limit(5000),
      supabase.from("profiles").select("user_id,email,display_name").limit(10000),
    ]);
    if (tri.data) setTrials(tri.data as any);
    if (prof.data) {
      setProfiles(Object.fromEntries(prof.data.map((p: any) => [p.user_id, p.email ?? ""])));
      setProfileNames(Object.fromEntries(prof.data.map((p: any) => [p.user_id, p.display_name ?? ""])));
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Live refresh: paid trial confirmations happen via webhook/cron with zero
  // admin action, so without this the tab would sit stale until reopened —
  // same class of gap fixed on the Overview tab.
  useEffect(() => {
    const channel = supabase
      .channel("admin-trial-purchases-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "trial_purchases" }, () => loadAll())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadAll]);

  const filteredTrials = useMemo(() => {
    const list = trials.filter((t) => {
      if (trialStatus !== "all" && t.status !== trialStatus) return false;
      if (trialMethod !== "all" && t.payment_method !== trialMethod) return false;
      if (trialKey === "assigned" && !t.assigned_key_id) return false;
      if (trialKey === "unassigned" && !!t.assigned_key_id) return false;
      if (trialSearch) {
        const q = trialSearch.toLowerCase().trim();
        const email = (profiles[t.user_id] || "").toLowerCase();
        const name = (profileNames[t.user_id] || "").toLowerCase();
        const ref = (t.provider_reference || "").toLowerCase();
        const uid = t.user_id.toLowerCase();
        const keyId = (t.assigned_key_id || "").toLowerCase();
        const net = (t.usdt_network || "").toLowerCase();
        const cur = (t.currency || "").toLowerCase();
        const amt = String(t.amount_usd ?? "");
        const hay = `${email} ${name} ${ref} ${uid} ${keyId} ${net} ${cur} ${amt}`;
        const tokens = q.split(/\s+/).filter(Boolean);
        if (!tokens.every((tok) => hay.includes(tok))) return false;
      }
      return true;
    });
    const dateOf = (t: TrialRow) => new Date(t.confirmed_at || t.created_at).getTime();
    const emailOf = (t: TrialRow) => (profiles[t.user_id] || profileNames[t.user_id] || "").toLowerCase();
    list.sort((a, b) => {
      switch (trialSort) {
        case "date_asc": return dateOf(a) - dateOf(b);
        case "amount_desc": return Number(b.amount_usd || 0) - Number(a.amount_usd || 0);
        case "amount_asc": return Number(a.amount_usd || 0) - Number(b.amount_usd || 0);
        case "email_asc": return emailOf(a).localeCompare(emailOf(b));
        case "email_desc": return emailOf(b).localeCompare(emailOf(a));
        case "status": return (a.status || "").localeCompare(b.status || "");
        case "method": return (a.payment_method || "").localeCompare(b.payment_method || "");
        case "date_desc":
        default: return dateOf(b) - dateOf(a);
      }
    });
    return list;
  }, [trials, trialStatus, trialMethod, trialKey, trialSearch, trialSort, profiles, profileNames]);

  const trialStats = useMemo(() => {
    const confirmed = filteredTrials.filter((t) => t.status === "confirmed");
    const usdt = confirmed.filter((t) => t.payment_method === "usdt");
    const ps = confirmed.filter((t) => t.payment_method === "paystack");
    const sum = (arr: TrialRow[]) => arr.reduce((s, t) => s + Number(t.amount_usd || 0), 0);
    return {
      total_usd: sum(confirmed),
      total_count: confirmed.length,
      usdt_usd: sum(usdt),
      usdt_count: usdt.length,
      paystack_usd: sum(ps),
      paystack_count: ps.length,
      assigned_count: confirmed.filter((t) => !!t.assigned_key_id).length,
      pending_count: filteredTrials.filter((t) => t.status === "pending").length,
      needs_review_count: filteredTrials.filter((t) => t.needs_admin_review).length,
    };
  }, [filteredTrials]);

  const handleTrialAction = useCallback(async (
    purchaseId: string,
    action: "confirm" | "reject" | "reset_pending",
    label: string,
  ) => {
    if (!canManage) return;
    if (!window.confirm(`${label} this $10 trial purchase?`)) return;
    setTrialBusy(purchaseId);
    try {
      const { data, error } = await supabase.rpc("admin_manage_trial_purchase" as any, {
        p_purchase_id: purchaseId,
        p_action: action,
      });
      if (error) throw error;
      toast({ title: `Trial ${label.toLowerCase()}ed`, description: JSON.stringify(data) });
      await loadAll();
    } catch (e: any) {
      toast({ title: "Action failed", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setTrialBusy(null);
    }
  }, [canManage, toast, loadAll]);

  const exportTrials = () => {
    const rows = filteredTrials.map((t) => ({
      date: t.confirmed_at || t.created_at,
      email: profiles[t.user_id] || "",
      method: t.payment_method === "usdt"
        ? `USDT${t.usdt_network ? ` (${t.usdt_network})` : ""}`
        : t.payment_method === "paystack" ? "Momo/Card" : t.payment_method,
      amount_usd: t.amount_usd ?? "",
      amount_local: t.amount_local ?? "",
      currency: t.currency || "",
      provider_reference: t.provider_reference || "",
      key_assigned: t.assigned_key_id ? "yes" : "no",
      status: t.status,
    }));
    download(`trial_purchases_${Date.now()}.csv`, toCSV(rows));
  };

  if (rolesLoading) return null;
  if (!canManage) {
    return (
      <div className="glass rounded-xl p-8 text-center">
        <h2 className="text-xl font-heading font-bold text-foreground mb-2">Not authorized</h2>
        <p className="text-sm text-muted-foreground">$10 Trials is restricted to admins and sec admins.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-heading font-bold text-foreground">$10 Trials</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Tracked separately from the main Revenue / Net revenue figures on the Finance tab.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAll} disabled={loading} className="font-heading">{loading ? "…" : "Refresh"}</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Trial revenue (confirmed)", value: fmtUsd(trialStats.total_usd), icon: "💵" },
          { label: "Confirmed trials", value: String(trialStats.total_count), icon: "✅" },
          { label: "USDT revenue", value: `${fmtUsd(trialStats.usdt_usd)} (${trialStats.usdt_count})`, icon: "🪙" },
          { label: "Momo/Card revenue", value: `${fmtUsd(trialStats.paystack_usd)} (${trialStats.paystack_count})`, icon: "💳" },
          { label: "Keys auto-assigned", value: String(trialStats.assigned_count), icon: "🔑" },
          { label: "Pending trials", value: String(trialStats.pending_count), icon: "⏳" },
          { label: "Needs manual review", value: String(trialStats.needs_review_count), icon: "🟡" },
        ].map((s) => (
          <div key={s.label} className="glass neon-border rounded-xl p-4 space-y-1">
            <div className="text-xl">{s.icon}</div>
            <div className="text-xl font-heading font-bold text-foreground">{s.value}</div>
            <div className="text-xs text-muted-foreground font-heading">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search email, name, user id, reference, key id, amount…"
          value={trialSearch}
          onChange={(e) => setTrialSearch(e.target.value)}
          className="w-[300px]"
        />
        <Select value={trialStatus} onValueChange={setTrialStatus}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={trialMethod} onValueChange={setTrialMethod}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All methods</SelectItem>
            <SelectItem value="usdt">USDT</SelectItem>
            <SelectItem value="paystack">Momo/Card</SelectItem>
          </SelectContent>
        </Select>
        <Select value={trialKey} onValueChange={setTrialKey}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any key state</SelectItem>
            <SelectItem value="assigned">Key assigned</SelectItem>
            <SelectItem value="unassigned">No key yet</SelectItem>
          </SelectContent>
        </Select>
        <Select value={trialSort} onValueChange={setTrialSort}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="date_desc">Newest first</SelectItem>
            <SelectItem value="date_asc">Oldest first</SelectItem>
            <SelectItem value="amount_desc">Amount ↓</SelectItem>
            <SelectItem value="amount_asc">Amount ↑</SelectItem>
            <SelectItem value="email_asc">Email A–Z</SelectItem>
            <SelectItem value="email_desc">Email Z–A</SelectItem>
            <SelectItem value="status">Status</SelectItem>
            <SelectItem value="method">Method</SelectItem>
          </SelectContent>
        </Select>
        {(trialSearch || trialStatus !== "all" || trialMethod !== "all" || trialKey !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setTrialSearch(""); setTrialStatus("all"); setTrialMethod("all"); setTrialKey("all"); }}
            className="font-heading text-xs"
          >
            Clear
          </Button>
        )}
        <div className="ml-auto text-xs text-muted-foreground">{filteredTrials.length} rows</div>
        <Button variant="outline" size="sm" onClick={exportTrials} className="font-heading">Export CSV</Button>
      </div>

      <div className="glass rounded-xl overflow-auto max-h-[65vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Local</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTrials.map((t) => {
              const d = t.confirmed_at || t.created_at;
              const method = t.payment_method === "usdt"
                ? `USDT${t.usdt_network ? ` (${t.usdt_network})` : ""}`
                : t.payment_method === "paystack" ? "Momo/Card" : t.payment_method;
              const busy = trialBusy === t.id;
              return (
                <TableRow key={t.id}>
                  <TableCell className="text-xs">{new Date(d).toLocaleDateString()}</TableCell>
                  <TableCell className="text-xs max-w-[220px]">
                    <div className="truncate font-heading text-foreground" title={profileNames[t.user_id] || profiles[t.user_id] || t.user_id}>
                      {profileNames[t.user_id] || profiles[t.user_id] || t.user_id.slice(0, 8)}
                    </div>
                    {profileNames[t.user_id] && profiles[t.user_id] && (
                      <div className="truncate text-[10px] text-muted-foreground" title={profiles[t.user_id]}>{profiles[t.user_id]}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{method}</TableCell>
                  <TableCell className="text-xs text-right">{fmtUsd(t.amount_usd)}</TableCell>
                  <TableCell className="text-xs">{t.amount_local ? `${t.amount_local} ${t.currency || ""}` : "—"}</TableCell>
                  <TableCell className="text-xs font-mono truncate max-w-[160px]">
                    {t.provider_reference || "—"}
                    {t.needs_admin_review && t.provider_reference && (
                      <a
                        href={binanceDepositUrl(t.provider_reference)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-[10px] font-heading font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
                      >
                        Binance Deposit History ↗
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${t.assigned_key_id ? "bg-emerald-500/15 text-emerald-400" : "bg-muted/30 text-muted-foreground"}`}>
                      {t.assigned_key_id ? "Assigned" : "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex flex-col gap-1 items-start">
                      <span>{t.status}</span>
                      {t.needs_admin_review && (
                        <Badge
                          variant="outline"
                          className="font-heading font-semibold text-[10px] bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                        >
                          Binance off-chain
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex flex-wrap gap-1">
                      {(t.status !== "confirmed" || !t.assigned_key_id) && (
                        <Button size="sm" variant="outline" disabled={busy}
                          onClick={() => handleTrialAction(t.id, "confirm", t.assigned_key_id ? "Re-confirm" : "Confirm & assign key")}>
                          {t.status === "confirmed" && !t.assigned_key_id ? "Assign key" : "Confirm"}
                        </Button>
                      )}
                      {t.status === "pending" && (
                        <Button size="sm" variant="destructive" disabled={busy}
                          onClick={() => handleTrialAction(t.id, "reject", "Mark failed")}>
                          Reject
                        </Button>
                      )}
                      {t.status === "failed" && (
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => handleTrialAction(t.id, "reset_pending", "Reopen as pending")}>
                          Reopen
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {filteredTrials.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground text-xs py-6">No trial purchases match these filters.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
