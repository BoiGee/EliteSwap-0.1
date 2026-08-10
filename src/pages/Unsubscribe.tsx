import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";

import { useSearchParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/handle-email-unsubscribe`;

type Status = "loading" | "ready" | "already" | "invalid" | "submitting" | "done" | "error";

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [status, setStatus] = useState<Status>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    if (!token) { setStatus("invalid"); return; }
    (async () => {
      try {
        const res = await fetch(`${FN_URL}?token=${encodeURIComponent(token)}`);
        const json = await res.json().catch(() => ({}));
        if (json?.alreadyUnsubscribed) { setEmail(json.email ?? null); setStatus("already"); return; }
        if (!res.ok || json?.valid === false) { setStatus("invalid"); return; }
        setEmail(json?.email ?? null);
        setStatus("ready");
      } catch {
        setStatus("invalid");
      }
    })();
  }, [token]);

  const confirm = async () => {
    setStatus("submitting");
    try {
      const res = await fetch(FN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "Failed to unsubscribe");
      setStatus("done");
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed");
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Helmet>
        <title>Manage EliteSwap email preferences</title>
        <meta name="description" content="Unsubscribe from EliteSwap email notifications or manage your email preferences." />
        <link rel="canonical" href="https://eliteswap.online/unsubscribe" />
        <meta name="robots" content="noindex" />
      </Helmet>
      <main className="glass neon-border rounded-2xl p-8 max-w-md w-full text-center space-y-4">
        <h1 className="text-2xl font-heading font-bold gradient-text">Elite Swap — Email Preferences</h1>
        <h2 className="text-lg font-heading font-semibold text-foreground">Manage your subscription</h2>


        {status === "loading" && <p className="text-sm text-muted-foreground">Checking your link...</p>}

        {status === "invalid" && (
          <>
            <p className="text-sm text-destructive">This unsubscribe link is invalid or has expired.</p>
            <Button asChild variant="outline" className="font-heading"><Link to="/">Back home</Link></Button>
          </>
        )}

        {status === "already" && (
          <>
            <p className="text-sm text-muted-foreground">
              {email ? <><span className="text-foreground font-mono">{email}</span> is</> : "You are"} already unsubscribed from EliteSwap emails.
            </p>
            <Button asChild variant="outline" className="font-heading"><Link to="/">Back home</Link></Button>
          </>
        )}

        {status === "ready" && (
          <>
            <p className="text-sm text-muted-foreground">
              You are about to unsubscribe{email ? <> <span className="text-foreground font-mono">{email}</span></> : ""} from all EliteSwap emails.
            </p>
            <p className="text-xs text-muted-foreground">You'll still receive critical account &amp; payment emails.</p>
            <div className="flex gap-2 justify-center">
              <Button asChild variant="outline" className="font-heading"><Link to="/">Cancel</Link></Button>
              <Button onClick={confirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90 font-heading">
                Confirm unsubscribe
              </Button>
            </div>
          </>
        )}

        {status === "submitting" && <p className="text-sm text-muted-foreground animate-pulse">Updating preferences...</p>}

        {status === "done" && (
          <>
            <p className="text-sm text-primary">✅ You've been unsubscribed.</p>
            <Button asChild variant="outline" className="font-heading"><Link to="/">Back home</Link></Button>
          </>
        )}

        {status === "error" && (
          <>
            <p className="text-sm text-destructive">{errorMsg}</p>
            <Button onClick={confirm} variant="outline" className="font-heading">Try again</Button>
          </>
        )}
      </main>
    </div>

  );
}
