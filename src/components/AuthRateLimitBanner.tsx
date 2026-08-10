import { useEffect, useState, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

/**
 * Shows a dismissible top banner whenever the auth refresh endpoint
 * is being rate-limited (HTTP 429). Driven by CustomEvents fired from
 * installAuthRetry().
 *
 * - Hidden on /studio and /obs-output so it can't cover the studio UI.
 * - Dismissal persists for 30 minutes via localStorage so it doesn't
 *   pop right back up on the next 429 burst.
 */
const DISMISSED_AT_KEY = "eliteswap-rate-limit-banner-dismissed-at";
const DISMISS_COOLDOWN_MS = 30 * 60 * 1000;

const isQuietRoute = () => {
  if (typeof window === "undefined") return false;
  const p = window.location.pathname || "";
  return p.startsWith("/studio") || p.startsWith("/obs-output");
};

const isDismissed = () => {
  try {
    const at = Number(localStorage.getItem(DISMISSED_AT_KEY) || "0");
    return Date.now() - at < DISMISS_COOLDOWN_MS;
  } catch {
    return false;
  }
};

export default function AuthRateLimitBanner() {
  const [visible, setVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    const onLimited = (e: CustomEvent<{ retryInMs: number; attempt: number }>) => {
      if (isQuietRoute() || isDismissed()) return;
      setVisible(true);
      const sec = Math.ceil(e.detail.retryInMs / 1000);
      setSecondsLeft(sec);
      if (tickRef.current) window.clearInterval(tickRef.current);
      tickRef.current = window.setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1) {
            if (tickRef.current) window.clearInterval(tickRef.current);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    };
    const onCleared = () => {
      setVisible(false);
      setSecondsLeft(0);
      if (tickRef.current) window.clearInterval(tickRef.current);
    };

    window.addEventListener("auth:rate-limited", onLimited as EventListener);
    window.addEventListener("auth:rate-limit-cleared", onCleared as EventListener);
    return () => {
      window.removeEventListener("auth:rate-limited", onLimited as EventListener);
      window.removeEventListener("auth:rate-limit-cleared", onCleared as EventListener);
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="w-full bg-amber-500/15 border-b border-amber-500/40 text-amber-100 px-4 py-2 text-sm flex items-center gap-3"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="flex-1">
        <strong className="font-semibold">Too many active sessions.</strong>{" "}
        We're pausing to avoid signing you out
        {secondsLeft > 0 ? ` (retrying in ${secondsLeft}s)` : ""}. Please
        close any extra EliteSwap tabs or devices you have open.
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
          } catch {}
          setVisible(false);
        }}
        className="p-1 hover:bg-amber-500/20 rounded"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
