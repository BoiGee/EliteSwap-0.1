import { useNavigate } from "react-router-dom";
import { useForumNotifications, type ForumNotification } from "@/hooks/useForumNotifications";
import { Button } from "@/components/ui/button";

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
  return "/forum";
}

export default function MyForum() {
  const navigate = useNavigate();
  const { data, unreadCount, markAllRead, markRead } = useForumNotifications(50);
  const items = data ?? [];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold text-foreground">My Community</h1>
            <p className="text-sm text-muted-foreground">
              {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/forum")} className="font-heading">
              Back to Community
            </Button>
            <Button
              size="sm"
              onClick={() => markAllRead.mutate()}
              disabled={unreadCount === 0 || markAllRead.isPending}
              className="font-heading"
            >
              Mark all read
            </Button>
          </div>
        </div>

        <div className="glass neon-border rounded-2xl divide-y divide-border">
          {items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No notifications yet. Join a thread to start getting updates.
            </div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  if (!n.read_at) markRead.mutate(n.id);
                  navigate(notifHref(n));
                }}
                className={`w-full text-left p-4 hover:bg-muted/40 transition-colors flex items-start gap-3 ${
                  n.read_at ? "" : "bg-primary/5"
                }`}
              >
                <div className={`h-2 w-2 mt-2 rounded-full ${n.read_at ? "bg-transparent" : "bg-primary"}`} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{notifLabel(n)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
