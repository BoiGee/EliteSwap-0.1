// Real-time admin alert hub: plays distinct sounds and shows toasts when
// payments, trial purchases, support messages, or forum reports arrive.
// Meant to be mounted once on the admin dashboard.
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

type SoundKind = "payment" | "trial" | "support" | "forum";

// Small inline WebAudio "beeps" so we don't need to ship binary assets.
// Different frequency + pattern per category so admins learn to distinguish
// them audibly.
const PATTERNS: Record<SoundKind, Array<{ freq: number; ms: number; gap?: number }>> = {
  payment: [{ freq: 880, ms: 140 }, { freq: 1320, ms: 220, gap: 60 }],
  trial:   [{ freq: 660, ms: 120 }, { freq: 990, ms: 160, gap: 40 }],
  support: [{ freq: 740, ms: 180 }],
  forum:   [{ freq: 520, ms: 90 }, { freq: 520, ms: 90, gap: 80 }, { freq: 520, ms: 200, gap: 80 }],
};

function makeBeepPlayer() {
  let ctx: AudioContext | null = null;
  let unlocked = false;

  const unlock = () => {
    if (unlocked) return;
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext);
      if (!AC) return;
      ctx = new AC();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      unlocked = true;
    } catch {}
  };

  const play = async (kind: SoundKind) => {
    if (!unlocked) return;
    if (!ctx) return;
    const pattern = PATTERNS[kind];
    let t = ctx.currentTime;
    for (const step of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = step.freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + step.ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + step.ms / 1000 + 0.02);
      t += step.ms / 1000 + (step.gap ?? 20) / 1000;
    }
  };

  return { unlock, play, isUnlocked: () => unlocked };
}

export function useAdminAlerts(enabled: boolean) {
  const { toast } = useToast();
  const player = useRef(makeBeepPlayer());
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // Unlock audio on first user gesture
  useEffect(() => {
    if (!enabled) return;
    const handler = () => {
      player.current.unlock();
      if (player.current.isUnlocked()) setAudioUnlocked(true);
    };
    window.addEventListener("pointerdown", handler, { once: true });
    window.addEventListener("keydown", handler, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const fire = (kind: SoundKind, title: string, description?: string) => {
      player.current.play(kind);
      toast({ title, description });
    };

    // Realtime UPDATE events carry only the new row (these tables don't publish the old one),
    // so "old.status !== new.status" was always true: every write to a payment re-announced its
    // status with a sound. Each id + status is announced once per session instead.
    const announced = new Set<string>();
    const firstTime = (id: string | undefined, status: string) => {
      const k = `${id}:${status}`;
      if (!id || announced.has(k)) return false;
      announced.add(k);
      return true;
    };

    const channel = supabase
      .channel("admin-alerts-hub")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payments" },
        (p: any) => {
          const amt = p.new?.amount_usd ? `$${p.new.amount_usd}` : "";
          fire("payment", "New payment submitted", `${amt} • ${p.new?.payment_method ?? ""}`);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "payments" },
        (p: any) => {
          const status = p.new?.status;
          if ((status === "confirmed" || status === "rejected") && firstTime(p.new?.id, status)) {
            fire("payment", `Payment ${status}`, p.new?.tx_hash ?? "");
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trial_purchases" },
        (p: any) => {
          fire("trial", "New $10 trial purchase", p.new?.provider_reference ?? "");
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "trial_purchases" },
        (p: any) => {
          // Trials are "confirmed" when paid (there is no "paid" status, so this never fired).
          const status = p.new?.status;
          const justConfirmed = p.new?.confirmed_at && Date.now() - new Date(p.new.confirmed_at).getTime() < 10 * 60_000;
          if (status === "confirmed" && justConfirmed && firstTime(p.new?.id, status)) {
            fire("trial", "Trial payment confirmed", p.new?.provider_reference ?? "");
          } else if (status === "failed" && firstTime(p.new?.id, status)) {
            fire("trial", "Trial payment failed", p.new?.provider_reference ?? "");
          } else if (p.new?.needs_admin_review && firstTime(p.new?.id, "review")) {
            fire("trial", "Trial payment needs review", p.new?.provider_reference ?? "");
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "payment_verification_attempts" },
        (p: any) => {
          if (p.new?.reason === "user_notified_underpaid") {
            fire("payment", "Payment underpaid: needs review", `payment ${p.new?.payment_id ?? ""}`);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages" },
        (p: any) => {
          if (p.new?.is_admin) return;
          fire("support", "New support message", (p.new?.content ?? "").slice(0, 80));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "forum_reports" },
        (p: any) => {
          fire("forum", "New forum report", p.new?.reason ?? "");
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "reviews" },
        (p: any) => {
          const stars = "⭐".repeat(Math.max(1, Math.min(5, p.new?.rating ?? 0)));
          fire("forum", "New review submitted", `${stars} ${(p.new?.remark ?? "").slice(0, 80)}`);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "account_deletion_requests" },
        (p: any) => {
          fire("support", "Account deletion requested", p.new?.email ?? "");
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, toast]);

  return { audioUnlocked };
}
