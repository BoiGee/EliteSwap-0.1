import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdmin } from "@/hooks/useAdmin";
import { useToast } from "@/hooks/use-toast";
import AppHeader from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WALLETS, type PayCurrency } from "@/components/CryptoPayment";
import { Wallet, Users, Receipt, TrendingUp, Landmark, Copy } from "lucide-react";
import { fmtUsd, resellerLink, rpc, rpcErrorMessage, splitSale } from "@/lib/reseller";

type Period = "monthly" | "annual";

interface PlanRow {
  plan_id: string;
  name: string;
  minutes: number;
  list_monthly_usd: number;
  list_annual_usd: number | null;
  monthly_price_usd: number | null;
  monthly_proposed_usd: number | null;
  annual_price_usd: number | null;
  annual_proposed_usd: number | null;
}
interface CustomerRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  attached_at: string;
  remaining_ms: number;
  purchases: number;
}
interface SaleRow {
  id: string;
  customer_user_id: string;
  customer_email: string | null;
  plan_name: string;
  billing_period: Period;
  list_price_usd: number;
  price_usd: number;
  platform_share_usd: number;
  reseller_share_usd: number;
  status: "active" | "voided";
  created_at: string;
  voided_at: string | null;
  can_void: boolean;
}
interface LedgerRow { id: string; kind: string; amount_usd: number; balance_after_usd: number; note: string | null; created_at: string }
interface TopupRow {
  id: string; amount_usd: number; currency: string; tx_hash: string; status: "pending" | "approved" | "rejected";
  credited_usd: number | null; review_note: string | null; created_at: string; reviewed_at: string | null;
}
interface Dashboard {
  reseller: { id: string; code: string; display_name: string; contact: string | null; balance_usd: number; is_active: boolean };
  plans: PlanRow[];
  customers: CustomerRow[];
  sales: SaleRow[];
  ledger: LedgerRow[];
  topups: TopupRow[];
}

const listFor = (p: PlanRow, period: Period) => (period === "annual" ? p.list_annual_usd : p.list_monthly_usd);
const priceFor = (p: PlanRow, period: Period) => (period === "annual" ? p.annual_price_usd : p.monthly_price_usd);
const proposedFor = (p: PlanRow, period: Period) => (period === "annual" ? p.annual_proposed_usd : p.monthly_proposed_usd);
const fmtDate = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const minutesLeft = (ms: number) => `${Math.floor((ms || 0) / 60000).toLocaleString()} min`;
const KIND_LABEL: Record<string, string> = { topup: "Top-up", sale: "Sale", void: "Cancelled sale", adjustment: "Adjustment" };

export default function Reseller() {
  const navigate = useNavigate();
  const { isAdmin } = useAdmin();
  const { toast } = useToast();
  const [data, setData] = useState<Dashboard | null>(null);
  const [notReseller, setNotReseller] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data: d, error } = await rpc("reseller_dashboard");
    if (error) {
      if (/isn't a reseller|Sign in required/i.test(error.message)) setNotReseller(true);
      else toast({ title: "Couldn't load your reseller account", description: rpcErrorMessage(error), variant: "destructive" });
    } else {
      setData(d as unknown as Dashboard);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // ------------------------------------------------------------ contact + link
  const [contact, setContact] = useState("");
  useEffect(() => { setContact(data?.reseller.contact ?? ""); }, [data?.reseller.contact]);
  const saveContact = async () => {
    const { error } = await rpc("reseller_update_contact", { p_contact: contact });
    if (error) toast({ title: "Couldn't save", description: rpcErrorMessage(error), variant: "destructive" });
    else { toast({ title: "Contact saved" }); load(); }
  };
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast({ title: `${label} copied` }); } catch { toast({ title: "Couldn't copy", variant: "destructive" }); }
  };

  // ------------------------------------------------------------ prices
  const [editing, setEditing] = useState<{ plan: PlanRow; period: Period } | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const proposePrice = async () => {
    if (!editing) return;
    const price = Number(editPrice);
    const { error } = await rpc("reseller_propose_price", {
      p_plan_id: editing.plan.plan_id, p_billing_period: editing.period, p_price_usd: price,
    });
    if (error) { toast({ title: "Couldn't propose this price", description: rpcErrorMessage(error), variant: "destructive" }); return; }
    toast({ title: "Price sent for approval", description: "Elite Swap will review it. Your current price applies until then." });
    setEditing(null);
    load();
  };

  // ------------------------------------------------------------ top-up
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCurrency, setTopupCurrency] = useState<PayCurrency>("USDT-TRC20");
  const [topupAmount, setTopupAmount] = useState("");
  const [topupHash, setTopupHash] = useState("");
  const [topupBusy, setTopupBusy] = useState(false);
  const wallet = WALLETS.find((w) => w.currencyCode === topupCurrency) ?? WALLETS[0];
  const submitTopup = async () => {
    setTopupBusy(true);
    const { error } = await rpc("reseller_submit_topup", {
      p_amount_usd: Number(topupAmount), p_currency: topupCurrency, p_tx_hash: topupHash,
    });
    setTopupBusy(false);
    if (error) { toast({ title: "Couldn't submit the top-up", description: rpcErrorMessage(error), variant: "destructive" }); return; }
    toast({ title: "Top-up submitted", description: "Your balance goes up once Elite Swap confirms the transfer." });
    setTopupOpen(false); setTopupAmount(""); setTopupHash("");
    load();
  };

  // ------------------------------------------------------------ sell
  const [sellFor, setSellFor] = useState<CustomerRow | null>(null);
  const [sellPlanId, setSellPlanId] = useState("");
  const [sellPeriod, setSellPeriod] = useState<Period>("monthly");
  const [sellBusy, setSellBusy] = useState(false);
  const sellablePlans = useMemo(
    () => (data?.plans ?? []).filter((p) => p.monthly_price_usd != null || p.annual_price_usd != null),
    [data?.plans],
  );
  const openSell = (c: CustomerRow) => {
    const first = sellablePlans[0];
    setSellFor(c);
    setSellPlanId(first?.plan_id ?? "");
    setSellPeriod(first && first.monthly_price_usd == null ? "annual" : "monthly");
  };
  const sellPlan = sellablePlans.find((p) => p.plan_id === sellPlanId) ?? null;
  const sellList = sellPlan ? listFor(sellPlan, sellPeriod) : null;
  const sellPrice = sellPlan ? priceFor(sellPlan, sellPeriod) : null;
  const sellSplit = sellList != null && sellPrice != null ? splitSale(sellList, sellPrice) : null;
  const balance = data?.reseller.balance_usd ?? 0;
  const recordSale = async () => {
    if (!sellFor || !sellPlan) return;
    setSellBusy(true);
    const { data: res, error } = await rpc("reseller_record_sale", {
      p_customer_user_id: sellFor.user_id, p_plan_id: sellPlan.plan_id, p_billing_period: sellPeriod,
    });
    setSellBusy(false);
    if (error) { toast({ title: "Sale not recorded", description: rpcErrorMessage(error), variant: "destructive" }); return; }
    const r = res as { key_label: string; minutes: number; reseller_share_usd: number };
    toast({
      title: `Sold: ${r.key_label}`,
      description: `${sellFor.email ?? "Your customer"} now has a ${r.minutes.toLocaleString()}-minute key. You keep ${fmtUsd(r.reseller_share_usd)}.`,
    });
    setSellFor(null);
    load();
  };

  // ------------------------------------------------------------ void
  const [voiding, setVoiding] = useState<SaleRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const voidSale = async () => {
    if (!voiding) return;
    const { data: res, error } = await rpc("reseller_void_sale", { p_sale_id: voiding.id, p_reason: voidReason || null });
    if (error) { toast({ title: "Couldn't cancel this sale", description: rpcErrorMessage(error), variant: "destructive" }); return; }
    toast({ title: "Sale cancelled", description: `${fmtUsd((res as { refunded_usd: number }).refunded_usd)} is back in your balance and the key is switched off.` });
    setVoiding(null); setVoidReason("");
    load();
  };

  // ------------------------------------------------------------ render
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <AppHeader active="reseller" isStaff={isAdmin} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground font-heading">Loading…</div>
      </div>
    );
  }
  if (notReseller || !data) {
    return (
      <div className="min-h-screen flex flex-col">
        <AppHeader isStaff={isAdmin} />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="glass border border-border rounded-2xl p-8 text-center space-y-3 max-w-sm">
            <h1 className="text-xl font-heading font-bold text-foreground">Reseller console</h1>
            <p className="text-sm text-muted-foreground">This page is for Elite Swap resellers. Contact Elite Swap if you'd like to become one.</p>
            <Button onClick={() => navigate("/dashboard")} variant="outline" className="font-heading">Back to Dashboard</Button>
          </div>
        </div>
      </div>
    );
  }

  const r = data.reseller;
  const activeSales = data.sales.filter((s) => s.status === "active");
  const stats = [
    { label: "Balance", value: fmtUsd(r.balance_usd), icon: Wallet },
    { label: "Customers", value: data.customers.length, icon: Users },
    { label: "Sales", value: activeSales.length, icon: Receipt },
    { label: "Your profit", value: fmtUsd(activeSales.reduce((a, s) => a + Number(s.reseller_share_usd), 0)), icon: TrendingUp },
    { label: "Paid to Elite Swap", value: fmtUsd(activeSales.reduce((a, s) => a + Number(s.platform_share_usd), 0)), icon: Landmark },
  ];
  const link = resellerLink(r.code);

  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader
        active="reseller"
        isStaff={isAdmin}
        isReseller
        leftExtra={<span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full font-heading font-semibold">RESELLER</span>}
        rightExtra={<Button variant="outline" size="sm" onClick={load} className="font-heading text-xs">Refresh</Button>}
      />

      <main className="flex-1 p-4 md:p-6 space-y-6 max-w-6xl w-full mx-auto">
        <div className="space-y-2">
          <h2 className="text-2xl font-heading font-bold text-foreground">Welcome, {r.display_name}</h2>
          <p className="text-sm text-muted-foreground">
            You set your own prices. On every sale, Elite Swap takes the plan's list price plus half of your markup, straight from
            your balance, and you keep the other half. Your customer's key is issued the moment you record the sale.
          </p>
          {!r.is_active && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
              Your reseller account is paused, so you can't record new sales. Contact Elite Swap.
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="glass border border-border rounded-xl p-4 text-center space-y-1">
              <s.icon className="w-5 h-5 mx-auto text-primary" strokeWidth={1.75} />
              <div className="text-xl md:text-2xl font-heading font-bold text-foreground">{s.value}</div>
              <div className="text-[11px] text-muted-foreground font-heading">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="glass border border-border rounded-xl p-4 space-y-3">
            <div className="text-sm font-heading font-semibold text-foreground">Your customer link</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <code className="flex-1 bg-muted/30 rounded-lg px-3 py-2 text-xs font-mono text-foreground/80 break-all">{link}</code>
              <Button onClick={() => copy(link, "Link")} className="font-heading">Copy link</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              New customers sign up through this page (or enter your code <span className="font-mono font-semibold text-primary">{r.code}</span> in
              their dashboard). Accounts that already buy from Elite Swap directly can't be linked.
            </p>
            <div className="flex gap-2 items-center">
              <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="How customers reach you (WhatsApp, phone, email)" className="h-9 text-sm" maxLength={120} />
              <Button variant="outline" size="sm" onClick={saveContact} disabled={contact === (r.contact ?? "")} className="font-heading shrink-0">Save</Button>
            </div>
          </div>

          <div className="glass border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-heading font-semibold text-foreground">Balance: {fmtUsd(r.balance_usd)}</div>
              <Button size="sm" onClick={() => setTopupOpen(true)} className="font-heading">Top up</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Send crypto to Elite Swap and report it here. Your balance goes up once the transfer is confirmed; sales are paid from it.
            </p>
            {data.topups.length > 0 && (
              <div className="space-y-1.5">
                {data.topups.slice(0, 4).map((t) => (
                  <div key={t.id} className="flex items-center justify-between text-xs gap-2">
                    <span className="text-muted-foreground whitespace-nowrap">{new Date(t.created_at).toLocaleDateString()}</span>
                    <span className="font-mono truncate">{t.currency} · {t.tx_hash.slice(0, 10)}…</span>
                    <span className="font-heading">{fmtUsd(t.credited_usd ?? t.amount_usd)}</span>
                    <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${
                      t.status === "approved" ? "bg-primary/20 text-primary" : t.status === "rejected" ? "bg-destructive/20 text-destructive" : "bg-amber-500/20 text-amber-400"
                    }`} title={t.review_note ?? undefined}>{t.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Prices */}
        <div className="glass border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-heading font-semibold text-foreground">Your prices</h3>
            <span className="text-[11px] text-muted-foreground font-heading">At or above list price · new prices need Elite Swap's approval</span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead className="text-right">List price</TableHead>
                  <TableHead className="text-right">Your price</TableHead>
                  <TableHead className="text-right">Elite Swap gets</TableHead>
                  <TableHead className="text-right">You keep</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.plans.flatMap((p) => (["monthly", "annual"] as Period[])
                  .filter((period) => listFor(p, period) != null)
                  .map((period) => {
                    const list = listFor(p, period)!;
                    const price = priceFor(p, period);
                    const proposed = proposedFor(p, period);
                    const split = price != null ? splitSale(list, price) : null;
                    return (
                      <TableRow key={`${p.plan_id}-${period}`}>
                        <TableCell className="text-sm font-heading">{p.name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {period === "annual" ? `Annual · ${(p.minutes * 12).toLocaleString()} min` : `Monthly · ${p.minutes} min`}
                        </TableCell>
                        <TableCell className="text-right text-xs">{fmtUsd(list)}</TableCell>
                        <TableCell className="text-right text-sm font-heading font-semibold">
                          {price != null ? fmtUsd(price) : <span className="text-muted-foreground font-normal">Not offered</span>}
                          {proposed != null && <div className="text-[11px] text-amber-400 font-normal">{fmtUsd(proposed)} awaiting approval</div>}
                        </TableCell>
                        <TableCell className="text-right text-xs">{split ? fmtUsd(split.platform) : "—"}</TableCell>
                        <TableCell className="text-right text-xs text-primary font-heading">{split ? fmtUsd(split.reseller) : "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" className="font-heading text-xs" disabled={!r.is_active}
                            onClick={() => { setEditing({ plan: p, period }); setEditPrice(String(proposed ?? price ?? list)); }}>
                            {price != null ? "Change" : "Set price"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Customers */}
        <div className="glass border border-border rounded-xl p-4 space-y-3">
          <h3 className="font-heading font-semibold text-foreground">Your customers</h3>
          {data.customers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No customers yet. Share your link to get started.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="text-right">Minutes left</TableHead>
                    <TableHead className="text-center">Purchases</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.customers.map((c) => (
                    <TableRow key={c.user_id}>
                      <TableCell className="text-xs">
                        <div className="font-mono">{c.email ?? c.user_id.slice(0, 8)}</div>
                        {c.display_name && <div className="text-muted-foreground">{c.display_name}</div>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(c.attached_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right text-xs">{minutesLeft(c.remaining_ms)}</TableCell>
                      <TableCell className="text-center text-xs">{c.purchases}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" className="font-heading text-xs" onClick={() => openSell(c)}
                          disabled={!r.is_active || sellablePlans.length === 0}
                          title={sellablePlans.length === 0 ? "Set your prices first" : undefined}>
                          Sell a plan
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Sales */}
        <div className="glass border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-heading font-semibold text-foreground">Sales</h3>
            <span className="text-[11px] text-muted-foreground font-heading">Cancel within 24 hours while the key is unused for a full refund to your balance</span>
          </div>
          {data.sales.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sales yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Your price</TableHead>
                    <TableHead className="text-right">Elite Swap</TableHead>
                    <TableHead className="text-right">You keep</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.sales.map((s) => (
                    <TableRow key={s.id} className={s.status === "voided" ? "opacity-60" : undefined}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(s.created_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{s.customer_email ?? s.customer_user_id.slice(0, 8)}</TableCell>
                      <TableCell className="text-xs">{s.plan_name}{s.billing_period === "annual" ? " (Annual)" : ""}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(s.price_usd)}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(s.platform_share_usd)}</TableCell>
                      <TableCell className="text-right text-xs font-heading text-primary">{fmtUsd(s.reseller_share_usd)}</TableCell>
                      <TableCell className="text-xs">
                        <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${s.status === "active" ? "bg-primary/20 text-primary" : "bg-muted/40 text-muted-foreground"}`}>
                          {s.status === "active" ? "active" : "cancelled"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {s.can_void && (
                          <Button variant="outline" size="sm" className="font-heading text-xs" onClick={() => { setVoiding(s); setVoidReason(""); }}>Cancel</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Ledger */}
        <div className="glass border border-border rounded-xl p-4 space-y-3">
          <h3 className="font-heading font-semibold text-foreground">Balance history</h3>
          {data.ledger.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Top up your balance to start selling.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.ledger.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(l.created_at)}</TableCell>
                      <TableCell className="text-xs">{KIND_LABEL[l.kind] ?? l.kind}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{l.note ?? "—"}</TableCell>
                      <TableCell className={`text-right text-xs font-heading ${l.amount_usd > 0 ? "text-primary" : "text-foreground"}`}>
                        {l.amount_usd > 0 ? "+" : "−"}{fmtUsd(Math.abs(l.amount_usd))}
                      </TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(l.balance_after_usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </main>

      {/* Propose price */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">{editing?.plan.name} · {editing?.period === "annual" ? "Annual" : "Monthly"}</DialogTitle>
            <DialogDescription>
              List price {fmtUsd(editing ? listFor(editing.plan, editing.period) : null)}. Your price can't be lower. Elite Swap approves new prices;
              your current price keeps applying until then.
            </DialogDescription>
          </DialogHeader>
          {editing && (() => {
            const list = listFor(editing.plan, editing.period)!;
            const price = Number(editPrice);
            const valid = Number.isFinite(price) && price >= list;
            const split = valid ? splitSale(list, price) : null;
            return (
              <div className="space-y-3">
                <Input type="number" min={list} step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} className="text-lg font-heading" />
                {split ? (
                  <p className="text-sm text-muted-foreground">
                    Per sale: Elite Swap gets <span className="text-foreground font-semibold">{fmtUsd(split.platform)}</span>, you
                    keep <span className="text-primary font-semibold">{fmtUsd(split.reseller)}</span>.
                  </p>
                ) : (
                  <p className="text-sm text-destructive">Enter a price of at least {fmtUsd(list)}.</p>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setEditing(null)} className="font-heading">Close</Button>
                  <Button onClick={proposePrice} disabled={!valid} className="font-heading">Send for approval</Button>
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Top up */}
      <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Top up your balance</DialogTitle>
            <DialogDescription>Send crypto to the address below, then report the transfer. Elite Swap confirms it and credits your balance.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {WALLETS.map((w) => (
                <button key={w.currencyCode} type="button" onClick={() => setTopupCurrency(w.currencyCode)}
                  className={`rounded-lg border px-3 py-2 text-xs font-heading text-left ${topupCurrency === w.currencyCode ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                  {w.name}
                </button>
              ))}
            </div>
            <div className="rounded-lg bg-muted/30 p-3 space-y-1">
              <div className="text-[11px] text-muted-foreground font-heading uppercase tracking-wider">{wallet.network}</div>
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono break-all flex-1">{wallet.address}</code>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => copy(wallet.address, "Address")}><Copy className="w-4 h-4" /></Button>
              </div>
              <p className="text-[11px] text-amber-400">{wallet.warning}</p>
            </div>
            <Input type="number" min="1" step="0.01" placeholder="Amount sent, in USD" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} />
            <Input placeholder="Transaction hash" value={topupHash} onChange={(e) => setTopupHash(e.target.value)} className="font-mono text-xs" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setTopupOpen(false)} className="font-heading">Close</Button>
              <Button onClick={submitTopup} disabled={topupBusy || !(Number(topupAmount) > 0) || topupHash.trim().length < 10} className="font-heading">
                {topupBusy ? "Submitting…" : "Report transfer"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Sell */}
      <Dialog open={!!sellFor} onOpenChange={(o) => !o && setSellFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Sell a plan</DialogTitle>
            <DialogDescription>To {sellFor?.email ?? "your customer"}. Collect your payment from them first; their key is issued as soon as you confirm.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <select value={sellPlanId} onChange={(e) => {
              const p = sellablePlans.find((x) => x.plan_id === e.target.value);
              setSellPlanId(e.target.value);
              if (p && priceFor(p, sellPeriod) == null) setSellPeriod(sellPeriod === "monthly" ? "annual" : "monthly");
            }} className="w-full h-10 px-3 rounded-md bg-background border border-border text-sm">
              {sellablePlans.map((p) => <option key={p.plan_id} value={p.plan_id}>{p.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              {(["monthly", "annual"] as Period[]).map((period) => {
                const available = !!sellPlan && priceFor(sellPlan, period) != null;
                return (
                  <button key={period} type="button" disabled={!available} onClick={() => setSellPeriod(period)}
                    className={`rounded-lg border px-3 py-2 text-xs font-heading ${sellPeriod === period ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"} disabled:opacity-40`}>
                    {period === "annual" ? `Annual · ${((sellPlan?.minutes ?? 0) * 12).toLocaleString()} min` : `Monthly · ${sellPlan?.minutes ?? 0} min`}
                  </button>
                );
              })}
            </div>
            {sellSplit && sellPrice != null && (
              <div className="rounded-lg bg-muted/30 p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Your customer pays you</span><span className="font-heading font-semibold">{fmtUsd(sellPrice)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Elite Swap's share (from your balance)</span><span>{fmtUsd(sellSplit.platform)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">You keep</span><span className="text-primary font-heading font-semibold">{fmtUsd(sellSplit.reseller)}</span></div>
                <div className="flex justify-between border-t border-border pt-1 mt-1">
                  <span className="text-muted-foreground">Balance after</span>
                  <span className={balance < sellSplit.platform ? "text-destructive font-semibold" : ""}>{fmtUsd(balance - sellSplit.platform)}</span>
                </div>
                {balance < sellSplit.platform && <p className="text-xs text-destructive">Not enough balance. Top up first.</p>}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSellFor(null)} className="font-heading">Close</Button>
              <Button onClick={recordSale} disabled={sellBusy || !sellSplit || balance < (sellSplit?.platform ?? Infinity)} className="font-heading">
                {sellBusy ? "Recording…" : "Confirm sale"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Void */}
      <Dialog open={!!voiding} onOpenChange={(o) => !o && setVoiding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">Cancel this sale?</DialogTitle>
            <DialogDescription>
              {voiding?.plan_name} for {voiding?.customer_email ?? "your customer"}. Their key is switched off and{" "}
              {fmtUsd(voiding?.platform_share_usd)} goes back to your balance. Refund your customer yourself.
            </DialogDescription>
          </DialogHeader>
          <Input placeholder="Reason (optional)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={300} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(null)} className="font-heading">Keep sale</Button>
            <Button variant="destructive" onClick={voidSale} className="font-heading">Cancel sale</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
