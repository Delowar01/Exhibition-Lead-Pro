import React from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { Bot, Sparkles, Briefcase, Workflow, LineChart, Layers, SlidersHorizontal } from "lucide-react";

export function AiWorkspaceLayout({ children, activeTab }: { children: React.ReactNode; activeTab: string }) {
  const { user } = useAuth();
  
  const isFullAccess = user?.role === "primary_admin" || user?.role === "platform_owner";
  const execPerms = (user?.permissions as Record<string, string[]> | undefined)?.ai_executive ?? [];
  const canViewExecutive = user?.role !== "platform_owner" && (isFullAccess || execPerms.includes("view"));
  const assistantPerms = (user?.permissions as Record<string, string[]> | undefined)?.ai_assistant ?? [];
  const canViewAssistant = user?.role !== "platform_owner" && (isFullAccess || assistantPerms.includes("view"));

  const navItems = [
    ...(canViewAssistant ? [{ id: "command", name: "Command Center", href: "/admin/ai-command", icon: Bot }] : []),
    { id: "insights", name: "Insights Review", href: "/admin/ai-insights", icon: Sparkles },
    { id: "copilot", name: "Sales Copilot", href: "/admin/ai-copilot", icon: Briefcase },
    { id: "workflow", name: "Workflow Intelligence", href: "/admin/workflow", icon: Workflow },
    ...(canViewExecutive ? [{ id: "executive", name: "Executive Intelligence", href: "/admin/executive", icon: LineChart }] : []),
    { id: "batch", name: "Batch Operations", href: "/admin/ai-batch", icon: Layers },
    { id: "settings", name: "Settings", href: "/admin/ai", icon: SlidersHorizontal },
  ];

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-none px-6 pt-6 pb-2">
        <h1 className="text-3xl font-bold tracking-tight">AI Intelligence Workspace</h1>
        <p className="text-sm text-muted-foreground mt-1">Unified AI operations, insights, configuration, and analysis.</p>
      </div>
      <div className="flex-none px-6 border-b border-border">
        <div className="flex items-center gap-6 overflow-x-auto scrollbar-none">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.name}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {children}
      </div>
    </div>
  );
}
