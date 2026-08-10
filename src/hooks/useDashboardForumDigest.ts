import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export type DigestThread = {
  id: string;
  title: string;
  slug: string;
  reply_count: number;
  last_activity_at: string;
  category_id: string;
  category_name?: string;
  category_slug?: string;
};

/**
 * Returns up to 3 threads the user is subscribed to (most recently active),
 * falling back to the latest public threads if the user follows none.
 */
export function useDashboardForumDigest() {
  const { user } = useAuth();
  return useQuery({
    enabled: !!user,
    queryKey: ["forum", "digest", user?.id],
    queryFn: async () => {
      let threadIds: string[] = [];
      if (user) {
        const { data: subs } = await supabase
          .from("forum_subscriptions")
          .select("thread_id")
          .eq("user_id", user.id);
        threadIds = (subs ?? []).map((s: any) => s.thread_id);
      }

      let threadsQuery = supabase
        .from("forum_threads")
        .select("id, title, slug, reply_count, last_activity_at, category_id")
        .order("last_activity_at", { ascending: false })
        .limit(3);

      if (threadIds.length > 0) {
        threadsQuery = threadsQuery.in("id", threadIds);
      }

      const { data: threads } = await threadsQuery;
      const list = (threads ?? []) as DigestThread[];

      // Attach category names
      const catIds = Array.from(new Set(list.map((t) => t.category_id)));
      if (catIds.length) {
        const { data: cats } = await supabase
          .from("forum_categories")
          .select("id, name, slug")
          .in("id", catIds);
        const map = new Map<string, { name: string; slug: string }>();
        (cats ?? []).forEach((c: any) => map.set(c.id, { name: c.name, slug: c.slug }));
        list.forEach((t) => {
          const c = map.get(t.category_id);
          if (c) {
            t.category_name = c.name;
            t.category_slug = c.slug;
          }
        });
      }
      return { threads: list, isFollowing: threadIds.length > 0 };
    },
  });
}
