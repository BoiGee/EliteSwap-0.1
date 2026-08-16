import { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import NotificationBell from "@/components/NotificationBell";
import logo from "@/assets/logo.jpg";

type NavKey = "dashboard" | "pricing" | "forum" | "partner";

const NAV_ITEMS: { key: NavKey; label: string; to: string }[] = [
  { key: "dashboard", label: "Dashboard", to: "/dashboard" },
  { key: "pricing", label: "Pricing", to: "/pricing" },
  { key: "forum", label: "Forum", to: "/forum" },
  { key: "partner", label: "Partner", to: "/partner" },
];

interface AppHeaderProps {
  /** Which of the standard nav links corresponds to the current page, for the active-state highlight. */
  active?: NavKey;
  isStaff?: boolean;
  /** Only pass this where the caller already fetches partner status — this component never queries it itself, to avoid duplicating that fetch. */
  isPartner?: boolean;
  showNotifications?: boolean;
  /** Page-specific badge/label rendered right next to the logo (e.g. Partner's "PARTNER" pill). */
  leftExtra?: ReactNode;
  /** Page-specific controls (e.g. Partner's "Refresh" button) rendered before Sign Out. */
  rightExtra?: ReactNode;
}

export default function AppHeader({ active, isStaff, isPartner, showNotifications, leftExtra, rightExtra }: AppHeaderProps) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="border-b border-border glass px-4 py-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 shrink-0">
        <Link to="/" className="flex items-center gap-2">
          <img src={logo} alt="Elite Swap" className="w-8 h-8 rounded-lg" />
          <span className="font-heading font-bold text-primary hidden sm:inline">Elite Swap</span>
        </Link>
        {leftExtra}
      </div>

      <nav className="flex items-center gap-1 flex-wrap justify-end">
        {NAV_ITEMS.filter((item) => item.key !== "partner" || isPartner).map((item) => (
          <Link
            key={item.key}
            to={item.to}
            className={`text-sm font-heading px-2 py-1.5 rounded-md transition-colors ${
              active === item.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        ))}
        {isStaff && (
          <Link
            to="/admin"
            className="text-sm font-heading px-2 py-1.5 rounded-md transition-colors text-muted-foreground hover:text-foreground"
          >
            Admin
          </Link>
        )}

        <span className="w-px h-5 bg-border mx-1 hidden sm:inline-block" />

        <LanguageSwitcher compact />
        {showNotifications && <NotificationBell />}
        {rightExtra}

        {user ? (
          <Button variant="outline" size="sm" onClick={async () => { await signOut(); navigate("/"); }} className="font-heading text-xs">
            Sign Out
          </Button>
        ) : (
          <Button size="sm" onClick={() => navigate("/auth")} className="font-heading text-xs">
            Sign In
          </Button>
        )}
      </nav>
    </header>
  );
}
