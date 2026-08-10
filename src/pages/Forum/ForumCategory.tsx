import { Helmet } from "react-helmet-async";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useState } from "react";
import ForumLayout from "./ForumLayout";
import { useForumCategories, useForumThreads, useAuthorProfiles } from "@/hooks/useForum";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare, Pin, CheckCircle2, Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import AuthorLabel from "@/components/forum/AuthorLabel";

export default function ForumCategory() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [sort, setSort] = useState<"new" | "hot" | "top" | "unanswered">("hot");
  const { data: categories } = useForumCategories();
  const cat = categories?.find((c) => c.slug === slug);
  const { data: threads } = useForumThreads(slug, sort);
  const { data: profiles } = useAuthorProfiles(threads?.map((t) => t.author_id) ?? []);

  return (
    <ForumLayout>
      <Helmet>
        <title>{cat?.name ?? "Forum"} — Elite Swap Community</title>
        <meta name="description" content={cat?.description ?? "Elite Swap community forum"} />
      </Helmet>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <Link to="/forum" className="text-xs text-muted-foreground hover:text-primary">← Forum</Link>
          <h1 className="text-2xl md:text-3xl font-heading font-bold mt-1">{cat?.name}</h1>
          <p className="text-sm text-muted-foreground">{cat?.description}</p>
        </div>
        <Button onClick={() => user ? navigate(`/forum/new?c=${slug}`) : navigate("/auth")}>
          <Plus className="w-4 h-4 mr-1" /> New thread
        </Button>
      </div>

      <div className="flex items-center gap-1 mb-3">
        {(["hot", "new", "top", "unanswered"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={`text-xs px-3 py-1 rounded-full capitalize ${
              sort === s ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted/30"
            }`}
          >{s}</button>
        ))}
      </div>

      <div className="space-y-2">
        {threads?.length === 0 && <p className="text-sm text-muted-foreground">No threads yet.</p>}
        {threads?.map((t) => (
          <Link key={t.id} to={`/forum/t/${t.id}`}>
            <Card className="p-3 hover:border-primary/50 transition flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {t.is_pinned && <Pin className="w-3 h-3 text-primary" />}
                  {t.is_solved && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                  <h3 className="font-heading font-medium truncate">{t.title}</h3>
                </div>
                <p className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
                  by <AuthorLabel postedAsAdmin={t.posted_as_admin} name={profiles?.[t.author_id]?.name} /> · {formatDistanceToNow(new Date(t.last_activity_at), { addSuffix: true })}
                </p>
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <MessageSquare className="w-3 h-3" /> {t.reply_count}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </ForumLayout>
  );
}
