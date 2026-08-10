import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAppNotifications, type AppNotification } from "@/hooks/useAppNotifications";

const CATEGORY_ICON: Record<AppNotification["category"], string> = {
  payment: "💰",
  security: "🔐",
  key: "🔑",
  admin_post: "📢",
  forum: "💬",
  system: "⚙️",
};

const SEVERITY_DOT: Record<AppNotification["severity"], string> = {
  info: "bg-primary",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const { items, unreadCount, hasUrgent, markAllRead, markRead } = useAppNotifications(25);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="relative font-heading text-xs neon-border"
          aria-label="Notifications"
        >
          <Bell className={`h-4 w-4 ${hasUrgent ? "text-amber-400 animate-pulse" : ""}`} />
          {unreadCount > 0 && (
            <span
              className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center ${
                hasUrgent ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
              }`}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 glass p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-heading font-semibold">Notifications</span>
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
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            You're all caught up.
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  if (!n.read_at) markRead.mutate(n.id);
                  if (n.href) navigate(n.href);
                }}
                className={`w-full text-left px-3 py-2.5 hover:bg-muted/40 transition-colors border-l-2 ${
                  n.read_at ? "border-transparent opacity-70" : "border-primary"
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-base leading-5">{CATEGORY_ICON[n.category]}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[n.severity]}`} />
                      <p className="text-xs font-semibold text-foreground truncate">{n.title}</p>
                    </div>
                    {n.body && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
