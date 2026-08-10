import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { toast } from "sonner";

export type AppNotification = {
  id: string;
  user_id: string;
  category: "payment" | "security" | "key" | "admin_post" | "forum" | "system";
  kind: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  body: string | null;
  href: string | null;
  target_kind: string | null;
  target_id: string | null;
  actor_id: string | null;
  data: any;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
};

export function useAppNotifications(limit = 25) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const seenIds = useRef<Set<string>>(new Set());
  const instanceId = useRef<string>(Math.random().toString(36).slice(2, 10));

  const query = useQuery({
    enabled: !!user,
    queryKey: ["app_notifications", user?.id, limit],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("app_notifications")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      const rows = (data ?? []) as AppNotification[];
      rows.forEach((r) => seenIds.current.add(r.id));
      return rows;
    },
  });

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`app-notif-${user.id}-${instanceId.current}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "app_notifications", filter: `user_id=eq.${user.id}` },
        (payload: any) => {
          const row = payload.new as AppNotification;
          if (!seenIds.current.has(row.id)) {
            seenIds.current.add(row.id);
            // Live toast
            const fn = row.severity === "critical" || row.severity === "warning"
              ? toast.warning
              : row.severity === "success"
              ? toast.success
              : toast.info;
            fn(row.title, { description: row.body ?? undefined, duration: 6000 });
          }
          qc.invalidateQueries({ queryKey: ["app_notifications"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "app_notifications", filter: `user_id=eq.${user.id}` },
        () => qc.invalidateQueries({ queryKey: ["app_notifications"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, qc]);

  const items = query.data ?? [];
  const unread = items.filter((n) => !n.read_at && !n.dismissed_at);
  const unreadCount = unread.length;
  const hasUrgent = unread.some((n) => n.severity === "warning" || n.severity === "critical");
  const adminPosts = unread.filter((n) => n.category === "admin_post");

  // Document title badge
  useEffect(() => {
    const original = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = unreadCount > 0 ? `(${unreadCount}) ${original}` : original;
    return () => {
      document.title = document.title.replace(/^\(\d+\)\s*/, "");
    };
  }, [unreadCount]);

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("app_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_notifications"] }),
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const { error } = await (supabase as any)
        .from("app_notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null)
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_notifications"] }),
  });

  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("app_notifications")
        .update({ dismissed_at: new Date().toISOString(), read_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_notifications"] }),
  });

  return { ...query, items, unreadCount, hasUrgent, adminPosts, markRead, markAllRead, dismiss };
}
