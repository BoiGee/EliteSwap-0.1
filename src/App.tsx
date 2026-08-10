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
