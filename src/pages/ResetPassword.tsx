import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";

import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    // Supabase auto-processes the recovery token in the URL hash and emits PASSWORD_RECOVERY
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setReady(true);
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast({ title: "Password too short", description: "Use at least 6 characters.", variant: "destructive" });
      return;
    }
    if (password !== confirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Password updated ✅", description: "You're signed in." });
    navigate("/dashboard");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Helmet>
        <title>Reset your EliteSwap password</title>
        <meta name="description" content="Set a new password for your EliteSwap account." />
        <link rel="canonical" href="https://eliteswap.online/reset-password" />
        <meta name="robots" content="noindex" />
      </Helmet>
      <main className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-5xl font-heading font-bold gradient-text cursor-pointer" onClick={() => navigate("/")}>Elite Swap — Reset Password</h1>

          <p className="text-muted-foreground font-body">Set a new password</p>
        </div>

        {!ready ? (
          <div className="glass neon-border rounded-2xl p-6 text-muted-foreground text-sm">
            Validating reset link...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="glass neon-border rounded-2xl p-6 space-y-4">
            <div className="space-y-2 text-left">
              <label className="text-sm font-heading text-foreground/70">New Password</label>
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
            <div className="space-y-2 text-left">
              <label className="text-sm font-heading text-foreground/70">Confirm Password</label>
              <Input
                type="password"
                placeholder="••••••••"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={6}
                className="bg-muted/30 border-border focus:border-primary"
              />
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-heading font-semibold neon-glow"
            >
              {loading ? "Updating..." : "Update Password"}
            </Button>
          </form>
        )}
      </main>
    </div>

  );
}
