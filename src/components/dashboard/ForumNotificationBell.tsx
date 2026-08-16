import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useForumNotifications, type ForumNotification } from "@/hooks/useForumNotifications";

function notifLabel(n: ForumNotification): string {
  switch (n.kind) {
    case "reply": return "New reply to your thread";
    case "mention": return "You were mentioned";
    case "solved": return "Your reply was marked as the solution";
    case "media_approved": return "Your media was approved";
    case "media_rejected": return "Your media was rejected";
    case "report_resolved": return "A report you filed was reviewed";
    default: return n.kind.replace(/_/g, " ");
  }
}

function notifHref(n: ForumNotification): string {
  if (n.target_kind === "thread" && n.target_id) return `/forum/t/${n.target_id}`;
  if (n.target_kind === "reply" && n.data?.thread_id) return `/forum/t/${n.data.thread_id}`;
  return "/forum/me";
}

export default function ForumNotificationBell() {
  const navigate = useNavigate();
  const { data, unreadCount, markAllRead, markRead } = useForumNotifications(10);
  const items = data ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="relative font-heading text-xs"
          aria-label="Community notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 glass">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-heading font-semibold">Community</span>
          <button
            onClick={() => markAllRead.mutate()}
            disabled={unreadCount === 0 || markAllRead.isPending}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Mark all read
          </button>
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No notifications yet.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  if (!n.read_at) markRead.mutate(n.id);
                  navigate(notifHref(n));
                }}
                className={`w-full text-left px-3 py-2 hover:bg-muted/40 transition-colors border-l-2 ${
                  n.read_at ? "border-transparent" : "border-primary"
                }`}
              >
                <p className="text-xs font-medium text-foreground">{notifLabel(n)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(n.created_at).toLocaleString()}
                </p>
              </button>
            ))}
          </div>
        )}
        <DropdownMenuSeparator />
        <button
          onClick={() => navigate("/forum/me")}
          className="w-full px-3 py-2 text-xs text-center text-primary hover:bg-muted/40"
        >
          See all in Community →
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
