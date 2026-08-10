import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";

import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { attachPendingPartnerCode, getPendingPartnerCode } from "@/lib/partnerCode";
import { TermsContent, TERMS_VERSION } from "@/lib/termsContent";

export default function Auth() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const { signUp, signIn } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect");
  const isTrialFlow = redirect === "trial" || redirect === "free-trial";
  const isAdminFlow = redirect === "admin";

  const baseDestination = isTrialFlow ? "/dashboard?trial=purchase" : isAdminFlow ? "/admin" : "/dashboard";
  const normalizedEmail = email.trim().toLowerCase();

  const resolveDestination = async (): Promise<string> => {
    // Trial flow always wins; explicit admin redirect keeps /admin.
    if (isTrialFlow) return "/dashboard?trial=purchase";
    if (isAdminFlow) return "/admin";
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return baseDestination;
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const roleNames = (roles ?? []).map((r: any) => r.role);
      if (roleNames.some((r) => r === "admin" || r === "moderator" || r === "sec_admin")) {
        return "/admin";
      }
    } catch { /* fall through */ }
    return baseDestination;
  };

  useEffect(() => {
    if (searchParams.get("verified") === "1") {
      toast({
        title: "Email verified",
        description: "Your email is confirmed. Please sign in to continue.",
      });
      setIsSignUp(false);
    }
  }, [searchParams, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isSignUp) {
        if (!agreedToTerms) {
          toast({ title: "Please agree to the Terms to continue", variant: "destructive" });
          setLoading(false);
          return;
        }
        await signUp(normalizedEmail, password, `${window.location.origin}/auth?verified=1`);
        // Stamp acceptance on the user's profile + audit log. Best-effort:
        // signUp() with email confirmation required returns no session, so
        // getUser() below has nothing to identify — this only actually
        // stamps anything if confirmation is ever disabled again.
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const acceptedAt = new Date().toISOString();
            await supabase
              .from("profiles")
              .update({ terms_accepted_at: acceptedAt, terms_version: TERMS_VERSION })
              .eq("user_id", user.id);
            await supabase.from("terms_acceptances").insert({
              user_id: user.id,
              email: user.email ?? email,
              terms_version: TERMS_VERSION,
              source: "signup",
              user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : null,
              accepted_at: acceptedAt,
            });
          }
        } catch { /* non-fatal */ }
        if (getPendingPartnerCode()) {
          attachPendingPartnerCode("signup_code").then((r) => {
            const res = r.result;
            if (res?.ok) {
              toast({ title: `Referral code applied: ${res.partner_code}` });
            } else if (res?.reason === "already_attributed") {
              toast({
                title: "Referral already set",
                description: `Your account is already linked to ${res.existing_code}. Only one referral per account.`,
              });
            }
          }).catch(() => {});
        }
        toast({
          title: "Check your email 📧",
          description: "We sent you a confirmation link. Click it, then sign in here.",
        });
        setIsSignUp(false);
      } else {
        await signIn(normalizedEmail, password);
        if (getPendingPartnerCode()) {
          attachPendingPartnerCode("link").then((r) => {
            const res = r.result;
            if (res?.reason === "already_attributed") {
              toast({
                title: "Referral already set",
                description: `This account is already linked to ${res.existing_code}. Only one referral per account.`,
              });
            } else if (res?.ok) {
              toast({ title: `Referral code applied: ${res.partner_code}` });
            }
          }).catch(() => {});
        }
        toast({ title: "Welcome back! 👋" });
        navigate(await resolveDestination());
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "Something went wrong";
      const isRateLimited =
        /rate limit|over_request_rate_limit|429/i.test(raw);
      const message = isRateLimited
        ? "Too many sign-in attempts from this device. Please wait ~60 seconds and try again, and close any extra EliteSwap tabs you might have open."
        : raw;
      toast({
        title: isRateLimited ? "Slow down a moment" : "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Helmet>
        <title>Sign in or create your EliteSwap account</title>
        <meta name="description" content="Log in or sign up for EliteSwap to start using realtime AI face and character swap with OBS Studio." />
        <link rel="canonical" href="https://eliteswap.online/auth" />
        <meta property="og:title" content="Sign in to EliteSwap" />
        <meta property="og:url" content="https://eliteswap.online/auth" />
      </Helmet>
      <main className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-5xl font-heading font-bold gradient-text cursor-pointer" onClick={() => navigate("/")}>Elite Swap — Sign in</h1>

          <p className="text-muted-foreground font-body">
            {isTrialFlow
              ? "Sign up or log in to purchase your $10 / 4-minute trial 💳"
              : isSignUp ? "Create your account" : "Sign in to your account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="glass neon-border rounded-2xl p-6 space-y-4">
          <div className="space-y-2 text-left">
            <label className="text-sm font-heading text-foreground/70">Email</label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-muted/30 border-border focus:border-primary"
            />
          </div>
          <div className="space-y-2 text-left">
            <label className="text-sm font-heading text-foreground/70">Password</label>
            <Input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="bg-muted/30 border-border focus:border-primary"
            />
          </div>
          {isSignUp && (
            <label className="flex items-start gap-2 text-left cursor-pointer">
              <Checkbox
                checked={agreedToTerms}
                onCheckedChange={(v) => setAgreedToTerms(v === true)}
                className="mt-0.5"
              />
              <span className="text-xs text-foreground/80 font-body leading-relaxed">
                I have read and agree to the{" "}
                <Dialog open={termsOpen} onOpenChange={setTermsOpen}>
                  <DialogTrigger asChild>
                    <button type="button" className="text-primary hover:underline font-heading">
                      Terms, Privacy & Responsible Use Policy
                    </button>
                  </DialogTrigger>
                  <DialogContent className="max-w-2xl">
                    <DialogHeader>
                      <DialogTitle className="font-heading gradient-text">Terms & Policies</DialogTitle>
                    </DialogHeader>
                    <ScrollArea className="h-[60vh] pr-4">
                      <TermsContent />
                    </ScrollArea>
                  </DialogContent>
                </Dialog>
                .
              </span>
            </label>
          )}
          <Button
            type="submit"
            disabled={loading || (isSignUp && !agreedToTerms)}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold neon-glow"
          >
            {loading ? "Processing..." : isSignUp ? "Create Account" : "Sign In"}
          </Button>
          {!isSignUp && (
            <button
              type="button"
              onClick={async () => {
                if (!email) {
                  toast({ title: "Enter your email above first", variant: "destructive" });
                  return;
                }
                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                  redirectTo: `${window.location.origin}/reset-password`,
                });
                if (error) {
                  toast({ title: "Error", description: error.message, variant: "destructive" });
                } else {
                  toast({ title: "Check your email 📧", description: "We sent you a password reset link." });
                }
              }}
              className="block w-full text-xs text-primary hover:underline font-heading mt-1"
            >
              Forgot password?
            </button>
          )}
          {isSignUp && (
            <p className="text-[11px] text-muted-foreground/80 font-body leading-relaxed mt-1">
              We'll send a confirmation link to your email before you can sign in.
            </p>
          )}
        </form>

        <p className="text-sm text-muted-foreground">
          {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button onClick={() => setIsSignUp(!isSignUp)} className="text-primary hover:underline font-heading font-semibold">
            {isSignUp ? "Sign In" : "Sign Up"}
          </button>
        </p>

        <p className="text-xs text-muted-foreground/70 font-body">
          We use device signals to prevent trial abuse.
        </p>
      </main>
    </div>

  );
}
