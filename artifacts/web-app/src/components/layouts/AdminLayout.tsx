import React, { useMemo } from "react";
import { Camera } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { buildAdminNav } from "./navigation";
import { SidebarNav } from "./SidebarNav";
import { AppHeader } from "./AppHeader";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const navGroups = useMemo(() => buildAdminNav(user), [user]);

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-card text-card-foreground border-r border-border flex flex-col flex-shrink-0 shadow-sm relative z-10">
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2 text-primary">
            <Camera className="h-6 w-6" />
            <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1 truncate">
            {user?.companyName || "Company Portal"}
          </div>
        </div>

        <SidebarNav groups={navGroups} storageKey="csp_nav_admin" />
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <AppHeader portal="admin" navGroups={navGroups} />
        <main className="flex-1 overflow-y-auto bg-background">
          <div className="p-8 max-w-7xl mx-auto min-h-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
