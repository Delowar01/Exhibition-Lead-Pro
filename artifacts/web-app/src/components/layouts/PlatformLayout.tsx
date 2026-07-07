import React, { useMemo } from "react";
import { LayoutDashboard } from "lucide-react";
import { buildPlatformNav } from "./navigation";
import { SidebarNav } from "./SidebarNav";
import { AppHeader } from "./AppHeader";

export function PlatformLayout({ children }: { children: React.ReactNode }) {
  const navGroups = useMemo(() => buildPlatformNav(), []);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col flex-shrink-0">
        <div className="p-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2 text-primary">
            <LayoutDashboard className="h-6 w-6" />
            <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
          </div>
          <div className="text-xs text-sidebar-foreground/50 mt-1 uppercase tracking-wider font-semibold">
            Platform Portal
          </div>
        </div>

        <SidebarNav groups={navGroups} storageKey="csp_nav_platform" />
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <AppHeader portal="platform" navGroups={navGroups} />
        <main className="flex-1 overflow-y-auto bg-background">
          <div className="p-8 max-w-7xl mx-auto min-h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
