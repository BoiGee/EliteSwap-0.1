import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Flag } from "lucide-react";

const REASONS = ["Spam", "Harassment", "Off-topic", "Inappropriate content", "Other"];

export default function ReportDialog({
  targetKind, targetId,
}: { targetKind: "thread" | "reply"; targetId: string }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!user) { toast.error("Sign in to report"); return; }
    setBusy(true);
    const { data: inserted, error } = await supabase.from("forum_reports").insert({
      target_kind: targetKind, target_id: targetId, reporter_id: user.id, reason, details: details || null,
    }).select("id").maybeSingle();
    setBusy(false);
    if (error) toast.error(error.message);
    else {
      if (inserted?.id) {
        supabase.functions.invoke("notify-admin-event", {
          body: { event: "forum_report", reportId: inserted.id },
        }).catch(() => {});
      }
      toast.success("Thanks — a moderator will review this."); setOpen(false); setDetails("");
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground hover:text-destructive inline-flex items-center gap-1"
      >
        <Flag className="w-3 h-3" /> Report
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Report this content</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setReason(r)}
                  className={`text-xs px-3 py-1.5 rounded-full border ${
                    reason === r ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                  }`}
                >{r}</button>
              ))}
            </div>
            <Textarea
              placeholder="Optional details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              maxLength={1000}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit report"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
