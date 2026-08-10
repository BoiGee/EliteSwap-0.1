import { useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export function useActivityTracker() {
  const { user } = useAuth();
  const location = useLocation();
  const lastPageRef = useRef<string>("");
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const trackActivity = useCallback(
    (action: string, page?: string, metadata?: Record<string, string | number | boolean>) => {
      if (!user) return;
      // Fire-and-forget: never block UX on analytics insert.
      void supabase
        .from("user_activity_logs")
        .insert([{
          user_id: user.id,
          action,
          page: page || location.pathname,
          metadata: (metadata || {}) as any,
        }])
        .then(() => {}, () => {});
    },
    [user, location.pathname]
  );

  const updatePresence = useCallback(() => {
    if (!user) return;
    void supabase
      .from("profiles")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .then(() => {}, () => {});
  }, [user]);

  // Track page visits
  useEffect(() => {
    if (!user) return;
    const currentPage = location.pathname;
    if (currentPage !== lastPageRef.current) {
      lastPageRef.current = currentPage;
      trackActivity("page_visit", currentPage);
    }
  }, [location.pathname, user, trackActivity]);

  // Heartbeat: update last_seen every 60s
  useEffect(() => {
    if (!user) return;
    updatePresence();
    heartbeatRef.current = setInterval(updatePresence, 60000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [user, updatePresence]);

  // Track tab visibility changes
  useEffect(() => {
    if (!user) return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        trackActivity("tab_focus");
        updatePresence();
      } else {
        trackActivity("tab_blur");
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [user, trackActivity, updatePresence]);

  // Track before unload
  useEffect(() => {
    if (!user) return;
    const handleUnload = () => {
      navigator.sendBeacon(
        `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/user_activity_logs`,
        JSON.stringify({ user_id: user.id, action: "session_end", page: location.pathname })
      );
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [user, location.pathname]);

  return { trackActivity };
}
