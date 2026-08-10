import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import Composer from "@/components/forum/Composer";
import EditComposer from "@/components/forum/EditComposer";
import ViewersDialog from "./ViewersDialog";
import {
  useForumCategories,
  useCreateThread,
  useAdminAnnouncements,
  useAdminSetThreadFlags,
  useAdminDeleteThread,
  useUpdateThread,
  useUpdateReply,
  useAdminAllThreads,
  useAdminThreadReplies,
  useAdminDeleteReply,
  useAdminSetThreadHidden,
  useAdminSetReplyHidden,
  useAuthorProfiles,
  ADMIN_ALL_THREADS_PAGE_SIZE,
  type ForumThreadRow,
  type ForumReplyRow,
} from "@/hooks/useForum";
import { attachMediaToTarget, getSignedMediaUrl } from "@/lib/forum";
import { toast } from "sonner";
import { useAdmin } from "@/hooks/useAdmin";
import { Check, X, Flag, Trash2, Megaphone, Pin, Lock, Pencil, ExternalLink, Eye, EyeOff, MessageSquare, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Tab = "all" | "compose" | "announcements" | "media" | "reports" | "bans";


interface PendingMedia {
  id: string;
  owner_id: string;
  kind: "image" | "audio";
  mime: string;
  status: string;
  created_at: string;
  thread_id: string | null;
  reply_id: string | null;
}

interface ReportRow {
  id: string;
  target_kind: "thread" | "reply";
  target_id: string;
  reason: string;
  details: string | null;
  status: "open" | "actioned" | "dismissed";
  reporter_id: string;
  created_at: string;
}

function MediaPreview({ id, kind }: { id: string; kind: "image" | "audio" }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    getSignedMediaUrl(id).then((r) => setUrl(r.url)).catch(() => {});
  }, [id]);
  if (!url) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (kind === "image") return <img src={url} alt="" className="w-32 h-32 object-cover rounded" />;
  return <audio controls src={url} className="w-64" />;
}

export default function ForumManager() {
  const { isAdmin } = useAdmin();
  const [tab, setTab] = useState<Tab>(isAdmin ? "all" : "reports");

  const [media, setMedia] = useState<PendingMedia[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [bans, setBans] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadMedia() {
    setLoading(true);
    const { data } = await supabase.from("forum_media").select("*").eq("status", "pending").order("created_at");
    setMedia((data ?? []) as PendingMedia[]);
    setLoading(false);
  }
  async function loadReports() {
    setLoading(true);
    const { data } = await supabase.from("forum_reports").select("*").eq("status", "open").order("created_at");
    setReports((data ?? []) as ReportRow[]);
    setLoading(false);
  }
  async function loadBans() {
    setLoading(true);
    const { data } = await supabase.from("forum_user_stats").select("*").eq("is_banned", true);
    const userIds = (data ?? []).map((b: any) => b.user_id);
    let emails: Record<string, string> = {};
    if (userIds.length) {
      const { data: profs } = await supabase.from("profiles").select("user_id,email,display_name").in("user_id", userIds);
      for (const p of profs ?? []) emails[(p as any).user_id] = (p as any).display_name || (p as any).email || "User";
    }
    setBans((data ?? []).map((b: any) => ({ ...b, _label: emails[b.user_id] ?? b.user_id })));
    setLoading(false);
  }

  useEffect(() => {
    if (tab === "media") loadMedia();
    if (tab === "reports") loadReports();
    if (tab === "bans") loadBans();
  }, [tab]);

  async function moderate(id: string, status: "approved" | "rejected") {
    const { error } = await supabase.from("forum_media").update({
      status, reviewed_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success(`Media ${status}`); loadMedia(); }
  }

  async function resolveReport(r: ReportRow, action: "hide" | "delete" | "dismiss") {
    if (action === "hide") {
      const table = r.target_kind === "thread" ? "forum_threads" : "forum_replies";
      await supabase.from(table).update({ hidden_at: new Date().toISOString(), hidden_reason: "admin: report actioned" }).eq("id", r.target_id);
    } else if (action === "delete") {
      const table = r.target_kind === "thread" ? "forum_threads" : "forum_replies";
      await supabase.from(table).delete().eq("id", r.target_id);
    }
    await supabase.from("forum_reports").update({
      status: action === "dismiss" ? "dismissed" : "actioned",
      handled_at: new Date().toISOString(),
    }).eq("id", r.id);
    toast.success("Report handled");
    loadReports();
  }

  async function unban(userId: string) {
    const { error } = await supabase.from("forum_user_stats").update({
      is_banned: false, banned_reason: null, banned_at: null,
    }).eq("user_id", userId);
    if (error) toast.error(error.message); else { toast.success("Unbanned"); loadBans(); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-heading font-bold">Forum</h2>
      </div>
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {((isAdmin
          ? ["all", "compose", "announcements", "media", "reports", "bans"]
          : ["reports", "bans"]) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 transition whitespace-nowrap ${
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}
          >{t === "all" ? "All posts" : t}</button>
        ))}
      </div>

      {tab === "all" && isAdmin && <AllPostsTab />}
      {tab === "compose" && isAdmin && <ComposeTab />}
      {tab === "announcements" && isAdmin && <AnnouncementsTab />}


      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {tab === "media" && (
        <div className="space-y-3">
          {media.length === 0 && !loading && <p className="text-sm text-muted-foreground">Nothing pending. 🎉</p>}
          {media.map((m) => (
            <Card key={m.id} className="p-3 flex items-start gap-3">
              <MediaPreview id={m.id} kind={m.kind} />
              <div className="flex-1 text-xs space-y-1">
                <p>Kind: <b>{m.kind}</b> · {m.mime}</p>
                <p>Owner: {m.owner_id.slice(0, 8)}…</p>
                <p>Attached: {m.thread_id ? "thread" : m.reply_id ? "reply" : "(unattached)"}</p>
                <p>Uploaded {formatDistanceToNow(new Date(m.created_at), { addSuffix: true })}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button size="sm" onClick={() => moderate(m.id, "approved")}>
                  <Check className="w-4 h-4 mr-1" /> Approve
                </Button>
                <Button size="sm" variant="destructive" onClick={() => moderate(m.id, "rejected")}>
                  <X className="w-4 h-4 mr-1" /> Reject
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "reports" && (
        <div className="space-y-3">
          {reports.length === 0 && !loading && <p className="text-sm text-muted-foreground">No open reports.</p>}
          {reports.map((r) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-center gap-2 text-xs">
                <Flag className="w-3 h-3 text-destructive" />
                <span className="capitalize">{r.target_kind}</span>
                <span className="text-muted-foreground">·</span>
                <span>{r.reason}</span>
                <span className="text-muted-foreground ml-auto">
                  {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </span>
              </div>
              {r.details && <p className="text-sm mt-2">{r.details}</p>}
              <p className="text-xs text-muted-foreground mt-1">Target id: {r.target_id}</p>
              <div className="flex gap-2 mt-3">
                <Button size="sm" variant="outline" onClick={() => resolveReport(r, "dismiss")}>Dismiss</Button>
                <Button size="sm" variant="secondary" onClick={() => resolveReport(r, "hide")}>Hide content</Button>
                <Button size="sm" variant="destructive" onClick={() => resolveReport(r, "delete")}>
                  <Trash2 className="w-4 h-4 mr-1" /> Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "bans" && (
        <div className="space-y-2">
          {bans.length === 0 && !loading && <p className="text-sm text-muted-foreground">No bans.</p>}
          {bans.map((b: any) => (
            <Card key={b.user_id} className="p-3 flex items-center justify-between">
              <div className="text-sm">
                <p>{b._label}</p>
                <p className="text-xs text-muted-foreground">{b.banned_reason}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => unban(b.user_id)}>Unban</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ComposeTab() {
  const navigate = useNavigate();
  const { data: categories } = useForumCategories();
  const createThread = useCreateThread();
  const [categoryId, setCategoryId] = useState("");
  const [title, setTitle] = useState("");
  const [isPinned, setIsPinned] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Megaphone className="w-4 h-4 text-primary" />
        <h3 className="font-heading font-semibold">Post as Admin</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Threads posted here appear publicly attributed to <span className="text-primary font-medium">Admin</span>. Your personal identity is never shown.
      </p>
      <div className="space-y-1">
        <Label>Category</Label>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm"
        >
          <option value="">Choose…</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label>Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Announcement title" />
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={isPinned} onCheckedChange={(v) => setIsPinned(!!v)} /> Pin to top
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={isLocked} onCheckedChange={(v) => setIsLocked(!!v)} /> Lock replies
        </label>
      </div>
      <Composer
        submitLabel="Publish announcement"
        placeholder="Write your announcement…"
        onSubmit={async ({ body_md, mediaIds }) => {
          if (!categoryId) { toast.error("Pick a category"); return; }
          if (title.trim().length < 3) { toast.error("Title is too short"); return; }
          const thread = await createThread.mutateAsync({
            category_id: categoryId,
            title,
            body_md,
            posted_as_admin: true,
            is_pinned: isPinned,
            is_locked: isLocked,
          });
          if (mediaIds.length) await attachMediaToTarget(mediaIds, { thread_id: thread.id });
          toast.success("Announcement posted");
          navigate(`/forum/t/${thread.id}`);
        }}
      />
    </Card>
  );
}

function AnnouncementsTab() {
  const { data: list, isLoading } = useAdminAnnouncements();
  const { data: categories } = useForumCategories();
  const updateThread = useUpdateThread();
  const setFlags = useAdminSetThreadFlags();
  const del = useAdminDeleteThread();
  const [editingId, setEditingId] = useState<string | null>(null);

  const catName = (id: string) => categories?.find((c) => c.id === id)?.name ?? "—";

  async function onDelete(t: ForumThreadRow) {
    if (!confirm(`Delete announcement "${t.title}"? This removes the thread and its replies.`)) return;
    try { await del.mutateAsync(t.id); toast.success("Deleted"); }
    catch (e: any) { toast.error(e.message ?? "Failed to delete"); }
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!list?.length) return <p className="text-sm text-muted-foreground">No admin announcements yet.</p>;

  return (
    <div className="space-y-3">
      {list.map((t) => {
        const editing = editingId === t.id;
        return (
          <Card key={t.id} className="p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {t.is_pinned && <Pin className="w-3.5 h-3.5 text-primary" />}
                  {t.is_locked && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
                  <h3 className="font-heading font-semibold truncate">{t.title}</h3>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {catName(t.category_id)} · {formatDistanceToNow(new Date(t.created_at), { addSuffix: true })} · {t.reply_count} {t.reply_count === 1 ? "reply" : "replies"}
                </p>
              </div>
              <a
                href={`/forum/t/${t.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open
              </a>
            </div>
            {editing ? (
              <EditComposer
                initialTitle={t.title}
                initialBody={t.body_md}
                onCancel={() => setEditingId(null)}
                onSave={async ({ title, body_md }) => {
                  try {
                    await updateThread.mutateAsync({ id: t.id, title, body_md });
                    setEditingId(null);
                    toast.success("Announcement updated");
                  } catch (e: any) {
                    toast.error(e.message ?? "Failed to update");
                  }
                }}
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap line-clamp-3 text-muted-foreground">{t.body_md}</p>
            )}
            {!editing && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setEditingId(t.id)}>
                  <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                </Button>
                <ViewersDialog kind="thread" targetId={t.id} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFlags.mutate({ id: t.id, is_pinned: !t.is_pinned })}
                >
                  <Pin className="w-3.5 h-3.5 mr-1" /> {t.is_pinned ? "Unpin" : "Pin"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFlags.mutate({ id: t.id, is_locked: !t.is_locked })}
                >
                  <Lock className="w-3.5 h-3.5 mr-1" /> {t.is_locked ? "Unlock" : "Lock"}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => onDelete(t)}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                </Button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function AllPostsTab() {
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: categories } = useForumCategories();
  const { data, isLoading } = useAdminAllThreads({ search, categoryId: categoryId || undefined, includeHidden, page });
  const rows = data?.rows ?? [];
  const total = data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_ALL_THREADS_PAGE_SIZE));

  const authorIds = Array.from(new Set(rows.map((r) => r.author_id)));
  const { data: authors } = useAuthorProfiles(authorIds);
  const authorLabel = (id: string) => {
    const a = (authors as any)?.[id];
    return a?.name || (id.slice(0, 8) + "…");

  };
  const catName = (id: string) => categories?.find((c) => c.id === id)?.name ?? "—";

  const updateThread = useUpdateThread();
  const setFlags = useAdminSetThreadFlags();
  const setHidden = useAdminSetThreadHidden();
  const del = useAdminDeleteThread();

  async function onDelete(t: ForumThreadRow) {
    if (!confirm(`Delete "${t.title}"? This removes the thread and all its replies.`)) return;
    try { await del.mutateAsync(t.id); toast.success("Thread deleted"); }
    catch (e: any) { toast.error(e?.message ?? "Failed to delete"); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <form
          onSubmit={(e) => { e.preventDefault(); setPage(0); setSearch(searchInput); }}
          className="flex items-center gap-1 flex-1 min-w-[220px]"
        >
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search titles…"
              className="pl-7 h-8 text-sm"
            />
          </div>
          <Button type="submit" size="sm" variant="outline">Search</Button>
        </form>
        <select
          value={categoryId}
          onChange={(e) => { setPage(0); setCategoryId(e.target.value); }}
          className="bg-background border border-input rounded-md px-2 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {categories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={includeHidden} onCheckedChange={(v) => { setPage(0); setIncludeHidden(!!v); }} />
          Show hidden
        </label>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && rows.length === 0 && <p className="text-sm text-muted-foreground">No posts match.</p>}

      <div className="space-y-2">
        {rows.map((t) => {
          const isHidden = !!(t as any).hidden_at;
          const editing = editingId === t.id;
          const expanded = expandedId === t.id;
          return (
            <Card key={t.id} className="p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {t.is_pinned && <Pin className="w-3.5 h-3.5 text-primary" />}
                    {t.is_locked && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
                    {isHidden && <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">hidden</span>}
                    {t.posted_as_admin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">admin</span>}
                    <h3 className="font-heading font-semibold truncate">{t.title}</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {catName(t.category_id)} · by {t.posted_as_admin ? "Admin" : authorLabel(t.author_id)} · {formatDistanceToNow(new Date(t.created_at), { addSuffix: true })} · {t.reply_count} {t.reply_count === 1 ? "reply" : "replies"}
                  </p>
                </div>
                <a
                  href={`/forum/t/${t.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open
                </a>
              </div>

              {editing ? (
                <EditComposer
                  initialTitle={t.title}
                  initialBody={t.body_md}
                  onCancel={() => setEditingId(null)}
                  onSave={async ({ title, body_md }) => {
                    await updateThread.mutateAsync({ id: t.id, title, body_md });
                    setEditingId(null);
                    toast.success("Thread updated");
                  }}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap line-clamp-3 text-muted-foreground">{t.body_md}</p>
              )}

              {!editing && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setEditingId(t.id)}>
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setFlags.mutate({ id: t.id, is_pinned: !t.is_pinned })}>
                    <Pin className="w-3.5 h-3.5 mr-1" /> {t.is_pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setFlags.mutate({ id: t.id, is_locked: !t.is_locked })}>
                    <Lock className="w-3.5 h-3.5 mr-1" /> {t.is_locked ? "Unlock" : "Lock"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setHidden.mutate({ id: t.id, hidden: !isHidden })}>
                    {isHidden ? <><Eye className="w-3.5 h-3.5 mr-1" /> Unhide</> : <><EyeOff className="w-3.5 h-3.5 mr-1" /> Hide</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setExpandedId(expanded ? null : t.id)}>
                    <MessageSquare className="w-3.5 h-3.5 mr-1" /> {expanded ? "Hide replies" : "View replies"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => onDelete(t)}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                  </Button>
                </div>
              )}

              {expanded && !editing && <RepliesPanel threadId={t.id} />}
            </Card>
          );
        })}
      </div>

      {total > ADMIN_ALL_THREADS_PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            {total} total · Page {page + 1} of {pageCount}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </Button>
            <Button size="sm" variant="outline" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RepliesPanel({ threadId }: { threadId: string }) {
  const { data: replies, isLoading } = useAdminThreadReplies(threadId);
  const authorIds = Array.from(new Set((replies ?? []).map((r) => r.author_id)));
  const { data: authors } = useAuthorProfiles(authorIds);
  const authorLabel = (id: string) => {
    const a = (authors as any)?.[id];
    return a?.name || (id.slice(0, 8) + "…");
  };
  const updateReply = useUpdateReply();
  const setReplyHidden = useAdminSetReplyHidden();
  const delReply = useAdminDeleteReply();
  const [editingId, setEditingId] = useState<string | null>(null);

  async function onDelete(r: ForumReplyRow) {
    if (!confirm("Delete this reply?")) return;
    try { await delReply.mutateAsync({ id: r.id, thread_id: r.thread_id }); toast.success("Reply deleted"); }
    catch (e: any) { toast.error(e?.message ?? "Failed to delete"); }
  }

  return (
    <div className="mt-2 pt-3 border-t border-border space-y-2">
      {isLoading && <p className="text-xs text-muted-foreground">Loading replies…</p>}
      {!isLoading && (replies?.length ?? 0) === 0 && (
        <p className="text-xs text-muted-foreground">No replies yet.</p>
      )}
      {replies?.map((r) => {
        const isHidden = !!(r as any).hidden_at;
        const editing = editingId === r.id;
        return (
          <div key={r.id} className="rounded-md border border-border bg-muted/20 p-2 space-y-1">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{r.posted_as_admin ? "Admin" : authorLabel(r.author_id)}</span>
              <span>·</span>
              <span>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</span>
              {isHidden && <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">hidden</span>}
              {r.is_solution && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">solution</span>}
            </div>
            {editing ? (
              <EditComposer
                initialBody={r.body_md}
                onCancel={() => setEditingId(null)}
                onSave={async ({ body_md }) => {
                  await updateReply.mutateAsync({ id: r.id, thread_id: r.thread_id, body_md });
                  setEditingId(null);
                  toast.success("Reply updated");
                }}
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{r.body_md}</p>
            )}
            {!editing && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setEditingId(r.id)}>
                  <Pencil className="w-3 h-3 mr-1" /> Edit
                </Button>
                <Button size="sm" variant="outline" onClick={() => setReplyHidden.mutate({ id: r.id, thread_id: r.thread_id, hidden: !isHidden })}>
                  {isHidden ? <><Eye className="w-3 h-3 mr-1" /> Unhide</> : <><EyeOff className="w-3 h-3 mr-1" /> Hide</>}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => onDelete(r)}>
                  <Trash2 className="w-3 h-3 mr-1" /> Delete
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}



