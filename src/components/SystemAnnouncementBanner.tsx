import { useEffect, useRef, useState } from "react";
import { X, Info, AlertTriangle, AlertOctagon } from "lucide-react";
import { useActiveAnnouncement } from "@/hooks/useActiveAnnouncement";
import { supabase } from "@/integrations/supabase/client";

const DISMISS_KEY = "system_announcement_dismissed_id";

export default function SystemAnnouncementBanner() {
  const { announcement } = useActiveAnnouncement();
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const recordedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      setDismissedId(localStorage.getItem(DISMISS_KEY));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!announcement?.id || !announcement.display_banner) return;
    if (recordedRef.current.has(announcement.id)) return;
    recordedRef.current.add(announcement.id);
    supabase.rpc("record_announcement_view", { p_announcement_id: announcement.id }).then(() => {});
  }, [announcement?.id, announcement?.display_banner]);

  if (!announcement || !announcement.display_banner) return null;
  if (announcement.severity !== "critical" && dismissedId === announcement.id) return null;

  const palette = {
    info: {
      bg: "bg-sky-500/15",
      border: "border-sky-500/40",
      text: "text-sky-200",
      icon: <Info className="h-4 w-4 shrink-0" />,
    },
    warning: {
      bg: "bg-amber-500/15",
      border: "border-amber-500/40",
      text: "text-amber-200",
      icon: <AlertTriangle className="h-4 w-4 shrink-0" />,
    },
    critical: {
      bg: "bg-red-500/20",
      border: "border-red-500/50",
      text: "text-red-200",
      icon: <AlertOctagon className="h-4 w-4 shrink-0" />,
    },
  }[announcement.severity];

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, announcement.id);
    } catch {
      /* ignore */
    }
    setDismissedId(announcement.id);
  };

  return (
    <div
      role="alert"
      className={`w-full border-b ${palette.bg} ${palette.border} ${palette.text} backdrop-blur-sm`}
    >
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
        {palette.icon}
        <div className="flex-1 min-w-0">
          <span className="font-heading font-semibold">{announcement.title}</span>
          <span className="mx-2 opacity-50">·</span>
          <span className="opacity-90">{announcement.message}</span>
        </div>
        {announcement.cta_label && announcement.cta_url && (
          <a
            href={announcement.cta_url}
            target={announcement.cta_url.startsWith("http") ? "_blank" : undefined}
            rel="noreferrer"
            className="font-heading font-semibold underline whitespace-nowrap hover:opacity-80"
          >
            {announcement.cta_label}
          </a>
        )}
        {announcement.severity !== "critical" && (
          <button
            onClick={dismiss}
            aria-label="Dismiss announcement"
            className="shrink-0 opacity-70 hover:opacity-100 transition"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
