import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { TermsContent, TERMS_VERSION } from "@/lib/termsContent";

export default function StudioTermsGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [checking, setChecking] = useState(true);
  const [needsAgreement, setNeedsAgreement] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    // Safety net: never leave the user stuck on the spinner. If the profile
    // fetch is slow or fails silently, drop the gate after 4s and fail open.
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setNeedsAgreement(false);
      setChecking(false);
    }, 4000);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("terms_accepted_at, terms_version")
          .eq("user_id", user.id)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          console.warn("StudioTermsGate: profile fetch error", error);
          setNeedsAgreement(false); // fail open — audit log remains source of truth
          return;
        }
        const accepted = !!data?.terms_accepted_at && data?.terms_version === TERMS_VERSION;
        setNeedsAgreement(!accepted);
      } catch (e) {
        if (cancelled) return;
        console.warn("StudioTermsGate: profile fetch threw", e);
        setNeedsAgreement(false); // fail open
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [user?.id]);

  const handleAgree = async () => {
    if (!user || !agreed) return;
    setSaving(true);
    const acceptedAt = new Date().toISOString();
    const { error } = await supabase
      .from("profiles")
      .update({ terms_accepted_at: acceptedAt, terms_version: TERMS_VERSION })
      .eq("user_id", user.id);
    if (error) {
      setSaving(false);
      toast({ title: "Couldn't save", description: error.message, variant: "destructive" });
      return;
    }
    // Append-only audit log (non-fatal on failure).
    await supabase.from("terms_acceptances").insert({
      user_id: user.id,
      email: user.email ?? null,
      terms_version: TERMS_VERSION,
      source: "studio_gate",
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : null,
      accepted_at: acceptedAt,
    });
    setSaving(false);
    setNeedsAgreement(false);
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-primary animate-pulse font-heading text-xl">Loading...</div>
      </div>
    );
  }

  if (!needsAgreement) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-2xl glass neon-border rounded-2xl p-6 space-y-5">
        <div className="text-center space-y-2">
          <h2 className="text-3xl font-heading font-bold gradient-text">Before you continue</h2>
          <p className="text-sm text-muted-foreground font-body">
            Please review and agree to our Terms, Privacy Policy, and Responsible Use Policy to enter the Studio.
          </p>
        </div>

        <ScrollArea className="h-72 rounded-lg border border-border/40 bg-muted/20 p-4">
          <TermsContent />
        </ScrollArea>

        <label className="flex items-start gap-3 cursor-pointer">
          <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} className="mt-0.5" />
          <span className="text-sm font-body text-foreground/90">
            I have read and agree to the Terms of Service, Privacy Policy, and Responsible Use Policy.
          </span>
        </label>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => navigate("/dashboard")}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold neon-glow"
            disabled={!agreed || saving}
            onClick={handleAgree}
          >
            {saving ? "Saving..." : "Agree & Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
