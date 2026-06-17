import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setAuthTokenGetter } from "@workspace/api-client-react";
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

import AdminDashboard from "@/pages/admin/Dashboard";
import AdminContacts from "@/pages/admin/Contacts";
import AdminContactNew from "@/pages/admin/ContactNew";
import AdminContactDetail from "@/pages/admin/ContactDetail";
import AdminLeads from "@/pages/admin/Leads";
import AdminEvents from "@/pages/admin/Events";
import AdminEventDetail from "@/pages/admin/EventDetail";
import AdminTeam from "@/pages/admin/Team";
import AdminReports from "@/pages/admin/Reports";
import AdminSubscription from "@/pages/admin/Subscription";
import AdminSettings from "@/pages/admin/Settings";
import AdminScan from "@/pages/admin/Scan";

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
  const { user } = useAuth();
  const [, setLocation] = useLocation();

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
      <Route path="/admin/leads">
        {() => <ProtectedRoute component={AdminLeads} role="admin" layout={AdminLayout} />}
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
      <Route path="/admin/reports">
        {() => <ProtectedRoute component={AdminReports} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/subscription">
        {() => <ProtectedRoute component={AdminSubscription} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/settings">
        {() => <ProtectedRoute component={AdminSettings} role="admin" layout={AdminLayout} />}
      </Route>
      <Route path="/admin/scan">
        {() => <ProtectedRoute component={AdminScan} role="admin" layout={AdminLayout} />}
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
