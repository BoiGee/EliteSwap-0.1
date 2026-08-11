import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RefreshCw, X, Eye } from "lucide-react";

interface Broadcast {
  id: string;
  subject: string;
  body_md: string;
  cta_label: string | null;
  cta_url: string | null;
  recipient_mode: string;
  filter_preset: string | null;
  status: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_matched: number;
  suppressed_count: number;
  enqueued_count: number;
  failed_count: number;
  error_message: string | null;
  created_at: string;
  created_by: string;
}

interface RecipientRow {
  id: string;
  email: string;
  display_name: string | null;
  suppressed: boolean;
  send_status: string;
  error_message: string | null;
}

const statusBadge = (status: string) => {
  const map: Record<string, string> = {
    draft: "bg-muted/40 text-muted-foreground",
    scheduled: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    sending: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    sent: "bg-primary/20 text-primary border-primary/30",
    failed: "bg-destructive/20 text-destructive border-destructive/30",
    canceled: "bg-muted/40 text-muted-foreground",
  };
  return map[status] ?? "bg-muted/40 text-muted-foreground";
};

export default function BroadcastHistory() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("broadcasts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      toast({ title: "Failed to load history", description: error.message, variant: "destructive" });
    } else {
      setRows((data ?? []) as Broadcast[]);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const openRequestId = useRef<string | null>(null);

  const openDetail = async (id: string) => {
    openRequestId.current = id;
    setOpenId(id);
    setRecipients([]);
    setRecipientsLoading(true);
    const { data, error } = await supabase
      .from("broadcast_recipients")
      .select("id, email, display_name, suppressed, send_status, error_message")
      .eq("broadcast_id", id)
      .order("send_status");
    // Guard against a slower earlier request landing after a newer one —
    // e.g. clicking two different rows in quick succession — which would
    // otherwise overwrite the currently-open broadcast's list with a
    // stale one for whichever row was clicked first.
    if (openRequestId.current === id) {
      if (!error) setRecipients((data ?? []) as RecipientRow[]);
      setRecipientsLoading(false);
    }
  };

  const cancelScheduled = async (id: string) => {
    const { error } = await supabase.functions.invoke("admin-broadcast-email", {
      body: { action: "cancel", broadcastId: id },
    });
    if (error) {
      toast({ title: "Cancel failed", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Scheduled broadcast canceled" });
      fetchRows();
    }
  };

  const detail = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-heading font-bold text-foreground">Broadcast history</h3>
          <p className="text-xs text-muted-foreground">Audit every blast — counts, status, and per-recipient outcomes.</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchRows} disabled={loading} className="font-heading text-xs">
          <RefreshCw className={`w-3 h-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="glass rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground font-heading">
              <tr>
                <th className="text-left px-3 py-2">Subject</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-right px-3 py-2">Matched</th>
                <th className="text-right px-3 py-2">Sent</th>
                <th className="text-right px-3 py-2">Suppressed</th>
                <th className="text-right px-3 py-2">Failed</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && !loading && (
                <tr><td colSpan={8} className="text-center py-6 text-muted-foreground">No broadcasts yet.</td></tr>
              )}
              {rows.map((r) => {
                const when = r.scheduled_for
                  ? `Scheduled · ${new Date(r.scheduled_for).toLocaleString()}`
                  : r.completed_at
                  ? new Date(r.completed_at).toLocaleString()
                  : new Date(r.created_at).toLocaleString();
                return (
                  <tr key={r.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 max-w-[260px] truncate font-heading text-foreground">{r.subject}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={`${statusBadge(r.status)} text-[10px] capitalize`}>{r.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{when}</td>
                    <td className="px-3 py-2 text-right">{r.total_matched}</td>
                    <td className="px-3 py-2 text-right text-primary">{r.enqueued_count}</td>
                    <td className="px-3 py-2 text-right text-amber-400">{r.suppressed_count}</td>
                    <td className="px-3 py-2 text-right text-destructive">{r.failed_count}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openDetail(r.id)} className="h-7 px-2 text-xs">
                          <Eye className="w-3 h-3" />
                        </Button>
                        {r.status === "scheduled" && (
                          <Button size="sm" variant="ghost" onClick={() => cancelScheduled(r.id)}
                            className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10">
                            <X className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Sheet open={!!openId} onOpenChange={(v) => { if (!v) { setOpenId(null); setRecipients([]); } }}>
        <SheetContent className="w-full sm:max-w-2xl overflow-hidden flex flex-col">
          <SheetHeader>
            <SheetTitle className="font-heading">{detail?.subject ?? "Broadcast"}</SheetTitle>
            <SheetDescription>
              {detail && (
                <span className="space-x-2 text-xs">
                  <Badge variant="outline" className={`${statusBadge(detail.status)} capitalize`}>{detail.status}</Badge>
                  <span className="text-muted-foreground">
                    Mode: <strong className="text-foreground">{detail.recipient_mode}</strong>
                    {detail.filter_preset && <> · Filter: <strong className="text-foreground">{detail.filter_preset}</strong></>}
                  </span>
                </span>
              )}
            </SheetDescription>
          </SheetHeader>

          {detail && (
            <ScrollArea className="flex-1 mt-4 pr-4">
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-4 gap-2">
                  <Stat label="Matched" value={detail.total_matched} />
                  <Stat label="Sent" value={detail.enqueued_count} accent="text-primary" />
                  <Stat label="Suppressed" value={detail.suppressed_count} accent="text-amber-400" />
                  <Stat label="Failed" value={detail.failed_count} accent="text-destructive" />
                </div>

                {detail.error_message && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                    {detail.error_message}
                  </div>
                )}

                <div>
                  <div className="font-heading text-muted-foreground mb-1">Body (markdown)</div>
                  <pre className="rounded-lg bg-muted/30 p-3 whitespace-pre-wrap font-mono text-[11px] text-foreground/90 max-h-48 overflow-auto">
                    {detail.body_md}
                  </pre>
                </div>

                <div>
                  <div className="font-heading text-muted-foreground mb-1">Recipients ({recipients.length})</div>
                  {recipientsLoading ? (
                    <div className="text-muted-foreground text-center py-4">Loading...</div>
                  ) : (
                    <div className="rounded-lg border border-border divide-y divide-border max-h-72 overflow-auto">
                      {recipients.length === 0 && (
                        <div className="p-3 text-center text-muted-foreground">No recipients recorded.</div>
                      )}
                      {recipients.map((r) => (
                        <div key={r.id} className="px-3 py-2 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-heading text-foreground truncate">{r.email}</div>
                            {r.error_message && (
                              <div className="text-destructive text-[10px] truncate">{r.error_message}</div>
                            )}
                          </div>
                          <Badge variant="outline" className={`text-[10px] capitalize ${
                            r.send_status === "sent" ? "border-primary/40 text-primary" :
                            r.send_status === "suppressed" ? "border-amber-500/40 text-amber-400" :
                            r.send_status === "failed" ? "border-destructive/40 text-destructive" :
                            "border-border text-muted-foreground"
                          }`}>{r.send_status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-2 text-center">
      <div className={`text-base font-bold ${accent ?? "text-foreground"}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground font-heading">{label}</div>
    </div>
  );
}
