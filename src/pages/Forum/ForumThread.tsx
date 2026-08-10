import { Helmet } from "react-helmet-async";
import { Link, useParams } from "react-router-dom";
import ForumLayout from "./ForumLayout";
import {
  useForumThread, useForumReplies, useCreateReply, useAuthorProfiles, useThreadMedia,
  useUpdateThread, useUpdateReply,
} from "@/hooks/useForum";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Composer from "@/components/forum/Composer";
import EditComposer from "@/components/forum/EditComposer";
import MediaGallery from "@/components/forum/MediaGallery";
import ReactionBar from "@/components/forum/ReactionBar";
import ReportDialog from "@/components/forum/ReportDialog";
import { useAuth } from "@/hooks/useAuth";
import { useAdmin } from "@/hooks/useAdmin";
import { attachMediaToTarget } from "@/lib/forum";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, Lock, Pencil, Pin } from "lucide-react";
import { toast } from "sonner";
import AuthorLabel from "@/components/forum/AuthorLabel";
import ViewersDialog from "@/components/admin/ViewersDialog";
import { useEffect, useRef, useState } from "react";

export default function ForumThread() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { isAdmin } = useAdmin();
  const { data: thread } = useForumThread(id);
  const { data: replies } = useForumReplies(id);
  const replyIds = (replies ?? []).map((r) => r.id);
  const { data: media } = useThreadMedia(id, replyIds);
  const authorIds = [thread?.author_id, ...(replies?.map((r) => r.author_id) ?? [])].filter(Boolean) as string[];
  const { data: profiles } = useAuthorProfiles(authorIds);
  const createReply = useCreateReply();
  const updateThread = useUpdateThread();
  const updateReply = useUpdateReply();
  const [editingThread, setEditingThread] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const recordedViewRef = useRef<string | null>(null);

  useEffect(() => {
    if (!thread?.id || !user) return;
    if (recordedViewRef.current === thread.id) return;
    if (thread.author_id === user.id) return;
    recordedViewRef.current = thread.id;
    supabase.rpc("record_thread_view", { p_thread_id: thread.id }).then(() => {});
  }, [thread?.id, thread?.author_id, user?.id]);

  if (!thread) return (
    <ForumLayout>
      <p className="text-muted-foreground">Loading…</p>
    </ForumLayout>
  );

  const threadMedia = (media ?? []).filter((m: any) => m.thread_id === thread.id);
  const repliesMedia = (replyId: string) => (media ?? []).filter((m: any) => m.reply_id === replyId);

  async function markSolution(replyId: string) {
    const { error } = await supabase.rpc("forum_mark_solution", { p_reply_id: replyId });
    if (error) toast.error(error.message); else toast.success("Marked as solution");
  }

  return (
    <ForumLayout>
      <Helmet>
        <title>{thread.title} — Forum</title>
        <meta name="description" content={thread.body_md.slice(0, 160)} />
        <link rel="canonical" href={`https://eliteswap.online/forum/t/${thread.id}`} />
      </Helmet>

      <Link to="/forum" className="text-xs text-muted-foreground hover:text-primary">← Forum</Link>

      <Card className="p-4 mt-2">
        <div className="flex items-center gap-2 mb-1">
          {thread.is_pinned && <Pin className="w-4 h-4 text-primary" />}
          {thread.is_locked && <Lock className="w-4 h-4 text-muted-foreground" />}
          {thread.is_solved && <CheckCircle2 className="w-4 h-4 text-green-500" />}
          <h1 className="text-xl md:text-2xl font-heading font-bold flex-1">{thread.title}</h1>
          {((user?.id === thread.author_id && !thread.is_locked) || isAdmin) && !editingThread && (
            <button
              onClick={() => setEditingThread(true)}
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
              aria-label="Edit thread"
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
          by <AuthorLabel postedAsAdmin={thread.posted_as_admin} name={profiles?.[thread.author_id]?.name} /> · {formatDistanceToNow(new Date(thread.created_at), { addSuffix: true })}
        </p>
        {editingThread ? (
          <div className="mt-3">
            <EditComposer
              initialTitle={thread.title}
              initialBody={thread.body_md}
              onCancel={() => setEditingThread(false)}
              onSave={async ({ title, body_md }) => {
                await updateThread.mutateAsync({ id: thread.id, title, body_md });
                setEditingThread(false);
                toast.success("Thread updated");
              }}
            />
          </div>
        ) : (
          <div className="whitespace-pre-wrap mt-3 text-sm leading-relaxed">{thread.body_md}</div>
        )}
        <MediaGallery items={threadMedia as any} viewerId={user?.id} isAdmin={isAdmin} />
        <div className="flex items-center justify-between flex-wrap gap-2">
          <ReactionBar targetKind="thread" targetId={thread.id} />
          <div className="flex items-center gap-2">
            {isAdmin && <ViewersDialog kind="thread" targetId={thread.id} />}
            <ReportDialog targetKind="thread" targetId={thread.id} />
          </div>
        </div>
      </Card>

      <div className="mt-6 space-y-2">
        <h2 className="text-sm font-heading font-semibold text-muted-foreground uppercase tracking-wide">
          {replies?.length ?? 0} {replies?.length === 1 ? "reply" : "replies"}
        </h2>
        {replies?.map((r) => {
          const isThreadOwner = user?.id === thread.author_id;
          const isReplyOwner = user?.id === r.author_id;
          const isEditing = editingReplyId === r.id;
          return (
            <Card key={r.id} className={`p-3 ${r.is_solution ? "border-green-500/50 bg-green-500/5" : ""}`}>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                  <AuthorLabel postedAsAdmin={r.posted_as_admin} name={profiles?.[r.author_id]?.name} /> · {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </p>
                {r.is_solution && (
                  <span className="text-xs text-green-600 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Solution
                  </span>
                )}
              </div>
              {isEditing ? (
                <div className="mt-2">
                  <EditComposer
                    initialBody={r.body_md}
                    onCancel={() => setEditingReplyId(null)}
                    onSave={async ({ body_md }) => {
                      await updateReply.mutateAsync({ id: r.id, thread_id: thread.id, body_md });
                      setEditingReplyId(null);
                      toast.success("Reply updated");
                    }}
                  />
                </div>
              ) : (
                <div className="whitespace-pre-wrap mt-2 text-sm leading-relaxed">{r.body_md}</div>
              )}
              <MediaGallery items={repliesMedia(r.id) as any} viewerId={user?.id} isAdmin={isAdmin} />
              <div className="flex items-center justify-between mt-1">
                <ReactionBar targetKind="reply" targetId={r.id} />
                <div className="flex items-center gap-3">
                  {(isReplyOwner || isAdmin) && !isEditing && (
                    <button
                      onClick={() => setEditingReplyId(r.id)}
                      className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                  )}
                  {(isThreadOwner || isAdmin) && !r.is_solution && (
                    <button
                      onClick={() => markSolution(r.id)}
                      className="text-xs text-green-600 hover:underline"
                    >Mark as solution</button>
                  )}
                  <ReportDialog targetKind="reply" targetId={r.id} />
                </div>
              </div>
            </Card>
          );
        })}
      </div>


      <div className="mt-6">
        {thread.is_locked ? (
          <p className="text-sm text-muted-foreground">This thread is locked.</p>
        ) : user ? (
          <ReplyArea
            isAdmin={isAdmin}
            onSubmit={async ({ body_md, mediaIds, postedAsAdmin }) => {
              const reply = await createReply.mutateAsync({ thread_id: thread.id, body_md, posted_as_admin: postedAsAdmin });
              if (mediaIds.length) await attachMediaToTarget(mediaIds, { reply_id: reply.id });
              toast.success("Reply posted");
            }}
          />
        ) : (
          <Card className="p-4 text-center">
            <p className="text-sm text-muted-foreground mb-2">Sign in to join the conversation.</p>
            <Button asChild><Link to="/auth">Sign in</Link></Button>
          </Card>
        )}
      </div>
    </ForumLayout>
  );
}

function ReplyArea({
  isAdmin,
  onSubmit,
}: {
  isAdmin: boolean;
  onSubmit: (data: { body_md: string; mediaIds: string[]; postedAsAdmin: boolean }) => Promise<void>;
}) {
  const [asAdmin, setAsAdmin] = useState(false);
  return (
    <div className="space-y-2">
      {isAdmin && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
          Reply as <span className="font-medium text-primary">Admin</span> (your identity stays hidden)
        </label>
      )}
      <Composer
        submitLabel="Reply"
        placeholder="Write a reply…"
        onSubmit={async ({ body_md, mediaIds }) => {
          await onSubmit({ body_md, mediaIds, postedAsAdmin: asAdmin });
        }}
      />
    </div>
  );
}

