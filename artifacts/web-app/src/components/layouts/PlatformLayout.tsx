import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { buildPlatformNav } from "./navigation";
import { SidebarNav } from "./SidebarNav";
import { SidebarFooter } from "./SidebarFooter";
import { AppHeader } from "./AppHeader";

const MINI_KEY = "csp_sidebar_mini_platform";

export function PlatformLayout({ children }: { children: React.ReactNode }) {
  const navGroups = useMemo(() => buildPlatformNav(), []);
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

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden">
      <AppHeader
        portal="platform"
        navGroups={navGroups}
        onOpenMobileNav={() => setMobileNavOpen(true)}
      />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar (desktop/tablet) */}
        <aside
          className={cn(
            "hidden md:flex bg-card text-card-foreground border-r border-border flex-col flex-shrink-0 transition-[width] duration-150",
            mini ? "w-[68px]" : "w-64",
          )}
        >
          <SidebarNav groups={navGroups} storageKey="csp_nav_platform" mini={mini} />
          <SidebarFooter
            companyName="Platform Portal"
            mini={mini}
            onToggleMini={toggleMini}
          />
        </aside>

        {/* Sidebar (mobile drawer) */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-72 p-0 flex flex-col md:hidden">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarNav groups={navGroups} storageKey="csp_nav_platform" />
            <SidebarFooter companyName="Platform Portal" mini={false} />
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
