import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { slugify } from "@/lib/forum";

export type ForumCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  access_level: "public" | "partners" | "admins";
};

export type ForumThreadRow = {
  id: string;
  category_id: string;
  author_id: string;
  title: string;
  slug: string;
  body_md: string;
  is_pinned: boolean;
  is_locked: boolean;
  is_solved: boolean;
  solved_reply_id: string | null;
  reply_count: number;
  reaction_count: number;
  views: number;
  last_activity_at: string;
  created_at: string;
  posted_as_admin?: boolean;
};

export type ForumReplyRow = {
  id: string;
  thread_id: string;
  parent_reply_id: string | null;
  author_id: string;
  body_md: string;
  is_solution: boolean;
  reaction_count: number;
  created_at: string;
  posted_as_admin?: boolean;
};

export function useForumCategories() {
  return useQuery({
    queryKey: ["forum", "categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("forum_categories")
        .select("*")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as ForumCategory[];
    },
  });
}

export function useForumThreads(categorySlug?: string, sort: "new" | "hot" | "top" | "unanswered" = "new") {
  return useQuery({
    queryKey: ["forum", "threads", categorySlug ?? "all", sort],
    queryFn: async () => {
      let categoryId: string | undefined;
      if (categorySlug) {
        const { data: cat } = await supabase
          .from("forum_categories").select("id").eq("slug", categorySlug).maybeSingle();
        categoryId = cat?.id;
        if (!categoryId) return [] as ForumThreadRow[];
      }
      let q = supabase.from("forum_threads").select("*").limit(50);
      if (categoryId) q = q.eq("category_id", categoryId);
      if (sort === "new") q = q.order("is_pinned", { ascending: false }).order("created_at", { ascending: false });
      else if (sort === "top") q = q.order("reaction_count", { ascending: false });
      else if (sort === "unanswered") q = q.eq("reply_count", 0).order("created_at", { ascending: false });
      else q = q.order("is_pinned", { ascending: false }).order("last_activity_at", { ascending: false });
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ForumThreadRow[];
    },
  });
}

export function useForumThread(threadId: string | undefined) {
  return useQuery({
    enabled: !!threadId,
    queryKey: ["forum", "thread", threadId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("forum_threads").select("*").eq("id", threadId!).maybeSingle();
      if (error) throw error;
      return data as ForumThreadRow | null;
    },
  });
}

export function useForumReplies(threadId: string | undefined) {
  return useQuery({
    enabled: !!threadId,
    queryKey: ["forum", "replies", threadId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("forum_replies").select("*")
        .eq("thread_id", threadId!)
        .order("is_solution", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ForumReplyRow[];
    },
  });
}

export function useCreateThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { category_id: string; title: string; body_md: string; posted_as_admin?: boolean; is_pinned?: boolean; is_locked?: boolean }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Sign in to post");
      const { data, error } = await supabase
        .from("forum_threads")
        .insert({
          category_id: input.category_id,
          author_id: user.id,
          title: input.title.trim(),
          slug: slugify(input.title),
          body_md: input.body_md,
          posted_as_admin: input.posted_as_admin ?? false,
          is_pinned: input.is_pinned ?? false,
          is_locked: input.is_locked ?? false,
        })
        .select("*").single();
      if (error) throw error;
      return data as ForumThreadRow;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forum"] }),
  });
}

export function useCreateReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { thread_id: string; body_md: string; parent_reply_id?: string; posted_as_admin?: boolean }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Sign in to reply");
      const { data, error } = await supabase
        .from("forum_replies")
        .insert({
          thread_id: input.thread_id,
          author_id: user.id,
          body_md: input.body_md,
          parent_reply_id: input.parent_reply_id ?? null,
          posted_as_admin: input.posted_as_admin ?? false,
        })
        .select("*").single();
      if (error) throw error;
      return data as ForumReplyRow;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["forum", "replies", vars.thread_id] });
      qc.invalidateQueries({ queryKey: ["forum", "thread", vars.thread_id] });
      qc.invalidateQueries({ queryKey: ["forum", "threads"] });
    },
  });
}

export function useUpdateThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; title?: string; body_md?: string }) => {
      const patch: { title?: string; slug?: string; body_md?: string } = {};
      if (typeof input.title === "string") {
        patch.title = input.title.trim();
        patch.slug = slugify(input.title);
      }
      if (typeof input.body_md === "string") patch.body_md = input.body_md;
      const { data, error } = await supabase
        .from("forum_threads")
        .update(patch)
        .eq("id", input.id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ForumThreadRow;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["forum", "thread", vars.id] });
      qc.invalidateQueries({ queryKey: ["forum", "threads"] });
    },
  });
}

export function useUpdateReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; thread_id: string; body_md: string }) => {
      const { data, error } = await supabase
        .from("forum_replies")
        .update({ body_md: input.body_md })
        .eq("id", input.id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ForumReplyRow;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["forum", "replies", vars.thread_id] });
    },
  });
}

export function useAdminAnnouncements() {
  return useQuery({
    queryKey: ["forum", "admin", "announcements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("forum_threads")
        .select("*")
        .eq("posted_as_admin", true)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as ForumThreadRow[];
    },
  });
}

export function useAdminSetThreadFlags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; is_pinned?: boolean; is_locked?: boolean }) => {
      const patch: { is_pinned?: boolean; is_locked?: boolean } = {};
      if (typeof input.is_pinned === "boolean") patch.is_pinned = input.is_pinned;
      if (typeof input.is_locked === "boolean") patch.is_locked = input.is_locked;
      const { error } = await supabase.from("forum_threads").update(patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["forum", "admin", "announcements"] });
      qc.invalidateQueries({ queryKey: ["forum", "threads"] });
    },
  });
}

export function useAdminDeleteThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("forum_threads").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["forum", "admin", "announcements"] });
      qc.invalidateQueries({ queryKey: ["forum", "threads"] });
    },
  });
}

export const ADMIN_ALL_THREADS_PAGE_SIZE = 25;

export function useAdminAllThreads(params: {
  search?: string;
  categoryId?: string;
  includeHidden?: boolean;
  page?: number;
}) {
  const page = Math.max(0, params.page ?? 0);
  const from = page * ADMIN_ALL_THREADS_PAGE_SIZE;
  const to = from + ADMIN_ALL_THREADS_PAGE_SIZE - 1;
  return useQuery({
    queryKey: ["forum", "admin", "all-threads", params.search ?? "", params.categoryId ?? "", !!params.includeHidden, page],
    queryFn: async () => {
      let q = supabase
        .from("forum_threads")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (params.search && params.search.trim()) q = q.ilike("title", `%${params.search.trim()}%`);
      if (params.categoryId) q = q.eq("category_id", params.categoryId);
      if (!params.includeHidden) q = q.is("hidden_at", null);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as ForumThreadRow[], count: count ?? 0, page, pageSize: ADMIN_ALL_THREADS_PAGE_SIZE };
    },
  });
}

export function useAdminThreadReplies(threadId: string | undefined) {
  return useQuery({
    enabled: !!threadId,
    queryKey: ["forum", "admin", "replies", threadId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("forum_replies")
        .select("*")
        .eq("thread_id", threadId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ForumReplyRow[];
    },
  });
}

export function useAdminDeleteReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; thread_id: string }) => {
      const { error } = await supabase.from("forum_replies").delete().eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["forum", "admin", "replies", vars.thread_id] });
      qc.invalidateQueries({ queryKey: ["forum", "replies", vars.thread_id] });
    },
  });
}

export function useAdminSetThreadHidden() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; hidden: boolean; reason?: string }) => {
      const patch = input.hidden
        ? { hidden_at: new Date().toISOString(), hidden_reason: input.reason ?? "admin: hidden" }
        : { hidden_at: null, hidden_reason: null };
      const { error } = await supabase.from("forum_threads").update(patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["forum", "admin", "all-threads"] });
      qc.invalidateQueries({ queryKey: ["forum", "threads"] });
    },
  });
}

export function useAdminSetReplyHidden() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; thread_id: string; hidden: boolean; reason?: string }) => {
      const patch = input.hidden
        ? { hidden_at: new Date().toISOString(), hidden_reason: input.reason ?? "admin: hidden" }
        : { hidden_at: null, hidden_reason: null };
      const { error } = await supabase.from("forum_replies").update(patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["forum", "admin", "replies", vars.thread_id] });
      qc.invalidateQueries({ queryKey: ["forum", "replies", vars.thread_id] });
    },
  });
}


export function useThreadMedia(threadId: string | undefined, replyIds: string[] = []) {
  return useQuery({
    enabled: !!threadId,
    queryKey: ["forum", "media", threadId, replyIds.join(",")],
    queryFn: async () => {
      const ors: string[] = [`thread_id.eq.${threadId}`];
      if (replyIds.length) ors.push(`reply_id.in.(${replyIds.join(",")})`);
      const { data, error } = await supabase
        .from("forum_media")
        .select("id, thread_id, reply_id, kind, status, mime, owner_id")
        .or(ors.join(","));
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAuthorProfiles(userIds: string[]) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ["forum", "profiles", ids.join(",")],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, display_name, email")
        .in("user_id", ids);
      if (error) throw error;
      const map: Record<string, { name: string }> = {};
      for (const p of data ?? []) {
        const name = (p as any).display_name?.trim()
          || ((p as any).email ? (p as any).email.split("@")[0] : "User");
        map[(p as any).user_id] = { name };
      }
      return map;
    },
  });
}

export function useUserStats(userId?: string) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["forum", "stats", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("my_forum_stats" as any).select("*").eq("user_id", userId!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
