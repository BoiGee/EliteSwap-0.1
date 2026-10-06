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
  // A same-site path from a protected page (ProtectedRoute sends ?redirect=/studio etc.).
  // "//host" and "/\host" are rejected so this can't bounce users to another site.
  const pathRedirect =
    redirect && redirect.startsWith("/") && !redirect.startsWith("//") && !redirect.startsWith("/\\") && !redirect.startsWith("/auth")
      ? redirect
      : null;
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [resending, setResending] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  // Only offer Google once the provider is switched on in Supabase Auth.
  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return;
    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => r.json())
      .then((s) => setGoogleEnabled(!!s?.external?.google))
      .catch(() => {});
  }, []);

  const baseDestination = isTrialFlow ? "/dashboard?trial=purchase" : isAdminFlow ? "/admin" : pathRedirect ?? "/dashboard";
  const normalizedEmail = email.trim().toLowerCase();

  const resolveDestination = async (): Promise<string> => {
    // Trial flow always wins; explicit admin redirect keeps /admin.
    if (isTrialFlow) return "/dashboard?trial=purchase";
    if (isAdminFlow) return "/admin";
    if (pathRedirect) return pathRedirect;
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

  // Keeps ?redirect through the email link, so the trial / deep link still applies after confirming.
  const confirmRedirect = `${window.location.origin}/auth?verified=1${redirect ? `&redirect=${encodeURIComponent(redirect)}` : ""}`;

  const resendConfirmation = async () => {
    if (!normalizedEmail) {
      toast({ title: "Enter your email above first", variant: "destructive" });
      return;
    }
    setResending(true);
    const { error } = await supabase.auth.resend({ type: "signup", email: normalizedEmail, options: { emailRedirectTo: confirmRedirect } });
    setResending(false);
    if (error) {
      toast({ title: "Couldn't resend", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Confirmation email sent", description: "Check your inbox and spam folder; the link expires after a day." });
    }
  };

  const signInWithGoogle = async () => {
    const dest = isTrialFlow ? "/dashboard?trial=purchase" : isAdminFlow ? "/admin" : pathRedirect ?? "/dashboard";
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}${dest}` },
    });
    if (error) toast({ title: "Google sign-in failed", description: error.message, variant: "destructive" });
  };

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
        await signUp(normalizedEmail, password, confirmRedirect);
        // Stamp acceptance on the user's profile + audit log. Best-effort:
        // signUp() with email confirmation required returns no session, so
        // getUser() below has nothing to identify; this only actually
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
          title: "Check your email",
          description: "We sent you a confirmation link. Click it, then sign in here.",
        });
        setAwaitingConfirmation(true);
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
        toast({ title: "Welcome back!" });
        navigate(await resolveDestination());
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "Something went wrong";
      if (/email not confirmed/i.test(raw)) {
        setAwaitingConfirmation(true);
        toast({
          title: "Confirm your email first",
          description: "Open the confirmation link we emailed you, or tap \"Resend confirmation email\" below.",
          variant: "destructive",
        });
        return;
      }
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
          <h1 className="text-3xl font-heading font-bold text-primary cursor-pointer" onClick={() => navigate("/")}>Elite Swap</h1>

          <p className="text-muted-foreground font-body">
            {isTrialFlow
              ? "Sign up or log in to purchase your $10 / 4-minute trial"
              : isSignUp ? "Create your account" : "Sign in to your account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="glass border border-border rounded-2xl p-6 space-y-4">
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
              minLength={isSignUp ? 8 : 6}
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
                      <DialogTitle className="font-heading">Terms &amp; Policies</DialogTitle>
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
            className="w-full font-heading font-semibold"
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
                  toast({ title: "Check your email", description: "We sent you a password reset link." });
                }
              }}
              className="block w-full text-xs text-primary hover:underline font-heading mt-1"
            >
              Forgot password?
            </button>
          )}
          {isSignUp && (
            <p className="text-[11px] text-muted-foreground/80 font-body leading-relaxed mt-1">
              We'll send a confirmation link to your email before you can sign in. Use at least 8 characters for your password.
            </p>
          )}
          {!isSignUp && awaitingConfirmation && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-left space-y-2">
              <p className="text-xs text-foreground/80">
                Didn't get the confirmation email? Check spam, or send it again to <span className="font-semibold">{normalizedEmail || "your email"}</span>.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={resendConfirmation} disabled={resending} className="font-heading text-xs w-full">
                {resending ? "Sending…" : "Resend confirmation email"}
              </Button>
            </div>
          )}
          {googleEnabled && (
            <>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
              </div>
              <Button type="button" variant="outline" onClick={signInWithGoogle} className="w-full font-heading font-semibold">
                Continue with Google
              </Button>
              {isSignUp && (
                <p className="text-[11px] text-muted-foreground/80">
                  By continuing with Google you agree to the Terms, Privacy &amp; Responsible Use Policy.
                </p>
              )}
            </>
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
