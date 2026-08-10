import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

const EMOJIS = ["👍", "👎", "❤️", "🔥", "🎉", "😂", "🙏"];

export default function ReactionBar({
  targetKind,
  targetId,
}: { targetKind: "thread" | "reply"; targetId: string }) {
  const { user } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [mine, setMine] = useState<Set<string>>(new Set());

  async function load() {
    // Public-safe counts via RPC (no user identities exposed)
    const { data: countRows } = await supabase.rpc("forum_reaction_counts", {
      _target_kind: targetKind,
      _target_id: targetId,
    });
    const c: Record<string, number> = {};
    for (const r of (countRows ?? []) as Array<{ emoji: string; count: number }>) {
      c[r.emoji] = Number(r.count) || 0;
    }
    setCounts(c);

    // Only the current user's own reactions (RLS-restricted)
    if (user) {
      const { data: mineRows } = await supabase
        .from("forum_reactions")
        .select("emoji")
        .eq("target_kind", targetKind)
        .eq("target_id", targetId)
        .eq("user_id", user.id);
      setMine(new Set(((mineRows ?? []) as any[]).map((r) => r.emoji)));
    } else {
      setMine(new Set());
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [targetId, user?.id]);

  async function toggle(emoji: string) {
    if (!user) { toast.error("Sign in to react"); return; }
    if (mine.has(emoji)) {
      const { error } = await supabase.from("forum_reactions")
        .delete().eq("target_kind", targetKind).eq("target_id", targetId).eq("user_id", user.id).eq("emoji", emoji);
      if (error) toast.error(error.message); else load();
    } else {
      const { error } = await supabase.from("forum_reactions").insert({
        target_kind: targetKind, target_id: targetId, user_id: user.id, emoji,
      });
      if (error) toast.error(error.message); else load();
    }
  }

  return (
    <div className="flex items-center gap-1 mt-2 flex-wrap">
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => toggle(e)}
          className={`text-xs px-2 py-1 rounded-full border transition ${
            mine.has(e)
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:bg-muted/30"
          }`}
        >
          {e} {counts[e] || 0}
        </button>
      ))}
    </div>
  );
}
