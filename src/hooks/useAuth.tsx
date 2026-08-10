import { useState, useEffect, createContext, useContext, ReactNode, useRef } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { installAuthRetry } from "@/integrations/supabase/authRetry";
import { toast } from "sonner";
import { generateClientId } from "@/lib/utils";

// Install the 429-aware fetch wrapper as early as possible.
installAuthRetry();

interface AuthContextType {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signUp: (email: string, password: string, emailRedirectTo?: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TAB_CHANNEL = "eliteswap-auth";
const MULTI_TAB_WARNED_AT_KEY = "eliteswap-multi-tab-warned-at";
const MULTI_TAB_NEVER_KEY = "eliteswap-multi-tab-never";
const MULTI_TAB_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
const RATE_LIMIT_TOAST_AT_KEY = "eliteswap-rate-limit-toast-at";
const RATE_LIMIT_TOAST_COOLDOWN_MS = 30 * 60 * 1000; // 30m

// Routes where the multi-tab / rate-limit toasts must NOT appear
// (studio + OBS output legitimately run in their own tabs).
const isQuietRoute = () => {
  if (typeof window === "undefined") return false;
  const p = window.location.pathname || "";
  return p.startsWith("/studio") || p.startsWith("/obs-output");
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const rateLimitedToastShown = useRef(false);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      // Only log truly new sign-ins — NEVER on TOKEN_REFRESHED / INITIAL_SESSION
      // / USER_UPDATED, because those fire on every refresh cycle and pile up
      // useless activity rows plus extra DB traffic.
      if (event === "SIGNED_IN" && session?.user) {
        const userId = session.user.id;
        // Key by user only, per browser session — one login row per tab-open,
        // not one per refresh.
        const key = `login-logged-${userId}`;
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          supabase.from("user_activity_logs").insert({
            user_id: userId,
            action: "login",
            metadata: { ua: navigator.userAgent.slice(0, 200) },
          } as any).then(() => {}, () => {});
        }
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Friendly toast when the auth refresh endpoint starts getting rate-limited.
  // Suppressed on quiet routes and rate-limited globally to once every 30 min.
  useEffect(() => {
    const onLimited = () => {
      if (rateLimitedToastShown.current) return;
      if (isQuietRoute()) return;
      try {
        const lastAt = Number(localStorage.getItem(RATE_LIMIT_TOAST_AT_KEY) || "0");
        if (Date.now() - lastAt < RATE_LIMIT_TOAST_COOLDOWN_MS) return;
        localStorage.setItem(RATE_LIMIT_TOAST_AT_KEY, String(Date.now()));
      } catch {}
      rateLimitedToastShown.current = true;
      toast.warning("Too many active sessions", {
        description:
          "We're pausing for a few seconds to avoid signing you out. Try closing extra EliteSwap tabs.",
        duration: 6000,
      });
      setTimeout(() => {
        rateLimitedToastShown.current = false;
      }, RATE_LIMIT_TOAST_COOLDOWN_MS);
    };
    window.addEventListener("auth:rate-limited", onLimited as EventListener);
    return () => window.removeEventListener("auth:rate-limited", onLimited as EventListener);
  }, []);

  // Detect duplicate tabs and warn at most once per 24h per browser.
  // Only fires when 5+ tabs are open and never on /studio or /obs-output.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    if (isQuietRoute()) return;
    try {
      if (localStorage.getItem(MULTI_TAB_NEVER_KEY) === "1") return;
      const lastAt = Number(localStorage.getItem(MULTI_TAB_WARNED_AT_KEY) || "0");
      if (Date.now() - lastAt < MULTI_TAB_COOLDOWN_MS) return;
    } catch {}

    const channel = new BroadcastChannel(TAB_CHANNEL);
    let responses = 0;
    let fired = false;
    const myId = generateClientId("tab");

    const onMsg = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || data.id === myId) return;
      if (data.type === "ping") {
        channel.postMessage({ type: "pong", id: myId });
      } else if (data.type === "pong") {
        responses += 1;
        if (responses >= 4 && !fired) {
          fired = true;
          try {
            localStorage.setItem(MULTI_TAB_WARNED_AT_KEY, String(Date.now()));
          } catch {}
          toast.info("Multiple EliteSwap tabs detected", {
            description:
              "Having several tabs open can rate-limit your account. Consider closing extras.",
            duration: 6000,
            action: {
              label: "Don't show again",
              onClick: () => {
                try { localStorage.setItem(MULTI_TAB_NEVER_KEY, "1"); } catch {}
              },
            },
          });
        }
      }
    };

    channel.addEventListener("message", onMsg);
    const t = setTimeout(() => channel.postMessage({ type: "ping", id: myId }), 500);

    return () => {
      clearTimeout(t);
      channel.removeEventListener("message", onMsg);
      channel.close();
    };
  }, []);

  const signUp = async (email: string, password: string, emailRedirectTo?: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: emailRedirectTo ? { emailRedirectTo } : undefined,
    });
    if (error) throw error;
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  return (
    <AuthContext.Provider value={{ session, user, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
