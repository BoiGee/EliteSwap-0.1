import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Eye } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

interface Viewer {
  user_id: string;
  email: string | null;
  display_name: string | null;
  first_viewed_at: string;
  last_viewed_at: string;
  view_count: number;
}

interface Props {
  kind: "announcement" | "thread";
  targetId: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "default";
}

export default function ViewersDialog({ kind, targetId, label = "Views", size = "sm", variant = "outline" }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewers, setViewers] = useState<Viewer[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const rpc =
      kind === "announcement"
        ? supabase.rpc("admin_list_announcement_viewers", { p_announcement_id: targetId })
        : supabase.rpc("admin_list_thread_viewers", { p_thread_id: targetId });
    rpc.then(({ data, error }) => {
      if (error) toast.error(error.message);
      else setViewers((data ?? []) as Viewer[]);
      setLoading(false);
    });
  }, [open, kind, targetId]);

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} className="font-heading text-xs">
        <Eye className="w-3.5 h-3.5 mr-1" /> {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading">
              Viewers {viewers.length > 0 && <span className="text-muted-foreground text-sm">({viewers.length} unique)</span>}
            </DialogTitle>
          </DialogHeader>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : viewers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No views yet.</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
              {viewers.map((v) => (
                <div key={v.user_id} className="py-2 flex items-center gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{v.display_name || v.email || v.user_id.slice(0, 8)}</p>
                    {v.display_name && v.email && (
                      <p className="text-xs text-muted-foreground truncate">{v.email}</p>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted-foreground shrink-0">
                    <p>Last: {formatDistanceToNow(new Date(v.last_viewed_at), { addSuffix: true })}</p>
                    <p>{v.view_count} {v.view_count === 1 ? "view" : "views"}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
