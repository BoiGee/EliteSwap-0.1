import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

export interface CountdownAnchor {
  /** Server-authored remaining milliseconds at the moment of `perf`. */
  remainingMs: number;
  /** `performance.now()` captured when `remainingMs` was received. */
  perf: number;
}

interface Props {
  /**
   * Server-authored snapshot of remaining time + the monotonic browser clock
   * value at which it was received. Countdown = remainingMs - (performance.now() - perf).
   * Using `performance.now()` (monotonic) instead of `Date.now()` (wall clock)
   * makes the timer immune to device clock skew, DST jumps, and NTP drift —
   * a device set 2h fast will still show the correct duration.
   */
  anchor: CountdownAnchor | null;
  /** Called once when the timer hits zero. */
  onExpire?: () => void;
}

const formatCountdown = (ms: number) => {
  if (ms <= 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const computeRemaining = (a: CountdownAnchor) => Math.max(0, a.remainingMs - (performance.now() - a.perf));

export function StudioCountdown({ anchor, onExpire }: Props) {
  const [remainingMs, setRemainingMs] = useState<number | null>(anchor ? computeRemaining(anchor) : null);

  useEffect(() => {
    if (!anchor) {
      setRemainingMs(null);
      return;
    }
    let fired = false;
    const tick = () => {
      const next = computeRemaining(anchor);
      setRemainingMs(next);
      if (next <= 0 && !fired) {
        fired = true;
        onExpire?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [anchor, onExpire]);

  if (remainingMs === null) return null;

  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-xs font-semibold ${
        remainingMs <= 300000
          ? "bg-destructive/20 text-destructive animate-pulse"
          : remainingMs <= 900000
            ? "bg-amber-500/20 text-amber-400"
            : "bg-primary/20 text-primary"
      }`}
    >
      <Clock className="w-3 h-3" />
      {formatCountdown(remainingMs)}
    </div>
  );
}
