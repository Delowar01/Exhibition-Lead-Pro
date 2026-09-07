import { Switch, Route, Redirect, Router as WouterRouter, useLocation } from "wouter";
import {
  resolvePortalHost,
  retiredHostRedirectUrl,
  CUSTOMER_PORTAL_URL,
  PLATFORM_PORTAL_URL,
} from "@/lib/portal-host";
import { useEffect, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";

// Pages — auth/public pages stay eager (first paint); portal pages are lazy-loaded
import NotFound from "@/pages/not-found";
import Login from "@/pages/Login";
import PublicCard from "@/pages/PublicCard";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import VerifyEmail from "@/pages/VerifyEmail";
import AcceptInvite from "@/pages/AcceptInvite";
const PlatformDashboard = lazy(() => import("@/pages/platform/Dashboard"));
const PlatformCompanies = lazy(() => import("@/pages/platform/Companies"));
const PlatformUsers = lazy(() => import("@/pages/platform/Users"));
const PlatformSubscriptions = lazy(() => import("@/pages/platform/Subscriptions"));
const PlatformAnalytics = lazy(() => import("@/pages/platform/Analytics"));
const PlatformActivity = lazy(() => import("@/pages/platform/Activity"));
const PlatformSettings = lazy(() => import("@/pages/platform/Settings"));
const PlatformAiIntelligence = lazy(() => import("@/pages/platform/AiIntelligence"));
const AdminDashboard = lazy(() => import("@/pages/admin/Dashboard"));
const AdminContacts = lazy(() => import("@/pages/admin/Contacts"));
const AdminContactNew = lazy(() => import("@/pages/admin/ContactNew"));
const AdminContactDetail = lazy(() => import("@/pages/admin/ContactDetail"));
const AdminDuplicates = lazy(() => import("@/pages/admin/Duplicates"));
const AdminLeads = lazy(() => import("@/pages/admin/Leads"));
const AdminLeadDetail = lazy(() => import("@/pages/admin/LeadDetail"));
const AdminPipelineSettings = lazy(() => import("@/pages/admin/PipelineSettings"));
const AdminTags = lazy(() => import("@/pages/admin/Tags"));
const AdminEvents = lazy(() => import("@/pages/admin/Events"));
const AdminEventDetail = lazy(() => import("@/pages/admin/EventDetail"));
const AdminTeam = lazy(() => import("@/pages/admin/Team"));
const AdminDepartments = lazy(() => import("@/pages/admin/Departments"));
const AdminTeams = lazy(() => import("@/pages/admin/Teams"));
const AdminCompanies = lazy(() => import("@/pages/admin/Companies"));
const AdminCompanyDetail = lazy(() => import("@/pages/admin/CompanyDetail"));
const AdminDirectory = lazy(() => import("@/pages/admin/Directory"));
const AdminOrgHierarchy = lazy(() => import("@/pages/admin/OrgHierarchy"));
const AdminRoles = lazy(() => import("@/pages/admin/Roles"));
const AdminOrganization = lazy(() => import("@/pages/admin/Organization"));
const AdminSecurity = lazy(() => import("@/pages/admin/Security"));
const AdminProfile = lazy(() => import("@/pages/admin/Profile"));
const AdminReports = lazy(() => import("@/pages/admin/Reports"));
const AdminAnalytics = lazy(() => import("@/pages/admin/Analytics"));
const AdminAiSettings = lazy(() => import("@/pages/admin/AiSettings"));
const AdminAiInsightsReview = lazy(() => import("@/pages/admin/AiInsightsReview"));
const AdminSalesCopilot = lazy(() => import("@/pages/admin/SalesCopilot"));
const AdminWorkflow = lazy(() => import("@/pages/admin/Workflow"));
const AdminAutomations = lazy(() => import("@/pages/admin/Automations"));
const AdminAutomationEditor = lazy(() => import("@/pages/admin/AutomationEditor"));
const AdminAutomationRunDetail = lazy(() => import("@/pages/admin/AutomationRunDetail"));
const AdminAiCommandCenter = lazy(() => import("@/pages/admin/AiCommandCenter"));
const AdminDesignSystem = lazy(() => import("@/pages/admin/DesignSystem"));
const AdminExecutiveIntelligence = lazy(() => import("@/pages/admin/ExecutiveIntelligence"));
const AdminBatchOperations = lazy(() => import("@/pages/admin/BatchOperations"));
const AdminSubscription = lazy(() => import("@/pages/admin/Subscription"));
const AdminSettings = lazy(() => import("@/pages/admin/Settings"));
const AdminScan = lazy(() => import("@/pages/admin/Scan"));
const AdminSessions = lazy(() => import("@/pages/admin/Sessions"));
const AdminNotifications = lazy(() => import("@/pages/admin/Notifications"));
const AdminDocuments = lazy(() => import("@/pages/admin/Documents"));

import { PlatformLayout } from "@/components/layouts/PlatformLayout";
import { AdminLayout } from "@/components/layouts/AdminLayout";

// Configure API client — attach JWT from localStorage before every request
setAuthTokenGetter(() => localStorage.getItem("csp_token"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function RouteFallback() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading page">
      <div className="h-8 w-64 rounded-md bg-muted" />
      <div className="h-4 w-96 max-w-full rounded-md bg-muted" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
        <div className="h-28 rounded-lg bg-muted" />
        <div className="h-28 rounded-lg bg-muted" />
        <div className="h-28 rounded-lg bg-muted" />
      </div>
      <div className="h-64 rounded-lg bg-muted" />
    </div>
  );
}

// Full-page navigation to the other portal subdomain (different origin, so
// wouter cannot route there). Renders nothing, so the wrong-host layout/page
// never mounts — not even for one frame.
function ExternalRedirect({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return null;
}

// Authorization is decided AT RENDER TIME: a wrong-host, wrong-role, or
// unauthenticated request returns a redirect immediately, so the protected
// Layout/Component is never mounted — not even for one frame. Host separation
// comes first (the whole route family is foreign on a dedicated portal host);
// it is UX separation only — server-side RBAC stays authoritative.
function ProtectedRoute({ component: Component, role, layout: Layout }: any) {
  const { user, isLoading } = useAuth();
  const portalHost = resolvePortalHost();

  if (portalHost === "customer" && role === "platform") {
    return <ExternalRedirect href={PLATFORM_PORTAL_URL} />;
  }
  if (portalHost === "platform" && role === "admin") {
    return <ExternalRedirect href={CUSTOMER_PORTAL_URL} />;
  }

  if (isLoading) {
    return <div className="flex h-screen w-screen items-center justify-center">Loading...</div>;
  }
  if (!user) {
    return <Redirect to="/login" replace />;
  }
  if (role === "platform" && user.role !== "platform_owner") {
    return <Redirect to="/admin" replace />;
  }
  if (role === "admin" && user.role === "platform_owner") {
    return <Redirect to="/platform" replace />;
  }

  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
        <Component />
      </Suspense>
    </Layout>
  );
}

function Router() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();

  // Register the refresh-on-401 handler: rotate the refresh token, update
  // stored credentials, and return the new access token. On failure, clear
  // auth so the user is redirected to login.
  useEffect(() => {
    setOnUnauthorized(async () => {
      const refreshToken = localStorage.getItem("csp_refresh_token");
      if (!refreshToken) {
        logout();
        return null;
      }
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) throw new Error("refresh failed");
        const data = await res.json();
        localStorage.setItem("csp_token", data.token);
        if (data.refreshToken) {
          localStorage.setItem("csp_refresh_token", data.refreshToken);
        }
        return data.token as string;
      } catch {
        logout();
        return null;
      }
    });
    return () => setOnUnauthorized(null);
  }, [logout]);

  useEffect(() => {
    if (window.location.pathname === "/") {
      if (!user) {
        setLocation("/login");
        return;
      }
      // Dedicated portal hosts pin the root to their own portal; a wrong-role
      // account is then walked to the other subdomain by ProtectedRoute.
      const portalHost = resolvePortalHost();
      if (portalHost === "customer") {
        setLocation("/admin");
      } else if (portalHost === "platform") {
        setLocation("/platform");
      } else if (user.role === "platform_owner") {
        setLocation("/platform");
      } else {
        setLocation("/admin");
      }
    }
  }, [user, setLocation]);

  return (
    <Switch>
      <Route path="/login" component={Login} />

      {/* Public digital business card — no auth, no layout */}
      <Route path="/c/:token" component={PublicCard} />

      {/* Public email/invitation flows — no auth, no layout */}
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/verify-email" component={VerifyEmail} />
      <Route path="/accept-invite/:token" component={AcceptInvite} />

      {/* Platform Routes */}
      <Route path="/platform">
        {() => <ProtectedRoute component={PlatformDashboard} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/companies">
        {() => <ProtectedRoute component={PlatformCompanies} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/users">
        {() => <ProtectedRoute component={PlatformUsers} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/subscriptions">
        {() => <ProtectedRoute component={PlatformSubscriptions} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/analytics">
        {() => <ProtectedRoute component={PlatformAnalytics} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/activity">
        {() => <ProtectedRoute component={PlatformActivity} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/ai">
        {() => <ProtectedRoute component={PlatformAiIntelligence} role="platform" layout={PlatformLayout} />}
      </Route>
      <Route path="/platform/settings">
        {() => <ProtectedRoute component={PlatformSettings} role="platform" layout={PlatformLayout} />}
      </Route>

      {/* Admin Routes */}
      <Route path="/admin">
        {() => <ProtectedRoute component={AdminDashboard} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/contacts">
        {() => <ProtectedRoute component={AdminContacts} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/contacts/new">
        {() => <ProtectedRoute component={AdminContactNew} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/contacts/:id">
        {() => <ProtectedRoute component={AdminContactDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/contacts/:id/:tab">
        {() => <ProtectedRoute component={AdminContactDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/duplicates">
        {() => <ProtectedRoute component={AdminDuplicates} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/leads">
        {() => <ProtectedRoute component={AdminLeads} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/leads/:id">
        {() => <ProtectedRoute component={AdminLeadDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/pipeline-settings">
        {() => <ProtectedRoute component={AdminPipelineSettings} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/tags">
        {() => <ProtectedRoute component={AdminTags} role="admin" layout={AdminLayout} />}
      </Route>
      {/* Batch 17 — Automations (static routes before the dynamic :id route) */}
      <Route path="/admin/automations">
        {() => <ProtectedRoute component={AdminAutomations} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/automations/new">
        {() => <ProtectedRoute component={AdminAutomationEditor} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/automations/runs/:id">
        {() => <ProtectedRoute component={AdminAutomationRunDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/automations/:id">
        {() => <ProtectedRoute component={AdminAutomationEditor} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/events">
        {() => <ProtectedRoute component={AdminEvents} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/events/:id">
        {() => <ProtectedRoute component={AdminEventDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/team">
        {() => <ProtectedRoute component={AdminTeam} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/companies">
        {() => <ProtectedRoute component={AdminCompanies} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/companies/:id">
        {() => <ProtectedRoute component={AdminCompanyDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/departments">
        {() => <ProtectedRoute component={AdminDepartments} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/teams">
        {() => <ProtectedRoute component={AdminTeams} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/directory">
        {() => <ProtectedRoute component={AdminDirectory} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/org-hierarchy">
        {() => <ProtectedRoute component={AdminOrgHierarchy} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/roles">
        {() => <ProtectedRoute component={AdminRoles} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/organization">
        {() => <ProtectedRoute component={AdminOrganization} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/security">
        {() => <ProtectedRoute component={AdminSecurity} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/profile">
        {() => <ProtectedRoute component={AdminProfile} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/reports">
        {() => <ProtectedRoute component={AdminReports} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/analytics">
        {() => <ProtectedRoute component={AdminAnalytics} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/ai-batch">
        {() => <ProtectedRoute component={AdminBatchOperations} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/ai-insights">
        {() => <ProtectedRoute component={AdminAiInsightsReview} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/ai-copilot">
        {() => <ProtectedRoute component={AdminSalesCopilot} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/ai-command">
        {() => <ProtectedRoute component={AdminAiCommandCenter} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/design-system">
        {() => <ProtectedRoute component={AdminDesignSystem} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/workflow">
        {() => <ProtectedRoute component={AdminWorkflow} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/executive">
        {() => <ProtectedRoute component={AdminExecutiveIntelligence} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/ai">
        {() => <ProtectedRoute component={AdminAiSettings} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/subscription">
        {() => <ProtectedRoute component={AdminSubscription} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/settings">
        {() => <ProtectedRoute component={AdminSettings} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/sessions">
        {() => <ProtectedRoute component={AdminSessions} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/scan">
        {() => <ProtectedRoute component={AdminScan} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/notifications">
        {() => <ProtectedRoute component={AdminNotifications} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/documents">
        {() => <ProtectedRoute component={AdminDocuments} role="admin" layout={AdminLayout} />}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  // dev.kaptnow.com is retired from interactive use: every browser request
  // leaves immediately for the same path on the real portal, before any
  // provider, router, or layout mounts — so no portal UI ever renders there.
  // Health endpoints (/healthz, /api/healthz, /api/readyz) are unaffected:
  // they are served by nginx/the API, not by this SPA.
  if (resolvePortalHost() === "retired") {
    return <ExternalRedirect href={retiredHostRedirectUrl()} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
