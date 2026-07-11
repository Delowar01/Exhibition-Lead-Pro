import React, { useEffect, useMemo, useState } from "react";
import { Camera } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { buildAdminNav } from "./navigation";
import { SidebarNav } from "./SidebarNav";
import { AppHeader } from "./AppHeader";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const navGroups = useMemo(() => buildAdminNav(user), [user]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [location] = useLocation();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  const brand = (
    <div className="p-5 border-b border-border">
      <div className="flex items-center gap-2 text-primary">
        <Camera className="h-6 w-6" />
        <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
      </div>
      <div className="text-xs text-muted-foreground mt-1 truncate">
        {user?.companyName || "Company Portal"}
      </div>
    </div>
  );

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar (desktop/tablet) */}
      <aside className="hidden md:flex w-64 bg-card text-card-foreground border-r border-border flex-col flex-shrink-0 shadow-sm relative z-10">
        {brand}
        <SidebarNav groups={navGroups} storageKey="csp_nav_admin" />
      </aside>

      {/* Sidebar (mobile drawer) */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72 p-0 flex flex-col md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {brand}
          <SidebarNav groups={navGroups} storageKey="csp_nav_admin" />
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <AppHeader
          portal="admin"
          navGroups={navGroups}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <main className="flex-1 overflow-y-auto bg-background">
          <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto min-h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
