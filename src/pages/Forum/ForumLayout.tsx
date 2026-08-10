import { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import logo from "@/assets/logo.jpg";
import { MessageSquare } from "lucide-react";
import LanguageSwitcher from "@/components/LanguageSwitcher";

export default function ForumLayout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border glass px-4 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <img src={logo} alt="" className="w-8 h-8 rounded-lg" />
          <span className="font-heading font-bold gradient-text">Elite Swap</span>
        </Link>
        <nav className="flex items-center gap-2">
          <LanguageSwitcher compact />
          <Link to="/forum" className="text-sm font-heading text-primary inline-flex items-center gap-1">
            <MessageSquare className="w-4 h-4" /> Forum
          </Link>
          <Button variant="ghost" size="sm" onClick={() => navigate("/pricing")}>Pricing</Button>
          {user ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>Dashboard</Button>
              <Button variant="outline" size="sm" onClick={async () => { await signOut(); navigate("/"); }}>Sign Out</Button>
            </>
          ) : (
            <Button size="sm" onClick={() => navigate("/auth")}>Sign in</Button>
          )}
        </nav>
      </header>
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-6">{children}</main>
    </div>
  );
}
