import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";

// Pages
import NotFound from "@/pages/not-found";
import Login from "@/pages/Login";
import PlatformDashboard from "@/pages/platform/Dashboard";
import PlatformCompanies from "@/pages/platform/Companies";
import PlatformUsers from "@/pages/platform/Users";
import PlatformSubscriptions from "@/pages/platform/Subscriptions";
import PlatformAnalytics from "@/pages/platform/Analytics";
import PlatformActivity from "@/pages/platform/Activity";
import PlatformSettings from "@/pages/platform/Settings";
import PlatformAiIntelligence from "@/pages/platform/AiIntelligence";

import AdminDashboard from "@/pages/admin/Dashboard";
import AdminContacts from "@/pages/admin/Contacts";
import AdminContactNew from "@/pages/admin/ContactNew";
import AdminContactDetail from "@/pages/admin/ContactDetail";
import AdminDuplicates from "@/pages/admin/Duplicates";
import AdminLeads from "@/pages/admin/Leads";
import AdminLeadDetail from "@/pages/admin/LeadDetail";
import AdminPipelineSettings from "@/pages/admin/PipelineSettings";
import AdminTags from "@/pages/admin/Tags";
import AdminEvents from "@/pages/admin/Events";
import AdminEventDetail from "@/pages/admin/EventDetail";
import AdminTeam from "@/pages/admin/Team";
import AdminDepartments from "@/pages/admin/Departments";
import AdminTeams from "@/pages/admin/Teams";
import AdminDirectory from "@/pages/admin/Directory";
import AdminOrgHierarchy from "@/pages/admin/OrgHierarchy";
import AdminRoles from "@/pages/admin/Roles";
import AdminOrganization from "@/pages/admin/Organization";
import AdminSecurity from "@/pages/admin/Security";
import AdminProfile from "@/pages/admin/Profile";
import AdminReports from "@/pages/admin/Reports";
import AdminAnalytics from "@/pages/admin/Analytics";
import AdminAiSettings from "@/pages/admin/AiSettings";
import AdminSubscription from "@/pages/admin/Subscription";
import AdminSettings from "@/pages/admin/Settings";
import AdminScan from "@/pages/admin/Scan";
import AdminSessions from "@/pages/admin/Sessions";
import AdminNotifications from "@/pages/admin/Notifications";
import AdminDocuments from "@/pages/admin/Documents";
import PublicCard from "@/pages/PublicCard";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import VerifyEmail from "@/pages/VerifyEmail";
import AcceptInvite from "@/pages/AcceptInvite";

import { PlatformLayout } from "@/components/layouts/PlatformLayout";
import { AdminLayout } from "@/components/layouts/AdminLayout";
import { useEffect } from "react";

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

function ProtectedRoute({ component: Component, role, layout: Layout }: any) {
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading) {
      if (!user) {
        setLocation("/login");
      } else if (role === "platform" && user.role !== "platform_owner") {
        setLocation("/admin");
      } else if (role === "admin" && user.role === "platform_owner") {
        setLocation("/platform");
      }
    }
  }, [user, isLoading, setLocation, role]);

  if (isLoading || !user) {
    return <div className="flex h-screen w-screen items-center justify-center">Loading...</div>;
  }

  return (
    <Layout>
      <Component />
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
      if (user?.role === "platform_owner") {
        setLocation("/platform");
      } else if (user) {
        setLocation("/admin");
      } else {
        setLocation("/login");
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
      <Route path="/admin/events">
        {() => <ProtectedRoute component={AdminEvents} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/events/:id">
        {() => <ProtectedRoute component={AdminEventDetail} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/team">
        {() => <ProtectedRoute component={AdminTeam} role="admin" layout={AdminLayout} />}
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
