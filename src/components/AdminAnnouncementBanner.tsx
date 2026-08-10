import { Megaphone, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAppNotifications } from "@/hooks/useAppNotifications";

/**
 * A sticky banner shown above dashboard content whenever there are unread
 * admin announcements. Cannot be missed: full-width, accent gradient, dismissible.
 */
export default function AdminAnnouncementBanner() {
  const navigate = useNavigate();
  const { adminPosts, dismiss, markRead } = useAppNotifications(25);
  if (adminPosts.length === 0) return null;

  const top = adminPosts[0];

  return (
    <div className="w-full bg-gradient-to-r from-amber-500/20 via-primary/20 to-amber-500/20 border-b border-amber-500/40">
      <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3">
        <Megaphone className="h-4 w-4 text-amber-400 shrink-0 animate-pulse" />
        <button
          className="flex-1 text-left min-w-0"
          onClick={() => {
            markRead.mutate(top.id);
            if (top.href) navigate(top.href);
          }}
        >
          <p className="text-xs font-heading font-bold text-foreground truncate">
            {top.title}
            {adminPosts.length > 1 && (
              <span className="ml-2 text-[10px] text-muted-foreground font-normal">
                +{adminPosts.length - 1} more
              </span>
            )}
          </p>
          {top.body && (
            <p className="text-[11px] text-muted-foreground truncate">{top.body}</p>
          )}
        </button>
        <button
          onClick={() => dismiss.mutate(top.id)}
          className="p-1 rounded hover:bg-muted/40 shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
