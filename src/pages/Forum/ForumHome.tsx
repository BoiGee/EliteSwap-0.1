import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import ForumLayout from "./ForumLayout";
import { useForumCategories, useForumThreads, useAuthorProfiles } from "@/hooks/useForum";
import { Card } from "@/components/ui/card";
import { MessageSquare, Pin, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import AuthorLabel from "@/components/forum/AuthorLabel";

export default function ForumHome() {
  const { data: categories } = useForumCategories();
  const { data: threads } = useForumThreads(undefined, "hot");
  const { data: profiles } = useAuthorProfiles(threads?.map((t) => t.author_id) ?? []);

  return (
    <ForumLayout>
      <Helmet>
        <title>Community Forum — Elite Swap</title>
        <meta name="description" content="Share tips, workarounds, and help fellow creators in the Elite Swap community forum." />
        <link rel="canonical" href="https://eliteswap.online/forum" />
      </Helmet>

      <section className="mb-6">
        <h1 className="text-3xl md:text-4xl font-heading font-bold gradient-text">Community Forum</h1>
        <p className="text-muted-foreground mt-1">Share tips, workarounds, and help each other out.</p>
        <Link
          to="/forum/guidelines"
          className="inline-block text-xs text-primary mt-2 underline"
        >Community guidelines →</Link>
      </section>

      <section className="grid md:grid-cols-2 gap-3 mb-8">
        {categories?.map((c) => (
          <Link key={c.id} to={`/forum/c/${c.slug}`}>
            <Card className="p-4 hover:border-primary/50 transition">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-heading font-semibold text-lg">{c.name}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{c.description}</p>
                </div>
                {c.access_level === "partners" && (
                  <span className="text-[10px] bg-primary/15 text-primary px-2 py-0.5 rounded-full">Partners</span>
                )}
              </div>
            </Card>
          </Link>
        ))}
      </section>

      <section>
        <h2 className="text-xl font-heading font-bold mb-3">Recent activity</h2>
        <div className="space-y-2">
          {threads?.length === 0 && (
            <p className="text-sm text-muted-foreground">No threads yet — start the conversation!</p>
          )}
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
      </section>
    </ForumLayout>
  );
}
