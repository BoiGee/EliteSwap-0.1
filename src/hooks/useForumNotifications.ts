import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export type ForumNotification = {
  id: string;
  user_id: string;
  kind: string;
  target_kind: "thread" | "reply" | "media" | null;
  target_id: string | null;
  actor_id: string | null;
  data: any;
  read_at: string | null;
  created_at: string;
};

export function useForumNotifications(limit = 10) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const query = useQuery({
    enabled: !!user,
    queryKey: ["forum", "notifications", user?.id, limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("forum_notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as ForumNotification[];
    },
  });

  // Realtime
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`forum-notif-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "forum_notifications", filter: `user_id=eq.${user.id}` },
        () => {
          qc.invalidateQueries({ queryKey: ["forum", "notifications"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, qc]);

  const unreadCount = (query.data ?? []).filter((n) => !n.read_at).length;

  const markAllRead = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const { error } = await supabase
        .from("forum_notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null)
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forum", "notifications"] }),
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("forum_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forum", "notifications"] }),
  });

  return { ...query, unreadCount, markAllRead, markRead };
}
