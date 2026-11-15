import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtUsd, fromTable, resellerLink, rpc, rpcErrorMessage, splitSale } from "@/lib/reseller";

interface Profile { user_id: string; email: string | null; display_name: string | null }
interface Props { profiles: Profile[] }

type Period = "monthly" | "annual";
interface ResellerRow {
  id: string; user_id: string; code: string; display_name: string; contact: string | null;
  balance_usd: number; is_active: boolean; created_at: string;
}
interface PriceRow {
  reseller_id: string; plan_id: string; billing_period: Period;
  price_usd: number | null; proposed_price_usd: number | null; proposed_at: string | null;
}
interface TopupRow {
  id: string; reseller_id: string; amount_usd: number; currency: string; tx_hash: string;
  status: "pending" | "approved" | "rejected"; credited_usd: number | null; review_note: string | null; created_at: string;
}
interface SaleRow {
  id: string; reseller_id: string; customer_user_id: string; plan_name: string; billing_period: Period;
  list_price_usd: number; reseller_price_usd: number; platform_share_usd: number; reseller_share_usd: number;
  status: "active" | "voided"; created_at: string;
}
interface CustomerRow { user_id: string; reseller_id: string; source: string; attached_at: string }
interface PlanRow { id: string; name: string; price_usd: number; price_usd_annual: number | null; key_duration_minutes: number | null; sort_order: number }

const explorerUrl = (currency: string, hash: string) =>
  currency === "BTC" ? `https://mempool.space/tx/${hash}`
    : currency === "USDT-TRC20" ? `https://tronscan.org/#/transaction/${hash}`
    : `https://bscscan.com/tx/${hash}`;

export default function ResellerManager({ profiles }: Props) {
  const { toast } = useToast();
  const [resellers, setResellers] = useState<ResellerRow[]>([]);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [topups, setTopups] = useState<TopupRow[]>([]);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [partnerUserIds, setPartnerUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const emailById = useMemo(() => new Map(profiles.map((p) => [p.user_id, p.email])), [profiles]);
  const emailFor = (uid: string) => emailById.get(uid) ?? uid.slice(0, 8);

  const load = useCallback(async () => {
    const [r, p, t, s, c, pl, pa] = await Promise.all([
      fromTable("resellers").select("*").order("created_at", { ascending: false }),
      fromTable("reseller_prices").select("*"),
      fromTable("reseller_topups").select("*").order("created_at", { ascending: false }).limit(300),
      fromTable("reseller_sales").select("*").order("created_at", { ascending: false }).limit(1000),
      fromTable("reseller_customers").select("*"),
      supabase.from("pricing_plans").select("id, name, price_usd, price_usd_annual, key_duration_minutes, sort_order").eq("is_active", true).gt("price_usd", 0).order("sort_order"),
      supabase.from("partners").select("user_id"),
    ]);
    const err = [r, p, t, s, c, pl].find((x) => x.error)?.error;
    if (err) toast({ title: "Couldn't load resellers", description: err.message, variant: "destructive" });
    setResellers((r.data as unknown as ResellerRow[]) ?? []);
    setPrices((p.data as unknown as PriceRow[]) ?? []);
    setTopups((t.data as unknown as TopupRow[]) ?? []);
    setSales((s.data as unknown as SaleRow[]) ?? []);
    setCustomers((c.data as unknown as CustomerRow[]) ?? []);
    setPlans(((pl.data as unknown as PlanRow[]) ?? []).filter((x) => (x.key_duration_minutes ?? 0) > 0));
    setPartnerUserIds(new Set(((pa.data as { user_id: string }[] | null) ?? []).map((x) => x.user_id)));
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const call = async (fn: string, args: Record<string, unknown>, ok: string) => {
    const { error } = await rpc(fn, args);
    if (error) { toast({ title: "Not done", description: rpcErrorMessage(error), variant: "destructive" }); return false; }
    toast({ title: ok });
    await load();
    return true;
  };

  // ------------------------------------------------------------ create
  const [newSearch, setNewSearch] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newContact, setNewContact] = useState("");
  const matches = newSearch.trim().length >= 3
    ? profiles.filter((p) => (p.email ?? "").toLowerCase().includes(newSearch.trim().toLowerCase())).slice(0, 8)
    : [];
  const create = async () => {
    const done = await call("admin_create_reseller", {
      p_user_id: newUserId, p_code: newCode, p_display_name: newName, p_contact: newContact || null,
    }, "Reseller created");
    if (done) { setNewSearch(""); setNewUserId(""); setNewCode(""); setNewName(""); setNewContact(""); }
  };

  const pendingTopups = topups.filter((t) => t.status === "pending");
  const pendingPrices = prices.filter((p) => p.proposed_price_usd != null);
  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? "Plan";
  const listFor = (planId: string, period: Period) => {
    const p = plans.find((x) => x.id === planId);
    return p ? (period === "annual" ? p.price_usd_annual : p.price_usd) : null;
  };

  // ------------------------------------------------------------ top-up review
  const [credit, setCredit] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});

  if (loading) return <div className="text-sm text-muted-foreground p-4">Loading resellers…</div>;

  return (
    <div className="space-y-6">
      <div className="glass border border-border rounded-xl p-4 space-y-1">
        <h3 className="font-heading font-semibold text-foreground">Resellers</h3>
        <p className="text-xs text-muted-foreground">
          Resellers sell plans at their own prices. Each sale pays Elite Swap the list price plus half the markup, straight from
          their prepaid balance, and is recorded as a confirmed payment (method "reseller"). Their customers can't buy plans from
          you directly while the reseller is active; the $10 trial stays direct. No partner commission is paid on reseller sales.
        </p>
      </div>

      {(pendingTopups.length > 0 || pendingPrices.length > 0) && (
        <div className="glass border border-amber-500/40 rounded-xl p-4 space-y-4">
          <h3 className="font-heading font-semibold text-amber-300">Waiting for you</h3>

          {pendingTopups.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-heading text-foreground">Top-ups to check ({pendingTopups.length})</div>
              <p className="text-xs text-muted-foreground">Check the transfer on the explorer, then credit what actually arrived (in USD).</p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reseller</TableHead><TableHead>Sent</TableHead><TableHead>Transaction</TableHead>
                      <TableHead>Credit (USD)</TableHead><TableHead>Note</TableHead><TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingTopups.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="text-xs">{resellers.find((r) => r.id === t.reseller_id)?.display_name ?? "?"}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{fmtUsd(t.amount_usd)} in {t.currency}<div className="text-muted-foreground">{new Date(t.created_at).toLocaleString()}</div></TableCell>
                        <TableCell className="text-xs font-mono"><a href={explorerUrl(t.currency, t.tx_hash)} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t.tx_hash.slice(0, 14)}…</a></TableCell>
                        <TableCell><Input className="h-8 w-28 text-xs" type="number" step="0.01" placeholder={String(t.amount_usd)} value={credit[t.id] ?? ""} onChange={(e) => setCredit({ ...credit, [t.id]: e.target.value })} /></TableCell>
                        <TableCell><Input className="h-8 w-44 text-xs" placeholder="Optional (shown to them)" value={note[t.id] ?? ""} onChange={(e) => setNote({ ...note, [t.id]: e.target.value })} /></TableCell>
                        <TableCell className="text-right whitespace-nowrap space-x-1">
                          <Button size="sm" className="text-xs font-heading" onClick={() => call("admin_review_reseller_topup", { p_topup_id: t.id, p_approve: true, p_credit_usd: credit[t.id] ? Number(credit[t.id]) : null, p_note: note[t.id] || null }, "Top-up credited")}>Credit</Button>
                          <Button size="sm" variant="outline" className="text-xs font-heading" onClick={() => call("admin_review_reseller_topup", { p_topup_id: t.id, p_approve: false, p_credit_usd: null, p_note: note[t.id] || null }, "Top-up rejected")}>Reject</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {pendingPrices.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-heading text-foreground">Prices to approve ({pendingPrices.length})</div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reseller</TableHead><TableHead>Plan</TableHead><TableHead className="text-right">List</TableHead>
                      <TableHead className="text-right">Current</TableHead><TableHead className="text-right">Proposed</TableHead>
                      <TableHead className="text-right">You'd get</TableHead><TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingPrices.map((p) => {
                      const list = listFor(p.plan_id, p.billing_period);
                      const split = list != null && p.proposed_price_usd != null ? splitSale(list, p.proposed_price_usd) : null;
                      return (
                        <TableRow key={`${p.reseller_id}-${p.plan_id}-${p.billing_period}`}>
                          <TableCell className="text-xs">{resellers.find((r) => r.id === p.reseller_id)?.display_name ?? "?"}</TableCell>
                          <TableCell className="text-xs">{planName(p.plan_id)} · {p.billing_period}</TableCell>
                          <TableCell className="text-right text-xs">{fmtUsd(list)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtUsd(p.price_usd)}</TableCell>
                          <TableCell className="text-right text-xs font-heading font-semibold">{fmtUsd(p.proposed_price_usd)}</TableCell>
                          <TableCell className="text-right text-xs">{split ? fmtUsd(split.platform) : "—"}</TableCell>
                          <TableCell className="text-right whitespace-nowrap space-x-1">
                            <Button size="sm" className="text-xs font-heading" onClick={() => call("admin_review_reseller_price", { p_reseller_id: p.reseller_id, p_plan_id: p.plan_id, p_billing_period: p.billing_period, p_approve: true }, "Price approved")}>Approve</Button>
                            <Button size="sm" variant="outline" className="text-xs font-heading" onClick={() => call("admin_review_reseller_price", { p_reseller_id: p.reseller_id, p_plan_id: p.plan_id, p_billing_period: p.billing_period, p_approve: false }, "Price rejected")}>Reject</Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* list */}
      <div className="glass border border-border rounded-xl p-4 space-y-3">
        <h3 className="font-heading font-semibold text-foreground">All resellers</h3>
        {resellers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No resellers yet. Add one below.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reseller</TableHead><TableHead>Code</TableHead><TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-center">Customers</TableHead><TableHead className="text-center">Sales</TableHead>
                  <TableHead className="text-right">You earned</TableHead><TableHead className="text-right">They earned</TableHead>
                  <TableHead>Status</TableHead><TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {resellers.map((r) => {
                  const rs = sales.filter((s) => s.reseller_id === r.id && s.status === "active");
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs"><div className="font-heading font-semibold text-sm">{r.display_name}</div><div className="text-muted-foreground font-mono">{emailFor(r.user_id)}</div></TableCell>
                      <TableCell className="text-xs font-mono">{r.code}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(r.balance_usd)}</TableCell>
                      <TableCell className="text-center text-xs">{customers.filter((c) => c.reseller_id === r.id).length}</TableCell>
                      <TableCell className="text-center text-xs">{rs.length}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(rs.reduce((a, s) => a + Number(s.platform_share_usd), 0))}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(rs.reduce((a, s) => a + Number(s.reseller_share_usd), 0))}</TableCell>
                      <TableCell className="text-xs">
                        <span className={`font-heading font-semibold px-2 py-0.5 rounded-full ${r.is_active ? "bg-primary/20 text-primary" : "bg-muted/40 text-muted-foreground"}`}>{r.is_active ? "active" : "paused"}</span>
                      </TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="outline" className="text-xs font-heading" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{openId === r.id ? "Close" : "Manage"}</Button></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {openId && (() => {
        const r = resellers.find((x) => x.id === openId);
        return r ? (
          <ResellerDetail
            key={r.id}
            reseller={r}
            plans={plans}
            prices={prices.filter((p) => p.reseller_id === r.id)}
            customers={customers.filter((c) => c.reseller_id === r.id)}
            sales={sales.filter((s) => s.reseller_id === r.id)}
            profiles={profiles}
            emailFor={emailFor}
            call={call}
          />
        ) : null;
      })()}

      {/* create */}
      <div className="glass border border-border rounded-xl p-4 space-y-3">
        <h3 className="font-heading font-semibold text-foreground">Add a reseller</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Input placeholder="Find the account by email" value={newSearch} onChange={(e) => { setNewSearch(e.target.value); setNewUserId(""); }} className="h-9 text-sm" />
            {matches.length > 0 && !newUserId && (
              <div className="border border-border rounded-md divide-y divide-border">
                {matches.map((m) => (
                  <button key={m.user_id} type="button" onClick={() => { setNewUserId(m.user_id); setNewSearch(m.email ?? ""); if (!newName && m.display_name) setNewName(m.display_name); }}
                    className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted/30">
                    {m.email} {m.display_name ? <span className="text-muted-foreground">· {m.display_name}</span> : null}
                  </button>
                ))}
              </div>
            )}
            {newUserId && partnerUserIds.has(newUserId) && (
              <p className="text-xs text-amber-400">This account is also a partner. Deactivate the partner account if they should only resell.</p>
            )}
          </div>
          <Input placeholder="Code (3–20 letters/numbers), e.g. LINOVIVA" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} className="h-9 text-sm font-mono" maxLength={20} />
          <Input placeholder="Name customers see" value={newName} onChange={(e) => setNewName(e.target.value)} className="h-9 text-sm" maxLength={60} />
          <Input placeholder="Contact for customers (optional)" value={newContact} onChange={(e) => setNewContact(e.target.value)} className="h-9 text-sm" maxLength={120} />
        </div>
        <Button onClick={create} disabled={!newUserId || newCode.length < 3 || newName.trim().length < 2} className="font-heading">Create reseller</Button>
      </div>
    </div>
  );
}

function ResellerDetail({
  reseller: r, plans, prices, customers, sales, profiles, emailFor, call,
}: {
  reseller: ResellerRow; plans: PlanRow[]; prices: PriceRow[]; customers: CustomerRow[]; sales: SaleRow[];
  profiles: Profile[]; emailFor: (uid: string) => string;
  call: (fn: string, args: Record<string, unknown>, ok: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(r.display_name);
  const [contact, setContact] = useState(r.contact ?? "");
  const [priceInput, setPriceInput] = useState<Record<string, string>>({});
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [custSearch, setCustSearch] = useState("");
  const custMatches = custSearch.trim().length >= 3
    ? profiles.filter((p) => (p.email ?? "").toLowerCase().includes(custSearch.trim().toLowerCase())).slice(0, 6)
    : [];

  return (
    <div className="glass border border-primary/40 rounded-xl p-4 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-heading font-semibold text-foreground">{r.display_name} <span className="text-xs text-muted-foreground font-mono">{resellerLink(r.code)}</span></h3>
        <Button size="sm" variant={r.is_active ? "outline" : "default"} className="text-xs font-heading"
          onClick={() => call("admin_update_reseller", { p_reseller_id: r.id, p_display_name: r.display_name, p_contact: r.contact, p_is_active: !r.is_active }, r.is_active ? "Reseller paused" : "Reseller activated")}>
          {r.is_active ? "Pause reseller" : "Activate reseller"}
        </Button>
      </div>
      {!r.is_active && <p className="text-xs text-amber-400">Paused: no new sales, and their customers can buy from you directly again.</p>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-center">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" maxLength={60} />
        <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Contact" className="h-9 text-sm" maxLength={120} />
        <Button size="sm" variant="outline" className="text-xs font-heading" onClick={() => call("admin_update_reseller", { p_reseller_id: r.id, p_display_name: name, p_contact: contact || null, p_is_active: r.is_active }, "Saved")}>Save name & contact</Button>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-heading text-foreground">Prices</div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead><TableHead className="text-right">List</TableHead><TableHead className="text-right">Approved</TableHead>
                <TableHead className="text-right">Proposed</TableHead><TableHead>Set approved price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.flatMap((p) => (["monthly", "annual"] as Period[])
                .filter((period) => (period === "annual" ? p.price_usd_annual : p.price_usd) != null)
                .map((period) => {
                  const k = `${p.id}-${period}`;
                  const row = prices.find((x) => x.plan_id === p.id && x.billing_period === period);
                  const list = period === "annual" ? p.price_usd_annual : p.price_usd;
                  return (
                    <TableRow key={k}>
                      <TableCell className="text-xs">{p.name} · {period}</TableCell>
                      <TableCell className="text-right text-xs">{fmtUsd(list)}</TableCell>
                      <TableCell className="text-right text-xs font-heading">{fmtUsd(row?.price_usd)}</TableCell>
                      <TableCell className="text-right text-xs text-amber-400">{row?.proposed_price_usd != null ? fmtUsd(row.proposed_price_usd) : "—"}</TableCell>
                      <TableCell className="whitespace-nowrap space-x-1">
                        <Input className="h-8 w-24 text-xs inline-flex" type="number" step="0.01" placeholder={String(list)} value={priceInput[k] ?? ""} onChange={(e) => setPriceInput({ ...priceInput, [k]: e.target.value })} />
                        <Button size="sm" variant="outline" className="text-xs font-heading" disabled={!priceInput[k]}
                          onClick={() => call("admin_set_reseller_price", { p_reseller_id: r.id, p_plan_id: p.id, p_billing_period: period, p_price_usd: Number(priceInput[k]) }, "Price set")}>Set</Button>
                        {row?.price_usd != null && (
                          <Button size="sm" variant="ghost" className="text-xs font-heading"
                            onClick={() => call("admin_set_reseller_price", { p_reseller_id: r.id, p_plan_id: p.id, p_billing_period: period, p_price_usd: null }, "Price removed")}>Remove</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                }))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-heading text-foreground">Balance: {fmtUsd(r.balance_usd)}</div>
        <div className="flex flex-col md:flex-row gap-2">
          <Input className="h-9 text-sm md:w-40" type="number" step="0.01" placeholder="+50 or -20" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
          <Input className="h-9 text-sm flex-1" placeholder="Reason (required, shown in their history)" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
          <Button size="sm" variant="outline" className="font-heading text-xs" disabled={!Number(adjAmount) || adjNote.trim().length < 3}
            onClick={async () => { if (await call("admin_adjust_reseller_balance", { p_reseller_id: r.id, p_amount_usd: Number(adjAmount), p_note: adjNote }, "Balance adjusted")) { setAdjAmount(""); setAdjNote(""); } }}>
            Adjust balance
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-heading text-foreground">Customers ({customers.length})</div>
        <div className="space-y-1">
          {customers.map((c) => (
            <div key={c.user_id} className="flex items-center justify-between text-xs gap-2">
              <span className="font-mono">{emailFor(c.user_id)}</span>
              <span className="text-muted-foreground">{c.source} · {new Date(c.attached_at).toLocaleDateString()}</span>
              <Button size="sm" variant="ghost" className="text-xs font-heading" onClick={() => call("admin_set_reseller_customer", { p_user_id: c.user_id, p_reseller_id: null }, "Customer unlinked; they can buy directly again")}>Unlink</Button>
            </div>
          ))}
        </div>
        <Input placeholder="Link a customer by email" value={custSearch} onChange={(e) => setCustSearch(e.target.value)} className="h-9 text-sm" />
        {custMatches.length > 0 && (
          <div className="border border-border rounded-md divide-y divide-border">
            {custMatches.map((m) => (
              <button key={m.user_id} type="button" className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted/30"
                onClick={async () => { if (await call("admin_set_reseller_customer", { p_user_id: m.user_id, p_reseller_id: r.id }, "Customer linked")) setCustSearch(""); }}>
                Link {m.email}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-sm font-heading text-foreground">Sales ({sales.length})</div>
        {sales.length === 0 ? <p className="text-xs text-muted-foreground">No sales yet.</p> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead><TableHead>Customer</TableHead><TableHead>Plan</TableHead>
                  <TableHead className="text-right">Their price</TableHead><TableHead className="text-right">List</TableHead>
                  <TableHead className="text-right">You</TableHead><TableHead className="text-right">They</TableHead><TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sales.slice(0, 100).map((s) => (
                  <TableRow key={s.id} className={s.status === "voided" ? "opacity-60" : undefined}>
                    <TableCell className="text-xs whitespace-nowrap">{new Date(s.created_at).toLocaleString()}</TableCell>
                    <TableCell className="text-xs font-mono">{emailFor(s.customer_user_id)}</TableCell>
                    <TableCell className="text-xs">{s.plan_name}{s.billing_period === "annual" ? " (Annual)" : ""}</TableCell>
                    <TableCell className="text-right text-xs">{fmtUsd(s.reseller_price_usd)}</TableCell>
                    <TableCell className="text-right text-xs">{fmtUsd(s.list_price_usd)}</TableCell>
                    <TableCell className="text-right text-xs font-heading">{fmtUsd(s.platform_share_usd)}</TableCell>
                    <TableCell className="text-right text-xs">{fmtUsd(s.reseller_share_usd)}</TableCell>
                    <TableCell className="text-xs">{s.status === "active" ? "active" : "cancelled"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
