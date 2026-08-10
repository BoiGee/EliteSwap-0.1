import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useActiveAnnouncement } from "@/hooks/useActiveAnnouncement";
import { supabase } from "@/integrations/supabase/client";

const SEEN_KEY = "system_announcement_modal_seen_id";

export default function SystemAnnouncementModal() {
  const { announcement } = useActiveAnnouncement();
  const [open, setOpen] = useState(false);
  const recordedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!announcement || !announcement.display_modal) return;
    try {
      const seen = localStorage.getItem(SEEN_KEY);
      if (seen !== announcement.id) setOpen(true);
    } catch {
      setOpen(true);
    }
  }, [announcement]);

  useEffect(() => {
    if (!open || !announcement?.id) return;
    if (recordedRef.current.has(announcement.id)) return;
    recordedRef.current.add(announcement.id);
    supabase.rpc("record_announcement_view", { p_announcement_id: announcement.id }).then(() => {});
  }, [open, announcement?.id]);

  if (!announcement) return null;

  const close = () => {
    try {
      localStorage.setItem(SEEN_KEY, announcement.id);
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  const accent =
    announcement.severity === "critical"
      ? "text-red-400"
      : announcement.severity === "warning"
        ? "text-amber-400"
        : "text-sky-400";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={`font-heading ${accent}`}>{announcement.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-foreground/80 pt-2">
            {announcement.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          {announcement.cta_label && announcement.cta_url && (
            <Button asChild className="font-heading">
              <a
                href={announcement.cta_url}
                target={announcement.cta_url.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                onClick={close}
              >
                {announcement.cta_label}
              </a>
            </Button>
          )}
          <Button variant="outline" onClick={close} className="font-heading">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
