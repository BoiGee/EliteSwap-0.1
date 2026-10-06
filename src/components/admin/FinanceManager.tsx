import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
import { useAdmin } from "@/hooks/useAdmin";
import { DATE_PRESETS, computeDateRange, fetchAllRows } from "@/lib/adminData";

const fmtUsd = (n: number | null | undefined) =>
  `$${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The finance functions use this to put dates and months on the admin's own calendar.
const ADMIN_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

interface Overview {
  gross_revenue_usd: number;
  discounts_usd: number;
  net_revenue_usd: number;
  confirmed_payments_count: number;
  partner_commission_accrued_usd: number;
  partner_commission_paid_usd: number;
  partner_commission_balance_usd: number;
  override_commission_accrued_usd: number;
  override_commission_paid_usd: number;
  override_commission_balance_usd: number;
  operating_expenses_usd: number;
  net_profit_usd: number;
  cash_owed_usd: number;
}

interface MonthRow {
  month: string;
  revenue_usd: number;
  discounts_usd: number;
  commissions_usd: number;
  overrides_usd: number;
  expenses_usd: number;
  net_profit_usd: number;
}

interface PartnerRollup {
  partner_id: string;
  code: string;
  display_name: string | null;
  commission_pct: number;
  is_active: boolean;
  parent_partner_id: string | null;
  referred_users: number;
  confirmed_payments: number;
  gross_earnings_usd: number;
  paid_out_usd: number;
  balance_owed_usd: number;
  override_earned_usd: number;
  override_paid_usd: number;
  override_balance_usd: number;
  downline_count: number;
}

interface PaymentRow {
  id: string;
  user_id: string | null;
  plan_id: string | null;
  amount_usd: number | null;
  currency: string | null;
  discount_amount_usd: number | null;
  tx_hash: string | null;
  status: string;
  created_at: string;
}

interface ExpenseCategory {
  id: string;
  name: string;
  is_archived: boolean;
}

interface ExpenseRow {
  id: string;
  occurred_on: string;
  category_id: string;
  amount_usd: number;
  vendor: string | null;
  note: string | null;
  created_at: string;
}

export default function FinanceManager() {
  const { toast } = useToast();
  const { isAdmin, loading: rolesLoading } = useAdmin();
  const [preset, setPreset] = useState<string>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [monthly, setMonthly] = useState<MonthRow[]>([]);
  const [partners, setPartners] = useState<PartnerRollup[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Record<string, string>>({});
  const [attributions, setAttributions] = useState<Record<string, string>>({}); // user_id -> partner_id
  const [partnerCodes, setPartnerCodes] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Revenue filters
  const [revCurrency, setRevCurrency] = useState<string>("all");
  const [revPartner, setRevPartner] = useState<string>("all");
  const [revStatus, setRevStatus] = useState<string>("confirmed");
  const [revSearch, setRevSearch] = useState("");

  // Expense filters
  const [expCategory, setExpCategory] = useState<string>("all");

  // Dialogs
  const [editingExpense, setEditingExpense] = useState<ExpenseRow | null>(null);
  const [showExpenseDialog, setShowExpenseDialog] = useState(false);
  const [expForm, setExpForm] = useState({ occurred_on: "", category_id: "", amount_usd: "", vendor: "", note: "" });
  const [newCategory, setNewCategory] = useState("");

  const range = useMemo(() => computeDateRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const loadSeq = useRef(0);
  const loadAll = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const args = { p_from: range.from, p_to: range.to, p_tz: ADMIN_TZ };
    const [ovr, mo, pr, pay, prof, pl, attr, prs, cat, exp] = await Promise.all([
      supabase.rpc("finance_overview" as any, args),
      supabase.rpc("finance_monthly_series" as any, args),
      supabase.rpc("finance_partner_rollup" as any, args),
      fetchAllRows<PaymentRow>(() => supabase.from("payments").select("id,user_id,plan_id,amount_usd,currency,discount_amount_usd,tx_hash,status,created_at").order("created_at", { ascending: false }).order("id")),
      fetchAllRows<{ user_id: string; email: string | null }>(() => supabase.from("profiles").select("user_id,email").order("user_id")),
      supabase.from("pricing_plans").select("id,name"),
      fetchAllRows<{ user_id: string; partner_id: string }>(() => supabase.from("partner_attributions" as any).select("user_id,partner_id").order("user_id").order("partner_id")),
      supabase.from("partners" as any).select("id,code"),
      supabase.from("expense_categories" as any).select("*").order("name"),
      fetchAllRows<ExpenseRow>(() => supabase.from("operating_expenses" as any).select("*").order("occurred_on", { ascending: false }).order("id")),
    ]);
    // A slower response for a range the admin has since switched away from must not overwrite the newer one.
    if (seq !== loadSeq.current) return;
    // Clear rather than keep the previous range's figures, which would sit under the new range's label.
    setOverview(ovr.error ? null : ((ovr.data as any)?.[0] ?? null));
    setMonthly(mo.error ? [] : ((mo.data as any) ?? []));
    setPartners(pr.error ? [] : ((pr.data as any) ?? []));
    if (!pay.error) setPayments(pay.data);
    if (!prof.error) setProfiles(Object.fromEntries(prof.data.map((p) => [p.user_id, p.email ?? ""])));
    if (!pl.error && pl.data) setPlans(Object.fromEntries(pl.data.map((p: any) => [p.id, p.name])));
    if (!attr.error) setAttributions(Object.fromEntries(attr.data.map((a) => [a.user_id, a.partner_id])));
    if (!prs.error && prs.data) setPartnerCodes(Object.fromEntries((prs.data as any[]).map((p) => [p.id, p.code])));
    if (!cat.error && cat.data) setCategories(cat.data as any);
    if (!exp.error) setExpenses(exp.data);
    const firstError = [ovr, mo, pr, pay, prof, pl, attr, prs, cat, exp].find((r) => r.error)?.error;
    if (firstError) {
      toast({ title: "Some finance data didn't load", description: firstError.message ?? String(firstError), variant: "destructive" });
    }
    setLoading(false);
  }, [range.from, range.to, toast]);

  useEffect(() => {
    if (isAdmin) loadAll();
  }, [isAdmin, loadAll]);

  // Live: reload when a payment is created, confirmed or rejected elsewhere, and when the admin
  // comes back to the tab. Payments change rarely, so a throttled full reload is cheap.
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  useEffect(() => {
    if (!isAdmin) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        loadAllRef.current();
      }, 2000);
    };
    const channel = supabase
      .channel("finance-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, schedule)
      .subscribe();
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAllRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (pending) clearTimeout(pending);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [isAdmin]);

  const filteredPayments = useMemo(() => {
    return payments.filter((p) => {
      if (range.from && new Date(p.created_at) < new Date(range.from)) return false;
      if (range.to && new Date(p.created_at) >= new Date(range.to)) return false;
      if (revStatus !== "all" && p.status !== revStatus) return false;
      if (revCurrency !== "all" && p.currency !== revCurrency) return false;
      if (revPartner !== "all") {
        const pid = attributions[p.user_id];
        if (revPartner === "none" && pid) return false;
        if (revPartner !== "none" && pid !== revPartner) return false;
      }
      if (revSearch) {
        const q = revSearch.toLowerCase();
        const email = (profiles[p.user_id] || "").toLowerCase();
        const tx = (p.tx_hash || "").toLowerCase();
        if (!email.includes(q) && !tx.includes(q)) return false;
      }
      return true;
    });
  }, [payments, range, revStatus, revCurrency, revPartner, revSearch, attributions, profiles]);

  // occurred_on is a calendar date; compare it to the range's local days, as finance_overview does.
  const filteredExpenses = useMemo(() => {
    const fromDay = range.from ? localDay(new Date(range.from)) : null;
    const toDay = range.to ? localDay(new Date(new Date(range.to).getTime() - 1)) : null;
    return expenses.filter((e) => {
      if (expCategory !== "all" && e.category_id !== expCategory) return false;
      if (fromDay && e.occurred_on < fromDay) return false;
      if (toDay && e.occurred_on > toDay) return false;
      return true;
    });
  }, [expenses, expCategory, range]);

  const missingAmountCount = useMemo(
    () =>
      payments.filter(
        (p) =>
          p.status === "confirmed" &&
          p.amount_usd == null &&
          (!range.from || new Date(p.created_at) >= new Date(range.from)) &&
          (!range.to || new Date(p.created_at) < new Date(range.to)),
      ).length,
    [payments, range],
  );

  const currencies = useMemo(() => {
    const s = new Set<string>();
    payments.forEach((p) => p.currency && s.add(p.currency));
    return Array.from(s).sort();
  }, [payments]);

  const openNewExpense = () => {
    setEditingExpense(null);
    setExpForm({
      occurred_on: new Date().toISOString().slice(0, 10),
      category_id: categories[0]?.id || "",
      amount_usd: "",
      vendor: "",
      note: "",
    });
    setShowExpenseDialog(true);
  };

  const openEditExpense = (e: ExpenseRow) => {
    setEditingExpense(e);
    setExpForm({
      occurred_on: e.occurred_on,
      category_id: e.category_id,
      amount_usd: String(e.amount_usd),
      vendor: e.vendor || "",
      note: e.note || "",
    });
    setShowExpenseDialog(true);
  };

  const openDuplicateExpense = (e: ExpenseRow) => {
    setEditingExpense(null);
    setExpForm({
      occurred_on: new Date().toISOString().slice(0, 10),
      category_id: e.category_id,
      amount_usd: String(e.amount_usd),
      vendor: e.vendor || "",
      note: e.note || "",
    });
    setShowExpenseDialog(true);
  };

  const saveExpense = async () => {
    const amount = Number(expForm.amount_usd);
    if (!expForm.category_id || !Number.isFinite(amount) || amount < 0) {
      toast({ title: "Invalid expense", variant: "destructive" });
      return;
    }
    // A mistyped year (one expense was saved as 0001-06-10) silently drops the expense from every range.
    const year = Number(expForm.occurred_on.slice(0, 4));
    const maxYear = new Date().getFullYear() + 1;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expForm.occurred_on) || year < 2020 || year > maxYear) {
      toast({ title: "Check the date", description: `Expense dates must fall between 2020 and ${maxYear}.`, variant: "destructive" });
      return;
    }
    const payload: any = {
      occurred_on: expForm.occurred_on,
      category_id: expForm.category_id,
      amount_usd: amount,
      vendor: expForm.vendor || null,
      note: expForm.note || null,
    };
    const { error } = editingExpense
      ? await supabase.from("operating_expenses" as any).update(payload).eq("id", editingExpense.id)
      : await supabase.from("operating_expenses" as any).insert({ ...payload, created_by: (await supabase.auth.getUser()).data.user?.id });
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: editingExpense ? "Expense updated" : "Expense added" });
      setShowExpenseDialog(false);
      loadAll();
    }
  };

  const deleteExpense = async (id: string) => {
    if (!confirm("Delete this expense?")) return;
    const { error } = await supabase.from("operating_expenses" as any).delete().eq("id", id);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else { toast({ title: "Deleted" }); loadAll(); }
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    const { error } = await supabase.from("expense_categories" as any).insert({ name });
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else { setNewCategory(""); loadAll(); }
  };

  const toggleArchiveCategory = async (c: ExpenseCategory) => {
    const { error } = await supabase.from("expense_categories" as any).update({ is_archived: !c.is_archived }).eq("id", c.id);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else loadAll();
  };

  const exportRevenue = () => {
    const rows = filteredPayments.map((p) => ({
      date: p.created_at,
      email: profiles[p.user_id] || "",
      plan: p.plan_id ? plans[p.plan_id] || "" : "",
      amount_usd: p.amount_usd ?? "",
      currency: p.currency || "",
      discount_usd: p.discount_amount_usd ?? "",
      partner_code: attributions[p.user_id] ? partnerCodes[attributions[p.user_id]] || "" : "",
      tx_hash: p.tx_hash || "",
      status: p.status,
    }));
    download(`revenue_${Date.now()}.csv`, toCSV(rows));
  };

  const exportExpenses = () => {
    const rows = filteredExpenses.map((e) => ({
      date: e.occurred_on,
      category: categories.find((c) => c.id === e.category_id)?.name || "",
      amount_usd: e.amount_usd,
      vendor: e.vendor || "",
      note: e.note || "",
    }));
    download(`expenses_${Date.now()}.csv`, toCSV(rows));
  };

  const kpis = overview;

  // Finance is admin-only. Sec admins and moderators must never see this pane,
  // even if they somehow deep-link to /admin?tab=finance.
  if (rolesLoading) return null;
  if (!isAdmin) {
    return (
      <div className="glass rounded-xl p-8 text-center">
        <h2 className="text-xl font-heading font-bold text-foreground mb-2">Not authorized</h2>
        <p className="text-sm text-muted-foreground">
          Finance & P&L is restricted to full admins.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-2xl font-heading font-bold text-foreground">Finance & P&L</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((p) => <SelectItem key={String(p.days)} value={String(p.days)}>{p.label}</SelectItem>)}
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
          {preset === "custom" && (
            <>
              <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-[150px]" />
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-[150px]" />
            </>
          )}
          <Button variant="outline" size="sm" onClick={loadAll} disabled={loading} className="font-heading">{loading ? "…" : "Refresh"}</Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="revenue">Revenue</TabsTrigger>
            <TabsTrigger value="partners">Partners</TabsTrigger>
            <TabsTrigger value="expenses">Expenses</TabsTrigger>
            <TabsTrigger value="chart">P&L Chart</TabsTrigger>
          </TabsList>
        </div>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Gross revenue", value: fmtUsd(kpis?.gross_revenue_usd), icon: "💰" },
              { label: "Discounts", value: fmtUsd(kpis?.discounts_usd), icon: "🏷️" },
              { label: "Net revenue", value: fmtUsd(kpis?.net_revenue_usd), icon: "📈" },
              { label: "Confirmed payments", value: String(kpis?.confirmed_payments_count ?? 0), icon: "✅" },
              { label: "Partner commission (accrued)", value: fmtUsd(kpis?.partner_commission_accrued_usd), icon: "🤝" },
              { label: "Partner paid out", value: fmtUsd(kpis?.partner_commission_paid_usd), icon: "💸" },
              { label: "Override (accrued)", value: fmtUsd(kpis?.override_commission_accrued_usd), icon: "🌳" },
              { label: "Override paid out", value: fmtUsd(kpis?.override_commission_paid_usd), icon: "💸" },
              { label: "Operating expenses", value: fmtUsd(kpis?.operating_expenses_usd), icon: "🧾" },
              { label: "Cash owed", value: fmtUsd(kpis?.cash_owed_usd), icon: "⏳" },
              { label: "Net profit", value: fmtUsd(kpis?.net_profit_usd), icon: "🏆" },
            ].map((s) => (
              <div key={s.label} className="glass neon-border rounded-xl p-4 space-y-1">
                <div className="text-xl">{s.icon}</div>
                <div className="text-xl font-heading font-bold text-foreground">{s.value}</div>
                <div className="text-xs text-muted-foreground font-heading">{s.label}</div>
              </div>
            ))}
          </div>
          {missingAmountCount > 0 && (
            <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              {missingAmountCount} confirmed payment{missingAmountCount === 1 ? " has" : "s have"} no USD amount recorded, so {missingAmountCount === 1 ? "it adds" : "they add"} $0 to revenue. They show as $0.00 in the Revenue tab.
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Gross revenue is the list price before discounts; net revenue is what customers actually paid.
            Net profit = Net revenue − Partner commissions (direct) − Override commissions − Operating expenses. Uses each payment's snapshot percentage so historical changes are correct.
            Cash owed is the commission and override balance still unpaid as of the end of the selected range.
            $10 trial revenue is tracked separately in the "$10 Trials" tab and is not folded into these figures.
          </div>
        </TabsContent>

        {/* Revenue */}
        <TabsContent value="revenue" className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Input placeholder="Search email or tx hash" value={revSearch} onChange={(e) => setRevSearch(e.target.value)} className="w-[240px]" />
            <Select value={revStatus} onValueChange={setRevStatus}>
              <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
            <Select value={revCurrency} onValueChange={setRevCurrency}>
              <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All currencies</SelectItem>
                {currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={revPartner} onValueChange={setRevPartner}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All partners</SelectItem>
                <SelectItem value="none">No partner</SelectItem>
                {partners.map((p) => <SelectItem key={p.partner_id} value={p.partner_id}>{p.code}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="ml-auto text-xs text-muted-foreground">{filteredPayments.length} rows</div>
            <Button variant="outline" size="sm" onClick={exportRevenue} className="font-heading">Export CSV</Button>
          </div>
          <div className="glass rounded-xl overflow-auto max-h-[60vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead>Partner</TableHead>
                  <TableHead>Tx</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPayments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs">{new Date(p.created_at).toLocaleDateString()}</TableCell>
                    <TableCell className="text-xs truncate max-w-[180px]">{(p.user_id && profiles[p.user_id]) || (p.user_id ? p.user_id.slice(0, 8) : "deleted account")}</TableCell>
                    <TableCell className="text-xs">{p.plan_id ? plans[p.plan_id] || "—" : "—"}</TableCell>
                    <TableCell className="text-xs text-right">{fmtUsd(p.amount_usd)}</TableCell>
                    <TableCell className="text-xs">{p.currency || "—"}</TableCell>
                    <TableCell className="text-xs text-right">{p.discount_amount_usd ? fmtUsd(p.discount_amount_usd) : "—"}</TableCell>
                    <TableCell className="text-xs">{attributions[p.user_id] ? partnerCodes[attributions[p.user_id]] || "—" : "—"}</TableCell>
                    <TableCell className="text-xs font-mono truncate max-w-[120px]">{p.tx_hash || "—"}</TableCell>
                    <TableCell className="text-xs">{p.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* Partners */}
        <TabsContent value="partners" className="space-y-3">
          <div className="glass rounded-xl overflow-auto max-h-[70vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Pct</TableHead>
                  <TableHead className="text-right">Referrals</TableHead>
                  <TableHead className="text-right">Payments</TableHead>
                  <TableHead className="text-right">Earned</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Override earned</TableHead>
                  <TableHead className="text-right">Override paid</TableHead>
                  <TableHead className="text-right">Downline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partners.map((p) => {
                  // As of the range end, from the beginning; earned/paid columns are activity inside the range.
                  const balance = Number(p.balance_owed_usd);
                  return (
                    <TableRow key={p.partner_id}>
                      <TableCell className="text-xs font-mono">{p.code}</TableCell>
                      <TableCell className="text-xs">{p.display_name || "—"}</TableCell>
                      <TableCell className="text-xs text-right">{p.commission_pct}%</TableCell>
                      <TableCell className="text-xs text-right">{p.referred_users}</TableCell>
                      <TableCell className="text-xs text-right">{p.confirmed_payments}</TableCell>
                      <TableCell className="text-xs text-right">{fmtUsd(p.gross_earnings_usd)}</TableCell>
                      <TableCell className="text-xs text-right">{fmtUsd(p.paid_out_usd)}</TableCell>
                      <TableCell className="text-xs text-right font-semibold">{fmtUsd(balance)}</TableCell>
                      <TableCell className="text-xs text-right">{fmtUsd(p.override_earned_usd)}</TableCell>
                      <TableCell className="text-xs text-right">{fmtUsd(p.override_paid_usd)}</TableCell>
                      <TableCell className="text-xs text-right">{p.downline_count}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* Expenses */}
        <TabsContent value="expenses" className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={expCategory} onValueChange={setExpCategory}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.filter((c) => !c.is_archived).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={exportExpenses} className="font-heading">Export CSV</Button>
              <Button size="sm" onClick={openNewExpense} className="font-heading">+ Add expense</Button>
            </div>
          </div>

          <div className="glass rounded-xl overflow-auto max-h-[50vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredExpenses.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{e.occurred_on}</TableCell>
                    <TableCell className="text-xs">{categories.find((c) => c.id === e.category_id)?.name || "—"}</TableCell>
                    <TableCell className="text-xs text-right">{fmtUsd(e.amount_usd)}</TableCell>
                    <TableCell className="text-xs">{e.vendor || "—"}</TableCell>
                    <TableCell className="text-xs truncate max-w-[280px]">{e.note || "—"}</TableCell>
                    <TableCell className="text-xs space-x-1">
                      <Button size="sm" variant="outline" onClick={() => openEditExpense(e)} className="font-heading text-xs h-7">Edit</Button>
                      <Button size="sm" variant="outline" onClick={() => openDuplicateExpense(e)} className="font-heading text-xs h-7">Dup</Button>
                      <Button size="sm" variant="outline" onClick={() => deleteExpense(e.id)} className="font-heading text-xs h-7 border-destructive/30 text-destructive hover:bg-destructive/10">Del</Button>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredExpenses.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-xs py-6">No expenses in this range.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="glass rounded-xl p-4 space-y-3">
            <h3 className="font-heading font-semibold text-foreground text-sm">Manage categories</h3>
            <div className="flex gap-2">
              <Input placeholder="New category name" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className="w-[240px]" />
              <Button size="sm" onClick={addCategory} className="font-heading">Add</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <div key={c.id} className={`px-3 py-1 rounded-full text-xs flex items-center gap-2 ${c.is_archived ? "bg-muted/30 text-muted-foreground line-through" : "bg-primary/10 text-primary"}`}>
                  {c.name}
                  <button onClick={() => toggleArchiveCategory(c)} className="text-xs underline">{c.is_archived ? "restore" : "archive"}</button>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* Chart */}
        <TabsContent value="chart" className="space-y-3">
          <div className="glass rounded-xl p-4 h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly.map((m) => ({ ...m, month: new Date(`${m.month}T00:00:00`).toLocaleDateString(undefined, { year: "2-digit", month: "short" }) }))}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => fmtUsd(v)} contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="revenue_usd" name="Revenue" fill="hsl(var(--primary))" />
                <Bar dataKey="commissions_usd" name="Commissions" fill="#f59e0b" />
                <Bar dataKey="overrides_usd" name="Overrides" fill="#8b5cf6" />
                <Bar dataKey="expenses_usd" name="Expenses" fill="#ef4444" />
                <Bar dataKey="net_profit_usd" name="Net profit" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={showExpenseDialog} onOpenChange={setShowExpenseDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-heading">{editingExpense ? "Edit expense" : "Add expense"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-heading">Date</Label>
              <Input type="date" min="2020-01-01" max={`${new Date().getFullYear() + 1}-12-31`} value={expForm.occurred_on} onChange={(e) => setExpForm({ ...expForm, occurred_on: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-heading">Category</Label>
              <Select value={expForm.category_id} onValueChange={(v) => setExpForm({ ...expForm, category_id: v })}>
                <SelectTrigger><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>
                  {categories.filter((c) => !c.is_archived).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-heading">Amount (USD)</Label>
              <Input type="number" step="0.01" min="0" value={expForm.amount_usd} onChange={(e) => setExpForm({ ...expForm, amount_usd: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-heading">Vendor (optional)</Label>
              <Input value={expForm.vendor} onChange={(e) => setExpForm({ ...expForm, vendor: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-heading">Note (optional)</Label>
              <Textarea value={expForm.note} onChange={(e) => setExpForm({ ...expForm, note: e.target.value })} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExpenseDialog(false)} className="font-heading">Cancel</Button>
            <Button onClick={saveExpense} className="font-heading">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
