import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";

interface Props {
  /** Server-authored remaining milliseconds for the key. Updated live server-side by the 2s heartbeat. */
  remainingMs: number | null | undefined;
  /** ISO timestamp when an active studio session started, if any. Only used to detect a live session. */
  activeSessionStartedAt: string | null | undefined;
  /** Fallback hard expiry for legacy keys without remaining_ms tracking. */
  expiresAt: string | null | undefined;
  /** Whether the key is active. Inactive/exhausted keys show a dim chip. */
  isActive: boolean;
}

const formatCountdown = (ms: number) => {
  if (ms <= 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/**
 * Shows time remaining on a user's API key. Uses `performance.now()` (monotonic)
 * instead of `Date.now()` (wall clock) so device clock skew — a phone/PC set an
 * hour fast or slow — no longer inflates or shrinks the displayed duration.
 *
 * Server-side, the 2s heartbeat keeps `remainingMs` fresh during live sessions,
 * so we simply re-anchor whenever the prop changes.
 */
export function ApiKeyTimer({ remainingMs, activeSessionStartedAt, expiresAt, isActive }: Props) {
  // Snapshot the incoming remainingMs against a monotonic clock reading.
  // Re-anchor every time the server-side value updates (heartbeat / re-fetch).
  const anchorRef = useRef<{ ms: number; perf: number } | null>(null);
  const [displayMs, setDisplayMs] = useState<number | null>(null);
  const hasLiveSession = !!activeSessionStartedAt;

  useEffect(() => {
    if (remainingMs != null) {
      anchorRef.current = { ms: remainingMs, perf: performance.now() };
    } else if (expiresAt) {
      // Legacy fallback: convert absolute expiry into a duration once, then
      // count that duration down monotonically. Note: this still trusts the
      // client wall clock at the moment of load, but no worse than before.
      const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      anchorRef.current = { ms, perf: performance.now() };
    } else {
      anchorRef.current = null;
    }

    const compute = () => {
      const a = anchorRef.current;
      if (!a) return null;
      const elapsed = hasLiveSession ? performance.now() - a.perf : 0;
      return Math.max(0, a.ms - elapsed);
    };
    setDisplayMs(compute());
    const id = setInterval(() => setDisplayMs(compute()), 1000);
    return () => clearInterval(id);
  }, [remainingMs, activeSessionStartedAt, expiresAt, hasLiveSession]);

  if (displayMs === null) return null;

  const exhausted = displayMs <= 0 || !isActive;
  const tone = exhausted
    ? "bg-muted/40 text-muted-foreground"
    : displayMs <= 5 * 60 * 1000
      ? "bg-destructive/20 text-destructive animate-pulse"
      : displayMs <= 15 * 60 * 1000
        ? "bg-amber-500/20 text-amber-400"
        : "bg-primary/20 text-primary";

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-xs font-semibold ${tone}`}
      title={
        hasLiveSession
          ? "Studio session in progress — time is ticking down live"
          : "Remaining time on this API key"
      }
    >
      <Clock className="w-3 h-3" />
      {exhausted ? "Exhausted" : formatCountdown(displayMs)}
      {hasLiveSession && !exhausted && (
        <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      )}
    </div>
  );
}
