import { useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download, AlertTriangle } from "lucide-react";

export interface RecipientPreviewRow {
  user_id: string;
  email: string;
  display_name: string | null;
  suppressed: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loading: boolean;
  recipients: RecipientPreviewRow[];
  total: number;
  suppressed: number;
  sendable: number;
  isAllOrLarge: boolean;
  isScheduled: boolean;
  scheduledFor?: string;
  onConfirm: () => void;
  /** When isAllOrLarge, user must type "SEND ALL" to enable the confirm button */
  requireTypedConfirm: boolean;
}

export default function RecipientPreviewDialog({
  open, onOpenChange, loading, recipients, total, suppressed, sendable,
  isAllOrLarge, isScheduled, scheduledFor, onConfirm, requireTypedConfirm,
}: Props) {
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) =>
      r.email.toLowerCase().includes(q) ||
      (r.display_name ?? "").toLowerCase().includes(q),
    );
  }, [recipients, search]);

  const downloadCsv = () => {
    const header = ["email", "display_name", "user_id", "suppressed"];
    const escape = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
    const rows = recipients.map((r) =>
      [r.email, r.display_name ?? "", r.user_id, r.suppressed ? "yes" : "no"].map(escape).join(","),
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `broadcast-recipients-${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const confirmDisabled =
    loading || sendable === 0 || (requireTypedConfirm && typed.trim().toUpperCase() !== "SEND ALL");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-heading">Confirm broadcast recipients</DialogTitle>
          <DialogDescription>
            Review the exact list of users that will receive this email
            {isScheduled && scheduledFor && (
              <> at <strong>{new Date(scheduledFor).toLocaleString()}</strong></>
            )}
            .
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2 text-xs font-heading">
          <div className="rounded-lg bg-muted/30 p-3">
            <div className="text-muted-foreground">Total matched</div>
            <div className="text-lg font-bold text-foreground">{total}</div>
          </div>
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
            <div className="text-muted-foreground">Suppressed</div>
            <div className="text-lg font-bold text-amber-400">{suppressed}</div>
          </div>
          <div className="rounded-lg bg-primary/10 border border-primary/30 p-3">
            <div className="text-muted-foreground">Will send</div>
            <div className="text-lg font-bold text-primary">{sendable}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            placeholder="Filter by email or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-xs"
          />
          <Button variant="outline" size="sm" onClick={downloadCsv} className="font-heading text-xs whitespace-nowrap">
            <Download className="w-3 h-3 mr-1" /> CSV
          </Button>
        </div>

        <ScrollArea className="h-[260px] border border-border rounded-lg">
          <div className="divide-y divide-border">
            {filtered.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">No matches.</div>
            )}
            {filtered.map((r) => (
              <div key={r.user_id + r.email} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-heading text-foreground truncate">{r.email}</div>
                  {r.display_name && <div className="text-muted-foreground truncate">{r.display_name}</div>}
                </div>
                {r.suppressed ? (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-400 text-[10px]">Suppressed</Badge>
                ) : (
                  <Badge variant="outline" className="border-primary/40 text-primary text-[10px]">Will send</Badge>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>

        {isAllOrLarge && (
          <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <div className="text-xs text-destructive font-heading">
                You're about to email <strong>{sendable}</strong> recipients. To confirm, type <code>SEND ALL</code> below.
              </div>
            </div>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type SEND ALL to enable the button"
              className="text-xs"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="font-heading">Cancel</Button>
          <Button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-heading"
          >
            {loading
              ? "Sending..."
              : isScheduled
              ? `Schedule for ${sendable} recipient${sendable === 1 ? "" : "s"}`
              : `Send to ${sendable} recipient${sendable === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
