import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Users, X } from "lucide-react";
import { rpc } from "@/lib/db";
import { useAuth } from "@/hooks/useAuth";

/**
 * Invite to the Elite Swap WhatsApp community, for every signed-in user (new, old, paid or not).
 * The link is set by an admin (Admin > Announcements); nothing shows until it is.
 */
export default function CommunityGroupCard() {
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const dismissKey = user ? `wa-community-dismissed-${user.id}` : "";
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    rpc<{ whatsapp_group_url?: string }>("get_site_links").then(({ data }) => setUrl(data?.whatsapp_group_url ?? ""));
  }, []);
  useEffect(() => {
    try { setDismissed(!!dismissKey && localStorage.getItem(dismissKey) === url && !!url); } catch { /* storage blocked */ }
  }, [dismissKey, url]);

  if (!url || dismissed) return null;

  return (
    <div className="relative rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent p-5 space-y-3">
      <button
        type="button"
        aria-label="Hide"
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
        onClick={() => { try { localStorage.setItem(dismissKey, url); } catch { /* storage blocked */ } setDismissed(true); }}
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-center gap-2">
        <span className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center"><Users className="w-4 h-4" /></span>
        <h3 className="text-base font-heading font-semibold text-foreground">Join the Elite Swap WhatsApp community</h3>
      </div>
      <ul className="space-y-1.5 text-sm text-foreground/85">
        {[
          "First to hear about new features, characters and sales",
          "Members-only offers and early access",
          "Setups and tips from other creators",
          "Quick answers from the team",
        ].map((t) => (
          <li key={t} className="flex gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />{t}</li>
        ))}
      </ul>
      <Button asChild className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-heading font-semibold">
        <a href={url} target="_blank" rel="noopener noreferrer">Join on WhatsApp</a>
      </Button>
    </div>
  );
}
