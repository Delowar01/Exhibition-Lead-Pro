import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useBranding } from "@/contexts/BrandingContext";
import { useGetOrganization, getGetOrganizationQueryKey } from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { buildAdminNav } from "./navigation";
import { SidebarNav } from "./SidebarNav";
import { SidebarFooter } from "./SidebarFooter";
import { AppHeader } from "./AppHeader";

const MINI_KEY = "csp_sidebar_mini";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const navGroups = useMemo(() => buildAdminNav(user), [user]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mini, setMini] = useState(() => {
    try {
      return localStorage.getItem(MINI_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [location] = useLocation();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  const toggleMini = () => {
    setMini((prev) => {
      try {
        localStorage.setItem(MINI_KEY, prev ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !prev;
    });
  };

  // Real subscription plan for the sidebar company card (admins only; endpoint is tenant-scoped).
  const { data: org } = useGetOrganization(undefined, {
    query: {
      enabled: !!user && user.role !== "platform_owner",
      staleTime: 5 * 60_000,
      queryKey: getGetOrganizationQueryKey(),
    },
  });
  const companyName = org?.name || user?.companyName || "Company Portal";
  // Batch 18: the sidebar surface takes the tenant's sidebar color only when one is configured.
  const { branding } = useBranding();
  const brandedSidebar = branding?.overrides.sidebarColor != null;
  const logoUrl = branding?.logoUrl ?? null;

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden">
      <AppHeader
        portal="admin"
        navGroups={navGroups}
        onOpenMobileNav={() => setMobileNavOpen(true)}
      />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar (desktop/tablet) */}
        <aside
          className={cn(
            "hidden md:flex bg-card text-card-foreground border-r border-border flex-col flex-shrink-0 transition-[width] duration-150",
            mini ? "w-[68px]" : "w-64",
            brandedSidebar && "tenant-sidebar",
          )}
          data-testid="admin-sidebar"
        >
          <SidebarNav groups={navGroups} storageKey="csp_nav_admin" mini={mini} />
          <SidebarFooter
            companyName={companyName}
            plan={org?.plan}
            mini={mini}
            onToggleMini={toggleMini}
            logoUrl={logoUrl}
          />
        </aside>

        {/* Sidebar (mobile drawer) */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className={cn("w-72 p-0 flex flex-col md:hidden", brandedSidebar && "tenant-sidebar")}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarNav groups={navGroups} storageKey="csp_nav_admin" />
            <SidebarFooter companyName={companyName} plan={org?.plan} mini={false} logoUrl={logoUrl} />
          </SheetContent>
        </Sheet>

        {/* Main column */}
        <main className="flex-1 min-w-0 overflow-y-auto bg-background">
          <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto min-h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
