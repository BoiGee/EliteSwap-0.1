import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useAdmin } from "@/hooks/useAdmin";
import { useToast } from "@/hooks/use-toast";

// Tiny ~0.15s beep WAV (440Hz) base64-encoded — keeps bundle small, no asset import
const BEEP_DATA_URI =
  "data:audio/wav;base64,UklGRiQEAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAEAAAAAAcAEAAaACMALABAAFAAYABzAIYAlgCnALsAzgDeAOoA9gAFAQ8BFwEbARsBGAESAQwBBAH3AOYA0gC9AKkAlwCDAG8AWwBHADcAKAAaAA8ABwAAAP3//P/8//7/AAACAAUACAAMABEAFwAfACgAMQA8AEgAVABhAG0AeAB+AIIAhgCJAIoAjwCRAJUAmwCdAJ4AnwCeAJ4AnQCYAJEAhwB7AGwAXwBSAEMAMQAdAAwA+v/o/9P/wf+u/57/jv+B/3X/aP9b/0//Q/82/yj/Hf8U/wn///7y/uX+1/7H/rb+pf6V/oP+cv5h/lH+Qf4z/iX+Gv4P/gT++/3y/ev95f3i/d/93f3c/dz93P3c/dz93P3c/dz93P3c/dz93f3g/eP95v3p/e398P3y/fT99f31/fX99f30/fT98/3y/fL98v3y/fL98v3z/fT99/35/fz9//4D/gj+D/4Y/iT+Mv5C/lP+Zf54/o3+pP67/tT+7v4J/yX/Q/9i/4P/pv/I/+v/AAAUACgAOgBJAFcAYwBuAHcAfwCEAIcAhwCHAIYAggB+AHkAcwBrAGEAVgBJADoAKgAYAAYA9P/i/9D/v/+u/57/jv9//3D/Yf9T/0X/N/8q/x3/EP8E//j+7P7g/tT+yP67/q7+oP6S/oP+c/5j/lL+Qf4w/h/+D/7//e795f3d/dX9zv3I/cP9v/27/bj9tf2y/bD9rv2s/ar9qf2o/af9pv2l/aT9o/2j/aL9of2h/aH9of2h/aL9o/2k/ab9qP2q/a39sP2z/bf9u/3A/cb9zP3T/dr94f3p/fH9+f0B/gn+EP4X/h7+I/4n/iv+Lv4w/jH+Mv4y/jH+L/4t/ir+Jv4i/h3+GP4S/gz+Bf7+/ff97/3o/eD92P3R/cn9wv27/bP9rP2k/Z39lf2N/YX9ff11/Wz9ZP1c/VT9TP1E/T39N/0w/Sr9JP0e/Rj9E/0O/Qn9Bf0B/f78+vz3/PT88vzx/PD87/zw/PH88vz0/Pf8+vz9/AH9Bf0K/Q/9Ff0a/SD9Jv0t/TT9O/1C/Un9UP1Y/V/9Z/1u/Xb9ff2E/Yz9k/2a/aH9p/2t/bP9uf2+/cP9yP3M/dD90/3W/dn92/3d/d/94P3h/eL94v3i/eL94f3g/d/93P3a/df91P3R/c39yf3F/cD9u/22/bH9rP2n/aL9nf2X/ZL9jf2I/YT9f/17/Xj9dP1x/W/9bP1q/Wn9aP1n/Wf9aP1p/Wr9bP1u/XH9dP14/Xz9gf2G/Yv9kf2X/Z39o/2q/bH9uP2//cb9zv3V/dz94/3q/fH9+P3//gX+C/4R/hb+G/4f/iL+Jf4n/in+Kv4q/in+KP4n/iX+Iv4f/hv+F/4S/g3+CP4D/v3++P3y/ez95v3g/dr91P3O/cn9w/2+/bn9tP2w/az9qP2k/aH9nv2c/Zr9mP2X/Zb9lf2V/ZX9lf2W/Zf9mf2b/Z39oP2j/ab9qv2u/bL9tv26/b/9w/3I/cz90f3V/dr93v3i/eb96v3t/fH99P32/fn9+/39/f7+/wAAAQEBAQEBAQEAAP/+/v38/Pv6+fj39vXz8vDu7Onm5OHe29jUz8vGwby4tLCspaCYj4Z+dWtgVUg7LR8RAfDg0MGyo5WHe3FpYltVUE9PUFFTV1xkbXiDjpijra235L/Ix9HX3eDk5+nq6u3y+P8GDhYeJjA5Q01ZZHB7iJSfqrTAytLY3eHj5OTj4t/d2dXQy8XAurOsppyTio";

const PERMISSION_LS_KEY = "chat-notif-permission-asked";

function lastReadKey(conversationId: string) {
  return `chat-last-read-${conversationId}`;
}

export function getLastRead(conversationId: string): number {
  try {
    const v = localStorage.getItem(lastReadKey(conversationId));
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

export function markConversationRead(conversationId: string) {
  try {
    localStorage.setItem(lastReadKey(conversationId), String(Date.now()));
    window.dispatchEvent(new CustomEvent("chat-read-updated", { detail: { conversationId } }));
  } catch {
    // ignore
  }
}

interface SupportMessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  is_admin: boolean;
  content: string | null;
  file_url: string | null;
  created_at: string;
}

function playBeep() {
  try {
    const a = new Audio(BEEP_DATA_URI);
    a.volume = 0.4;
    void a.play().catch(() => {});
  } catch {
    // ignore
  }
}

function fireBrowserNotification(title: string, body: string, tag: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    new Notification(title, { body, tag });
  } catch {
    // ignore
  }
}

/**
 * Subscribes to support_messages and surfaces notifications when:
 * - regular user receives an admin message
 * - admin receives a message from any user (not their own)
 *
 * Maintains an in-memory unread count map keyed by conversation_id,
 * derived from localStorage (chat-last-read-<id>) + new INSERTs.
 */
export function useSupportChatNotifications() {
  const { user } = useAuth();
  const { isAdmin } = useAdmin();
  const { toast } = useToast();
  const [unreadByConv, setUnreadByConv] = useState<Record<string, number>>({});
  const seenIds = useRef<Set<string>>(new Set());

  const addUnread = useCallback((convId: string) => {
    setUnreadByConv((prev) => ({ ...prev, [convId]: (prev[convId] ?? 0) + 1 }));
  }, []);

  const recomputeFromStorage = useCallback((convId: string) => {
    setUnreadByConv((prev) => {
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  }, []);

  // Listen for "mark read" events to clear badges live
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ conversationId: string }>;
      if (ce.detail?.conversationId) recomputeFromStorage(ce.detail.conversationId);
    };
    window.addEventListener("chat-read-updated", handler);
    return () => window.removeEventListener("chat-read-updated", handler);
  }, [recomputeFromStorage]);

  // Initial load — count unread per conversation since last read
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadInitial = async () => {
      // Fetch recent messages this user can see (RLS handles user vs admin scope)
      const { data } = await supabase
        .from("support_messages")
        .select("id, conversation_id, sender_id, is_admin, content, file_url, created_at")
        .order("created_at", { ascending: false })
        .limit(200);

      if (cancelled || !data) return;

      const counts: Record<string, number> = {};
      for (const m of data as SupportMessageRow[]) {
        // Skip messages the current user sent themselves
        if (m.sender_id === user.id) continue;
        // For non-admin users: only count admin messages
        if (!isAdmin && !m.is_admin) continue;

        const lastRead = getLastRead(m.conversation_id);
        const created = new Date(m.created_at).getTime();
        if (created > lastRead) {
          counts[m.conversation_id] = (counts[m.conversation_id] ?? 0) + 1;
        }
        seenIds.current.add(m.id);
      }
      setUnreadByConv(counts);
    };

    loadInitial();
    return () => {
      cancelled = true;
    };
  }, [user, isAdmin]);

  // Realtime subscription
  useEffect(() => {
    if (!user) return;

    // Unique channel name per mount so multiple consumers (SupportChat + Admin) don't clash
    const channelName = `support-msg-notifier-${user.id}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages" },
        (payload) => {
          const m = payload.new as SupportMessageRow;
          if (!m || seenIds.current.has(m.id)) return;
          seenIds.current.add(m.id);

          // Skip own messages
          if (m.sender_id === user.id) return;
          // Non-admin users only get notified about admin messages
          if (!isAdmin && !m.is_admin) return;

          // If user already has the conversation marked read more recently than this msg, skip
          const lastRead = getLastRead(m.conversation_id);
          const created = new Date(m.created_at).getTime();
          if (created <= lastRead) return;

          addUnread(m.conversation_id);

          const body = m.content
            ? m.content.slice(0, 80)
            : m.file_url
            ? "Sent a file 📎"
            : "New message";

          const title = isAdmin ? "New support message 💬" : "Elite Swap support 💬";

          toast({ title, description: body });
          playBeep();
          fireBrowserNotification(title, body, m.conversation_id);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, isAdmin, addUnread, toast]);

  const totalUnread = Object.values(unreadByConv).reduce((a, b) => a + b, 0);

  return { unreadByConv, totalUnread };
}

/** Ask the user once for desktop notification permission. */
export async function requestNotificationPermissionOnce(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    if (localStorage.getItem(PERMISSION_LS_KEY) === "1") return Notification.permission;
    localStorage.setItem(PERMISSION_LS_KEY, "1");
  } catch {
    // ignore
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return "default";
  }
}

export function hasAskedNotificationPermission(): boolean {
  try {
    return localStorage.getItem(PERMISSION_LS_KEY) === "1";
  } catch {
    return true;
  }
}
