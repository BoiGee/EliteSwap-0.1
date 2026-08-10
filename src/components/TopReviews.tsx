import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { StarRating } from "./StarRating";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ReviewForm } from "./ReviewForm";

interface Review {
  id: string;
  public_name: string | null;
  rating: number;
  remark: string;
  created_at: string;
}

export function TopReviews() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [avg, setAvg] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);

  const load = async () => {
    // Top 5: highest rating, then most recent
    const { data: top } = await supabase
      .from("reviews_public" as any)
      .select("id, public_name, rating, remark, created_at")
      .order("rating", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5);
    setReviews((top as any) || []);

    // Aggregate stats
    const { data: all } = await supabase
      .from("reviews_public" as any)
      .select("rating");
    const allRows = (all as any as { rating: number }[] | null) || [];
    if (allRows.length > 0) {
      const sum = allRows.reduce((s, r) => s + r.rating, 0);
      setAvg(sum / allRows.length);
      setTotal(allRows.length);
    } else {
      setAvg(null);
      setTotal(0);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <span className="text-xs font-heading font-semibold tracking-[0.2em] uppercase text-muted-foreground">
          What users say
        </span>
        {avg !== null && (
          <div className="flex items-center gap-2">
            <StarRating value={Math.round(avg)} size={14} readOnly />
            <span className="text-xs text-muted-foreground font-heading">
              {avg.toFixed(1)} · {total} review{total === 1 ? "" : "s"}
            </span>
          </div>
        )}
      </div>

      {reviews.length === 0 ? (
        <div className="glass neon-border rounded-2xl p-6 text-center">
          <p className="text-sm text-muted-foreground mb-3">Be the first to leave a review!</p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="neon-glow font-heading">Leave a review</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="font-heading">Leave a review</DialogTitle>
              </DialogHeader>
              <ReviewForm compact onSuccess={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {reviews.map((r) => (
              <div key={r.id} className="glass rounded-xl p-4 text-left space-y-2 flex flex-col">
                <StarRating value={r.rating} size={14} readOnly />
                <p className="text-xs text-foreground/80 line-clamp-4 flex-1">"{r.remark}"</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-heading">
                    — {r.public_name || "Anonymous"}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-heading">
                    {new Date(r.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="neon-glow font-heading">Leave a review</Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="font-heading">Leave a review</DialogTitle>
                </DialogHeader>
                <ReviewForm compact onSuccess={() => setOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button asChild size="sm" variant="outline" className="font-heading">
              <Link to="/reviews">View all reviews →</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
