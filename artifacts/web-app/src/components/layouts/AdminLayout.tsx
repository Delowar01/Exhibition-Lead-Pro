import React from "react";
import { Link, useLocation } from "wouter";
import { Users, LayoutDashboard, Calendar, CreditCard, Settings, Camera, Contact, BarChart2, LogOut, CopyCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLogout } from "@workspace/api-client-react";

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const logoutMutation = useLogout();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        logout();
      }
    });
  };

  const navItems = [
    { name: "Dashboard", href: "/admin", icon: LayoutDashboard },
    { name: "Contacts", href: "/admin/contacts", icon: Contact },
    { name: "Duplicates", href: "/admin/duplicates", icon: CopyCheck },
    { name: "Leads Pipeline", href: "/admin/leads", icon: BarChart2 },
    { name: "Events", href: "/admin/events", icon: Calendar },
    { name: "Scan Card", href: "/admin/scan", icon: Camera },
    { name: "Team", href: "/admin/team", icon: Users },
    { name: "Reports", href: "/admin/reports", icon: BarChart2 },
    { name: "Subscription", href: "/admin/subscription", icon: CreditCard },
    { name: "Settings", href: "/admin/settings", icon: Settings },
  ];

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-card text-card-foreground border-r border-border flex flex-col flex-shrink-0 shadow-sm relative z-10">
        <div className="p-6 border-b border-border">
          <div className="flex items-center gap-2 text-primary">
            <Camera className="h-6 w-6" />
            <span className="font-bold text-lg tracking-tight">Card Scanner Pro</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1 truncate">
            {user?.companyName || "Company Portal"}
          </div>
        </div>
        
        <nav className="flex-1 py-4 flex flex-col gap-1 px-3 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href;
            const Icon = item.icon;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-all text-sm font-medium ${
                  isActive 
                    ? "bg-primary/10 text-primary" 
                    : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
                {item.name}
              </Link>
            );
          })}
        </nav>
        
        <div className="p-4 border-t border-border mt-auto">
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-xs">
              {user?.name?.substring(0, 2).toUpperCase() || "U"}
            </div>
            <div className="overflow-hidden">
              <p className="text-sm font-medium truncate">{user?.name}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
          </div>
          <button 
            onClick={handleLogout}
            className="flex items-center justify-center gap-2 w-full py-2 px-3 text-sm font-medium rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-[#F8F9FB]">
        <div className="p-8 max-w-7xl mx-auto min-h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
