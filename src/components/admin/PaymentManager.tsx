import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import PaymentActionDialog from "./PaymentActionDialog";

interface Payment {
  id: string;
  user_id: string;
  currency: string;
  amount_usd: number | null;
  tx_hash: string | null;
  payment_method?: string;
  status: string;
  created_at: string;
  updated_at?: string;
}

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

interface PaymentManagerProps {
  payments: Payment[];
  profiles: Profile[];
  onRefresh?: () => void;
}

export default function PaymentManager({ payments, profiles, onRefresh }: PaymentManagerProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "pending_review" | "confirmed" | "rejected">("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAction, setDialogAction] = useState<"confirmed" | "rejected" | null>(null);
  const [dialogPayment, setDialogPayment] = useState<Payment | null>(null);

  const openDialog = (p: Payment, action: "confirmed" | "rejected") => {
    setDialogPayment(p);
    setDialogAction(action);
    setDialogOpen(true);
  };

  const profileFor = (uid: string) => profiles.find((p) => p.user_id === uid) ?? null;

  const emailForUser = (userId: string) =>
    profiles.find((p) => p.user_id === userId)?.email ?? userId.slice(0, 8);

  const displayNameForUser = (userId: string) =>
    profiles.find((p) => p.user_id === userId)?.display_name ?? "—";

  const filtered = filter === "all" ? payments : payments.filter((p) => p.status === filter);

  const statusBadge = (status: string) => {
    const cls =
      status === "confirmed"
        ? "bg-primary/20 text-primary border-primary/30"
        : status === "rejected"
        ? "bg-destructive/20 text-destructive border-destructive/30"
        : status === "pending_review"
        ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
        : "bg-amber-500/20 text-amber-400 border-amber-500/30";
    return <Badge variant="outline" className={`font-heading font-semibold text-xs ${cls}`}>{status.replace("_", " ")}</Badge>;
  };

  // Mirrors the verifier's isOffchainRef() heuristic so admin can spot Binance
  // internal transfers at a glance and one-click into Binance Deposit History.
  const isOffchainRef = (currency: string, raw: string | null): boolean => {
    const h = (raw ?? "").trim();
    if (!h) return false;
    if (/off[\s-]?chain|binance|internal|withdrawal/i.test(h)) return true;
    const core = h.replace(/^0x/i, "");
    const isHex64 = /^[0-9a-fA-F]{64}$/.test(core);
    if (isHex64) return false;
    if ((currency === "BNB" || currency === "USDT-BEP20") && !/^0x[0-9a-fA-F]{64}$/.test(h)) return true;
    if ((currency === "BTC" || currency === "USDT-TRC20") && !isHex64) return true;
    return false;
  };

  const binanceDepositUrl = (hash: string) =>
    `https://www.binance.com/en/my/wallet/history/deposit-crypto?search=${encodeURIComponent(hash)}`;

  const totalUsd = payments
    .filter((p) => p.status === "confirmed" && p.amount_usd)
    .reduce((sum, p) => sum + (p.amount_usd ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold text-foreground">Manage Payments</h2>
        <div className="text-xs text-muted-foreground font-heading">
          Total confirmed: <span className="text-primary font-semibold">${totalUsd.toFixed(2)}</span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(["all", "pending", "pending_review", "confirmed", "rejected"] as const).map((f) => {
          const count = f === "all" ? payments.length : payments.filter((p) => p.status === f).length;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`glass rounded-xl p-3 text-center transition-all ${
                filter === f ? "neon-border ring-1 ring-primary/30" : "hover:bg-muted/30"
              }`}
            >
              <div className="text-xl font-heading font-bold text-foreground">{count}</div>
              <div className="text-xs text-muted-foreground font-heading capitalize">{f.replace("_", " ")}</div>
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="glass rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border">
              <TableHead className="font-heading text-xs">User</TableHead>
              <TableHead className="font-heading text-xs">Currency</TableHead>
              <TableHead className="font-heading text-xs">Amount (USD)</TableHead>
              <TableHead className="font-heading text-xs">TX Hash</TableHead>
              <TableHead className="font-heading text-xs">Status</TableHead>
              <TableHead className="font-heading text-xs">Created</TableHead>
              <TableHead className="font-heading text-xs">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((p) => (
              <>
                <TableRow
                  key={p.id}
                  className="border-border cursor-pointer hover:bg-muted/30"
                  onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                >
                  <TableCell className="text-xs">
                    <div className="font-heading">{emailForUser(p.user_id)}</div>
                  </TableCell>
                  <TableCell className="font-heading font-semibold text-xs">{p.currency}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {p.amount_usd != null ? `$${p.amount_usd.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs max-w-[140px] truncate">
                    {p.tx_hash ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 items-start">
                      {statusBadge(p.status)}
                      {p.payment_method === "crypto" && isOffchainRef(p.currency, p.tx_hash) && (
                        <Badge
                          variant="outline"
                          className="font-heading font-semibold text-[10px] bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                        >
                          Binance off-chain
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(p.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {(p.status === "pending" || p.status === "pending_review") && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); openDialog(p, "confirmed"); }}
                          className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading text-xs h-7 px-2"
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => { e.stopPropagation(); openDialog(p, "rejected"); }}
                          className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs h-7 px-2"
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>

                {/* Expanded detail row */}
                {expandedId === p.id && (
                  <TableRow key={`${p.id}-detail`} className="border-border bg-muted/10">
                    <TableCell colSpan={7}>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 py-2 text-xs">
                        <div>
                          <span className="text-muted-foreground font-heading block">Payment ID</span>
                          <span className="font-mono text-foreground break-all">{p.id}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">User ID</span>
                          <span className="font-mono text-foreground break-all">{p.user_id}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Display Name</span>
                          <span className="text-foreground">{displayNameForUser(p.user_id)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Email</span>
                          <span className="text-foreground">{emailForUser(p.user_id)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Currency</span>
                          <span className="text-foreground font-semibold">{p.currency}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Amount (USD)</span>
                          <span className="text-foreground font-semibold">
                            {p.amount_usd != null ? `$${p.amount_usd.toFixed(2)}` : "Not set"}
                          </span>
                        </div>
                        <div className="col-span-2 md:col-span-3">
                          <span className="text-muted-foreground font-heading block">Transaction Hash</span>
                          <span className="font-mono text-foreground break-all">{p.tx_hash ?? "Not provided"}</span>
                          {p.payment_method === "crypto" && p.tx_hash && isOffchainRef(p.currency, p.tx_hash) && (
                            <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-2 space-y-1">
                              <p className="text-[11px] text-yellow-400 font-heading">
                                Likely a Binance internal transfer — verify on the merchant Binance account.
                              </p>
                              <a
                                href={binanceDepositUrl(p.tx_hash)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-block text-[11px] font-heading font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
                              >
                                Open in Binance → Deposit History ↗
                              </a>
                            </div>
                          )}
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Status</span>
                          {statusBadge(p.status)}
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Created At</span>
                          <span className="text-foreground">{new Date(p.created_at).toLocaleString()}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground font-heading block">Last Updated</span>
                          <span className="text-foreground">
                            {(p as any).updated_at ? new Date((p as any).updated_at).toLocaleString() : "—"}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                  No payments found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <PaymentActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        action={dialogAction}
        payment={dialogPayment}
        profile={dialogPayment ? profileFor(dialogPayment.user_id) : null}
        onComplete={() => onRefresh?.()}
      />
    </div>
  );
}
