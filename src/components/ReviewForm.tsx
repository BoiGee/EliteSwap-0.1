import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StarRating } from "./StarRating";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";

const reviewSchema = z.object({
  display_name: z.string().trim().min(1, "Name required").max(60, "Max 60 characters"),
  rating: z.number().int().min(1, "Pick a rating").max(5),
  remark: z.string().trim().min(5, "Tell us a bit more (min 5 chars)").max(500, "Max 500 characters"),
});

interface ReviewFormProps {
  onSuccess?: () => void;
  compact?: boolean;
}

export function ReviewForm({ onSuccess, compact }: ReviewFormProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [rating, setRating] = useState(0);
  const [remark, setRemark] = useState("");
  const [displayName, setDisplayName] = useState(
    user?.user_metadata?.display_name || user?.email?.split("@")[0] || ""
  );
  const [submitting, setSubmitting] = useState(false);

  if (!user) {
    return (
      <div className={`glass neon-border rounded-2xl ${compact ? "p-5" : "p-6"} text-center space-y-3`}>
        <p className="text-sm text-muted-foreground">Sign in to leave a review.</p>
        <Button onClick={() => navigate("/auth")} className="neon-glow font-heading">
          Sign in to review
        </Button>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = reviewSchema.safeParse({ display_name: displayName, rating, remark });
    if (!parsed.success) {
      toast({ title: "Check your input", description: parsed.error.issues[0].message, variant: "destructive" });
      return;
    }
    setSubmitting(true);
    const { data: inserted, error } = await supabase.from("reviews").insert({
      user_id: user.id,
      display_name: parsed.data.display_name,
      rating: parsed.data.rating,
      remark: parsed.data.remark,
    }).select("id").maybeSingle();
    setSubmitting(false);
    if (error) {
      toast({ title: "Could not submit", description: error.message, variant: "destructive" });
      return;
    }
    if (inserted?.id) {
      supabase.functions.invoke("notify-admin-event", {
        body: { event: "review", reviewId: inserted.id },
      }).catch(() => {});
    }
    toast({ title: "Thanks for your review! ⭐", description: "It's now live on the homepage." });
    setRating(0);
    setRemark("");
    onSuccess?.();
  };

  return (
    <form onSubmit={handleSubmit} className={`glass neon-border rounded-2xl ${compact ? "p-5" : "p-6"} space-y-4 text-left`}>
      <div className="space-y-2">
        <Label htmlFor="rev-name" className="font-heading">Display name</Label>
        <Input
          id="rev-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={60}
          placeholder="How should we credit you?"
        />
      </div>
      <div className="space-y-2">
        <Label className="font-heading">Your rating</Label>
        <StarRating value={rating} onChange={setRating} size={28} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="rev-remark" className="font-heading">Your remark</Label>
        <Textarea
          id="rev-remark"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          maxLength={500}
          rows={4}
          placeholder="Share your experience with Elite Swap..."
        />
        <p className="text-xs text-muted-foreground text-right">{remark.length}/500</p>
      </div>
      <Button type="submit" disabled={submitting} className="w-full neon-glow font-heading font-semibold">
        {submitting ? "Submitting..." : "Post review ⭐"}
      </Button>
    </form>
  );
}
