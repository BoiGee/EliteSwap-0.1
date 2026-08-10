import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { StarRating } from "@/components/StarRating";

interface Review {
  id: string;
  user_id: string;
  display_name: string | null;
  rating: number;
  remark: string;
  is_approved: boolean;
  created_at: string;
}

interface ReviewManagerProps {
  emailForUser: (userId: string) => string;
}

type Filter = "all" | "approved" | "hidden";

export default function ReviewManager({ emailForUser }: ReviewManagerProps) {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("reviews")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      setReviews(data || []);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleApprove = async (r: Review) => {
    const { error } = await supabase
      .from("reviews")
      .update({ is_approved: !r.is_approved })
      .eq("id", r.id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: r.is_approved ? "Review hidden 🙈" : "Review approved ✅" });
      load();
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this review permanently?")) return;
    const { error } = await supabase.from("reviews").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Review deleted 🗑️" });
      load();
    }
  };

  const filtered = reviews.filter((r) =>
    filter === "all" ? true : filter === "approved" ? r.is_approved : !r.is_approved
  );

  const counts = {
    all: reviews.length,
    approved: reviews.filter((r) => r.is_approved).length,
    hidden: reviews.filter((r) => !r.is_approved).length,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-heading font-bold text-foreground">Moderate Reviews</h2>
        <div className="flex gap-2">
          {(["all", "approved", "hidden"] as Filter[]).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              onClick={() => setFilter(f)}
              className="font-heading text-xs capitalize"
            >
              {f} ({counts[f]})
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviews in this view.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <div key={r.id} className="glass rounded-xl px-4 py-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <StarRating value={r.rating} size={14} readOnly />
                  <span className="font-heading font-semibold text-foreground">
                    {r.display_name || "Anonymous"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {emailForUser(r.user_id)}
                  </span>
                  <span
                    className={`text-xs font-heading font-semibold px-2 py-0.5 rounded-full ${
                      r.is_approved
                        ? "bg-primary/20 text-primary"
                        : "bg-amber-500/20 text-amber-400"
                    }`}
                  >
                    {r.is_approved ? "Visible" : "Hidden"}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-foreground/85 whitespace-pre-wrap">{r.remark}</p>
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleApprove(r)}
                  className="font-heading text-xs"
                >
                  {r.is_approved ? "Hide" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => remove(r.id)}
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 font-heading text-xs"
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
