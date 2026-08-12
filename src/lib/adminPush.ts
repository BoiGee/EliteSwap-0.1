// Client helpers for registering the admin service worker and Web Push subscription.
import { supabase } from "@/integrations/supabase/client";

// Regenerated 2026-08-12 — the previous key here didn't match the server-side
// VAPID_PRIVATE_KEY edge function secret (most likely a leftover from the
// platform migration), which made every push send fail with Apple's push
// service returning 400 VapidPkHashMismatch for every single subscriber.
// This constant and the VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY secrets used by
// the send-admin-push edge function must always be the two halves of the
// same key pair — changing one without the other silently breaks every
// existing subscription the same way.
export const VAPID_PUBLIC_KEY =
  "BIa4WWh6M-JkB5xAEm3mpthm079Z7_sd5AK2xxKRr_sGFpInu-ZfEoxCxZ3-92Ngjzbe9JU8OMEO8mDOKfJWINw";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPreviewOrDev(): boolean {
  if (typeof window === "undefined") return true;
  try {
    if (window.self !== window.top) return true;
  } catch { return true; }
  const h = window.location.hostname;
  if (window.location.search.includes("sw=off")) return true;
  if (h.startsWith("id-preview--") || h.startsWith("preview--")) return true;
  if (h === "lovableproject.com" || h.endsWith(".lovableproject.com")) return true;
  if (h === "lovableproject-dev.com" || h.endsWith(".lovableproject-dev.com")) return true;
  if (h === "beta.lovable.dev" || h.endsWith(".beta.lovable.dev")) return true;
  return false;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerAdminServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported() || isPreviewOrDev()) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (e) {
    console.warn("[adminPush] SW register failed", e);
    return null;
  }
}

export async function subscribeAdminPush(userId: string): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (isPreviewOrDev()) return { ok: false, reason: "preview" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };

  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };
  }

  const reg = await registerAdminServiceWorker();
  if (!reg) return { ok: false, reason: "sw_failed" };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
      });
    } catch (e) {
      console.warn("[adminPush] subscribe failed", e);
      return { ok: false, reason: "subscribe_failed" };
    }
  }

  const json: any = sub.toJSON();
  const endpoint = json.endpoint as string;
  const p256dh = json.keys?.p256dh as string;
  const auth = json.keys?.auth as string;
  if (!endpoint || !p256dh || !auth) return { ok: false, reason: "no_keys" };

  const { error } = await supabase
    .from("admin_push_subscriptions")
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: navigator.userAgent,
        last_seen_at: new Date().toISOString(),
        failure_count: 0,
      },
      { onConflict: "endpoint" },
    );
  if (error) {
    console.warn("[adminPush] upsert failed", error);
    return { ok: false, reason: "db_failed" };
  }
  return { ok: true };
}

export async function unsubscribeAdminPush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await supabase.from("admin_push_subscriptions").delete().eq("endpoint", endpoint);
    }
  } catch (e) {
    console.warn("[adminPush] unsubscribe failed", e);
  }
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) && !("MSStream" in window);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS
  if ((navigator as any).standalone) return true;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}
