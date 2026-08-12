import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { useAdmin } from "@/hooks/useAdmin";
import { useActivityTracker } from "@/hooks/useActivityTracker";
import Landing from "./pages/Landing";
import SupportChat from "./components/SupportChat";
import SystemAnnouncementBanner from "./components/SystemAnnouncementBanner";
import AuthRateLimitBanner from "./components/AuthRateLimitBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import StudioTermsGate from "./components/StudioTermsGate";
import { capturePartnerCodeFromUrl } from "./lib/partnerCode";
import { TranslationProvider } from "@/i18n/TranslationProvider";
import { useEffect } from "react";

const Auth = lazy(() => import("./pages/Auth"));
const Admin = lazy(() => import("./pages/Admin"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Pricing = lazy(() => import("./pages/Pricing"));
const Index = lazy(() => import("./pages/Index"));
const NotFound = lazy(() => import("./pages/NotFound"));
const OBSOutput = lazy(() => import("./pages/OBSOutput"));
const Reviews = lazy(() => import("./pages/Reviews"));
const Unsubscribe = lazy(() => import("./pages/Unsubscribe"));
const Partner = lazy(() => import("./pages/Partner"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const ForumHome = lazy(() => import("./pages/Forum/ForumHome"));
const ForumCategory = lazy(() => import("./pages/Forum/ForumCategory"));
const ForumThread = lazy(() => import("./pages/Forum/ForumThread"));
const NewThread = lazy(() => import("./pages/Forum/NewThread"));
const ForumGuidelines = lazy(() => import("./pages/Forum/Guidelines"));
const MyForum = lazy(() => import("./pages/Forum/MyForum"));

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="text-primary animate-pulse font-heading text-xl">Loading...</div></div>;
  if (!user) return <Navigate to={location.pathname === "/admin" ? "/auth?redirect=admin" : "/auth"} replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  const { isStaff, loading: rolesLoading } = useAdmin();
  if (loading) return <LazyFallback />;
  if (!user) return <Landing />;
  if (rolesLoading) return <LazyFallback />;
  return <Navigate to={isStaff ? "/admin" : "/dashboard"} replace />;
}

const LazyFallback = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="text-primary animate-pulse font-heading text-xl">Loading...</div>
  </div>
);

function ActivityTrackerWrapper({ children }: { children: React.ReactNode }) {
  useActivityTracker();
  useEffect(() => {
    capturePartnerCodeFromUrl();
  }, []);
  return <>{children}</>;
}

// The PWA manifest's start_url was hardcoded to /dashboard, so an admin who
// installs the app to their iPhone home screen (required for Web Push to
// work at all on iOS — Safari doesn't support Notification/Push in a regular
// tab) always relaunches into the user dashboard instead of /admin, with no
// admin controls in sight.
//
// This used to swap the <link rel="manifest"> via a React effect after
// mount. Confirmed on-device that doesn't work: iOS Safari's Add to Home
// Screen preview still showed the default target even with a brand-new,
// never-before-seen manifest URL (ruling out simple caching) while the
// address bar correctly showed /admin — meaning Safari reads the manifest
// during initial HTML parsing, before a post-mount async role check could
// ever finish. The actual swap now happens synchronously in index.html
// (see the inline script there), driven by a localStorage flag. This
// component's only remaining job is writing that flag once the role is
// known, so it's already set by the *next* load — and, for the current
// session before that flag exists, applying the same swap as a fallback in
// case the user tries to install before ever having reloaded post-login.
function ManifestLinkSwitcher() {
  const { isStaff, loading } = useAdmin();
  useEffect(() => {
    if (loading) return;
    try { localStorage.setItem("elite-pwa-role", isStaff ? "admin" : "user"); } catch { /* noop */ }

    // Also correct the DOM within the current session (e.g. a shared device
    // where a previous admin session's localStorage flag caused the inline
    // script to link the admin manifest for someone who then turns out not
    // to be staff this time — the fallback needs to be able to revert, not
    // just apply). Non-staff targets the plain default with no query string
    // so this doesn't churn the DOM on every load for the common case —
    // that's already what index.html ships with.
    const target = isStaff
      ? `${import.meta.env.BASE_URL}manifest-admin.webmanifest?r=admin`
      : `${import.meta.env.BASE_URL}manifest.webmanifest`;
    const existing = document.querySelectorAll('link[rel="manifest"]');
    if (!(existing.length === 1 && existing[0].getAttribute("href") === target)) {
      existing.forEach((el) => el.remove());
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = target;
      document.head.appendChild(link);
    }
    const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    const wantTitle = isStaff ? "EliteSwap Admin" : "EliteSwap";
    if (title && title.getAttribute("content") !== wantTitle) {
      title.setAttribute("content", wantTitle);
    }
  }, [isStaff, loading]);
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      {/* basename tracks Vite's `base` (import.meta.env.BASE_URL) automatically —
          /EliteSwap-0.1/ on the GitHub Pages project site, / once a custom
          domain is attached. Without this, BrowserRouter matches routes
          against the full pathname (which includes the subpath prefix) and
          every route 404s. */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthProvider>
          <TranslationProvider>
          <ActivityTrackerWrapper>
            <ManifestLinkSwitcher />
            <AuthRateLimitBanner />
            <SystemAnnouncementBanner />
            <Suspense fallback={<LazyFallback />}>
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<HomeRedirect />} />
                  <Route path="/pricing" element={<Pricing />} />
                  <Route path="/auth" element={<Auth />} />
                  <Route path="/reset-password" element={<ResetPassword />} />
                  <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                  <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
                  <Route path="/studio" element={<ProtectedRoute><StudioTermsGate><Index /></StudioTermsGate></ProtectedRoute>} />
                  <Route path="/obs-output" element={<OBSOutput />} />
                  <Route path="/reviews" element={<Reviews />} />
                  <Route path="/unsubscribe" element={<Unsubscribe />} />
                  <Route path="/partner" element={<ProtectedRoute><Partner /></ProtectedRoute>} />
                  <Route path="/forum" element={<ForumHome />} />
                  <Route path="/forum/guidelines" element={<ForumGuidelines />} />
                  <Route path="/forum/me" element={<ProtectedRoute><MyForum /></ProtectedRoute>} />
                  <Route path="/forum/new" element={<ProtectedRoute><NewThread /></ProtectedRoute>} />
                  <Route path="/forum/c/:slug" element={<ForumCategory />} />
                  <Route path="/forum/t/:id" element={<ForumThread />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </ErrorBoundary>
            </Suspense>
            <SupportChat />
          </ActivityTrackerWrapper>
          </TranslationProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
