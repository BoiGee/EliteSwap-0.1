import { useNavigate } from "react-router-dom";
import { MessageSquare, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useDashboardForumDigest } from "@/hooks/useDashboardForumDigest";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function CommunityTile() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const emailVerified = !!user?.email_confirmed_at;
  const { data, isLoading } = useDashboardForumDigest();
  const threads = data?.threads ?? [];
  const following = data?.isFollowing ?? false;

  return (
    <div className="glass border border-border rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-primary/10 text-primary">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-heading font-semibold text-foreground">Community</h3>
            <p className="text-xs text-muted-foreground">
              {following ? "Threads you follow" : "Latest from the community"}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => navigate("/forum")}
          className="font-heading"
        >
          Open
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : threads.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          Ask questions, share tips, and learn from other creators.
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => navigate("/forum")} className="font-heading">
              Browse Community
            </Button>
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => navigate(`/forum/t/${t.id}`)}
                className="w-full text-left rounded-lg px-3 py-2 hover:bg-muted/40 transition-colors"
              >
                <p className="text-sm font-medium text-foreground line-clamp-1">{t.title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {t.category_name ?? "Community"} · {t.reply_count} {t.reply_count === 1 ? "reply" : "replies"} · {timeAgo(t.last_activity_at)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        {emailVerified ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate("/forum/new")}
            className="font-heading text-xs"
          >
            <PlusCircle className="h-3.5 w-3.5 mr-1" />
            Start a thread
          </Button>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Verify your email to post in the community.
          </p>
        )}
      </div>
    </div>
  );
}
