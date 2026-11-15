import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Check, MessageCircle } from "lucide-react";
import {
  attachResellerCodeManual,
  attachResellerMessage,
  fmtUsd,
  rpc,
  setPendingResellerCode,
  type Storefront,
} from "@/lib/reseller";

/** Public storefront at /r/:code: the reseller's prices and contact, and a sign-up that links to him. */
export default function ResellerLanding() {
  const { code = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [store, setStore] = useState<Storefront | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    rpc("reseller_public_profile", { p_code: code }).then(({ data }) => {
      setStore((data as unknown as Storefront) ?? null);
      setLoading(false);
    });
  }, [code]);

  const join = async () => {
    if (!store) return;
    if (!user) {
      setPendingResellerCode(store.code);
      navigate("/auth");
      return;
    }
    setJoining(true);
    const res = await attachResellerCodeManual(store.code);
    setJoining(false);
    const msg = attachResellerMessage(res) ?? { title: "Couldn't link this reseller", description: "Please try again." };
    toast({ ...msg, variant: res.ok ? undefined : "destructive" });
    if (res.ok || res.reason === "already_linked") navigate("/dashboard");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <AppHeader />
        <div className="flex-1 flex items-center justify-center text-muted-foreground font-heading">Loading…</div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="min-h-screen flex flex-col">
        <AppHeader />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="glass border border-border rounded-2xl p-8 text-center space-y-3 max-w-sm">
            <h1 className="text-xl font-heading font-bold text-foreground">This link isn't active</h1>
            <p className="text-sm text-muted-foreground">The reseller you're looking for isn't available right now.</p>
            <Button onClick={() => navigate("/pricing")} className="font-heading">See Elite Swap plans</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>{`Elite Swap via ${store.display_name}`}</title>
      </Helmet>
      <AppHeader />
      <main className="flex-1 p-4 md:p-8 max-w-5xl w-full mx-auto space-y-8">
        <div className="text-center space-y-3">
          <p className="text-xs font-heading uppercase tracking-wider text-primary">Authorised Elite Swap reseller</p>
          <h1 className="text-3xl md:text-4xl font-heading font-bold text-foreground">Elite Swap via {store.display_name}</h1>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Real-time AI character swap for your streams and calls. Buy your minutes from {store.display_name}; they
            record your purchase and your studio key appears in your Elite Swap dashboard straight away.
          </p>
          {store.contact && (
            <p className="inline-flex items-center gap-2 text-sm font-heading text-foreground bg-primary/10 border border-primary/30 rounded-full px-4 py-1.5">
              <MessageCircle className="w-4 h-4 text-primary" /> {store.contact}
            </p>
          )}
        </div>

        {store.plans.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {store.plans.map((p) => (
              <div key={p.plan_id} className="glass border border-border rounded-2xl p-5 space-y-4 flex flex-col">
                <div className="space-y-1">
                  <h2 className="text-lg font-heading font-bold text-foreground">{p.name}</h2>
                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                </div>
                <div className="space-y-1">
                  {p.monthly_price_usd != null && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-heading font-bold text-foreground">{fmtUsd(p.monthly_price_usd)}</span>
                      <span className="text-xs text-muted-foreground">{p.minutes} studio minutes</span>
                    </div>
                  )}
                  {p.annual_price_usd != null && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-base font-heading font-semibold text-foreground">{fmtUsd(p.annual_price_usd)}</span>
                      <span className="text-xs text-muted-foreground">annual · {(p.minutes * 12).toLocaleString()} minutes</span>
                    </div>
                  )}
                </div>
                {p.features && p.features.length > 0 && (
                  <ul className="space-y-1.5 text-xs text-foreground/80 flex-1">
                    {p.features.map((f) => (
                      <li key={f} className="flex gap-2"><Check className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-sm text-muted-foreground">{store.display_name} hasn't listed prices yet. Contact them for a quote.</p>
        )}

        <div className="glass border border-primary/30 rounded-2xl p-6 text-center space-y-3 max-w-xl mx-auto">
          <h2 className="text-lg font-heading font-semibold text-foreground">
            {user ? `Buy through ${store.display_name}` : "Create your Elite Swap account"}
          </h2>
          <ol className="text-sm text-muted-foreground space-y-1 text-left max-w-sm mx-auto list-decimal pl-5">
            <li>{user ? "Link your account below." : "Sign up (or sign in) through this page."}</li>
            <li>Pay {store.display_name} for the plan you want{store.contact ? ` (${store.contact})` : ""}.</li>
            <li>They record your purchase, and your key appears in your dashboard.</li>
          </ol>
          <Button onClick={join} disabled={joining} className="font-heading bg-primary text-primary-foreground hover:bg-primary/90 px-8">
            {joining ? "Linking…" : user ? `Link my account to ${store.display_name}` : "Get started"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Linking means you buy plans through {store.display_name}, not from Elite Swap directly. They'll see your email
            and how many minutes you have left. The $10 trial is still available from Elite Swap.
          </p>
        </div>
      </main>
    </div>
  );
}
