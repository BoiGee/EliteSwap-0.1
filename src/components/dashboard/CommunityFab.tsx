import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MessageSquarePlus, X } from "lucide-react";

const DISMISS_KEY = "community-fab-dismissed-until";

export default function CommunityFab() {
  const navigate = useNavigate();
  const location = useLocation();
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
    setHidden(Date.now() < until);
  }, []);

  if (location.pathname.startsWith("/forum")) return null;
  if (hidden) return null;

  const dismiss = () => {
    const oneDay = 24 * 60 * 60 * 1000;
    localStorage.setItem(DISMISS_KEY, String(Date.now() + oneDay));
    setHidden(true);
  };

  return (
    <div className="fixed bottom-6 right-24 z-[60] flex items-center gap-2">
      <button
        onClick={dismiss}
        aria-label="Dismiss community shortcut"
        className="h-7 w-7 rounded-full glass border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
      <button
        onClick={() => navigate("/forum")}
        className="group flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 py-3 shadow-lg font-heading text-sm hover:opacity-90"
        title="Ask the Community"
      >
        <MessageSquarePlus className="h-4 w-4" />
        <span className="hidden sm:inline">Ask the Community</span>
      </button>
    </div>
  );
}
