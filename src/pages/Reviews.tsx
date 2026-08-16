import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { StarRating } from "@/components/StarRating";
import { ReviewForm } from "@/components/ReviewForm";
import AppHeader from "@/components/AppHeader";

interface Review {
  id: string;
  public_name: string | null;
  rating: number;
  remark: string;
  created_at: string;
}

export default function Reviews() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [avg, setAvg] = useState<number | null>(null);
  const [sort, setSort] = useState<"top" | "new">("top");

  const load = async () => {
    setLoading(true);
    const query = supabase
      .from("reviews_public" as any)
      .select("id, public_name, rating, remark, created_at");
    const { data } =
      sort === "top"
        ? await query.order("rating", { ascending: false }).order("created_at", { ascending: false })
        : await query.order("created_at", { ascending: false });
    const list = (data as any as Review[]) || [];
    setReviews(list);
    if (list.length) setAvg(list.reduce((s, r) => s + r.rating, 0) / list.length);
    else setAvg(null);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      <Helmet>
        <title>EliteSwap Reviews — Ratings &amp; User Feedback</title>
        <meta name="description" content={avg !== null ? `EliteSwap has ${avg.toFixed(1)}★ across ${reviews.length} reviews — read what streamers and creators say.` : "Read reviews from EliteSwap users and share your own."} />
        <link rel="canonical" href="https://eliteswap.online/reviews" />
        <meta property="og:title" content="EliteSwap Reviews" />
        <meta property="og:description" content="What streamers and creators say about EliteSwap." />
        <meta property="og:url" content="https://eliteswap.online/reviews" />
        {avg !== null && reviews.length > 0 && (
          <script type="application/ld+json">{JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: "EliteSwap",
            description: "Realtime AI face and character swap tool for OBS Studio.",
            aggregateRating: {
              "@type": "AggregateRating",
              ratingValue: avg.toFixed(1),
              reviewCount: reviews.length,
              bestRating: 5,
              worstRating: 1,
            },
            review: reviews.slice(0, 20).map((r) => ({
              "@type": "Review",
              author: { "@type": "Person", name: r.public_name || "Anonymous" },
              datePublished: r.created_at,
              reviewBody: r.remark,
              reviewRating: {
                "@type": "Rating",
                ratingValue: r.rating,
                bestRating: 5,
                worstRating: 1,
              },
            })),
          })}</script>
        )}
      </Helmet>
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[120px]" />

      <AppHeader />

      <main className="relative z-10 flex-1 max-w-5xl w-full mx-auto px-4 py-8 space-y-8">
        <div className="text-center space-y-3">
          <h1 className="text-4xl md:text-5xl font-heading font-bold text-foreground">All Reviews</h1>
          {avg !== null && (
            <div className="flex items-center justify-center gap-2">
              <StarRating value={Math.round(avg)} size={20} readOnly />
              <span className="text-sm text-muted-foreground font-heading">
                {avg.toFixed(1)} avg · {reviews.length} review{reviews.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <aside className="md:col-span-1 space-y-4">
            <div>
              <h2 className="text-sm font-heading font-semibold tracking-wider uppercase text-muted-foreground mb-3">
                Leave your review
              </h2>
              <ReviewForm onSuccess={load} />
            </div>
          </aside>

          <section className="md:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-heading font-semibold tracking-wider uppercase text-muted-foreground">
                {reviews.length} review{reviews.length === 1 ? "" : "s"}
              </h2>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={sort === "top" ? "default" : "outline"}
                  onClick={() => setSort("top")}
                  className="font-heading"
                >
                  Top rated
                </Button>
                <Button
                  size="sm"
                  variant={sort === "new" ? "default" : "outline"}
                  onClick={() => setSort("new")}
                  className="font-heading"
                >
                  Newest
                </Button>
              </div>
            </div>

            {loading ? (
              <p className="text-center text-muted-foreground text-sm py-12">Loading reviews...</p>
            ) : reviews.length === 0 ? (
              <p className="text-center text-muted-foreground text-sm py-12">
                No reviews yet — be the first!
              </p>
            ) : (
              <div className="space-y-3">
                {reviews.map((r) => (
                  <div key={r.id} className="glass border border-border rounded-xl p-5 space-y-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3">
                        <StarRating value={r.rating} size={16} readOnly />
                        <span className="text-sm font-heading font-semibold text-foreground">
                          {r.public_name || "Anonymous"}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
                      {r.remark}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
