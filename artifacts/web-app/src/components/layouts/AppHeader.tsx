import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Search, Plus, Sparkles, Bell, LogOut, UserCircle, Settings, Contact,
  Calendar, Camera, Menu, ChevronDown, Zap,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useBranding } from "@/contexts/BrandingContext";
import { useLogout, useGetUnreadCount, getGetUnreadCountQueryKey } from "@workspace/api-client-react";
import { ThemeToggle } from "@/components/ds/ThemeToggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandPalette } from "@/components/CommandPalette";
import type { NavGroup } from "./navigation";

interface AppHeaderProps {
  portal: "admin" | "platform";
  navGroups: NavGroup[];
  onOpenMobileNav?: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  platform_owner: "Platform Owner",
  primary_admin: "Primary Admin",
  admin: "Admin",
  employee: "Employee",
};

export function AppHeader({ portal, navGroups, onOpenMobileNav }: AppHeaderProps) {
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();
  const { branding, isTenant } = useBranding();
  const logoutMutation = useLogout();
  // Batch 18: the authenticated tenant portal carries the tenant's identity; the
  // platform portal (and the shared login page) keep the platform brand.
  const tenantIdentity = portal === "admin" && isTenant;
  const tenantName = tenantIdentity ? (user?.companyName || "Company Portal") : null;
  const tenantLogo = tenantIdentity ? branding?.logoUrl ?? null : null;
  const [paletteOpen, setPaletteOpen] = useState(false);

  const isAdmin = portal === "admin";
  const isFullAccess = user?.role === "primary_admin" || user?.role === "platform_owner";
  const assistantPerms = (user?.permissions?.ai_assistant as string[] | undefined) ?? [];
  const canViewAssistant =
    isAdmin && user?.role !== "platform_owner" && (isFullAccess || assistantPerms.includes("view"));

  const { data: unreadData } = useGetUnreadCount({
    query: {
      refetchInterval: 60000,
      queryKey: getGetUnreadCountQueryKey(),
      enabled: isAdmin,
    },
  });
  const unreadCount = isAdmin ? (unreadData?.count ?? 0) : 0;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleLogout = () => {
    logoutMutation.mutate(undefined, { onSettled: () => logout() });
  };

  const iconBtnCls =
    "relative inline-flex items-center justify-center h-11 w-11 rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <header className="sticky top-0 z-30 h-14 shrink-0 bg-sidebar text-sidebar-foreground border-b border-sidebar-border flex items-center gap-2 sm:gap-3 px-3 sm:px-4">
      {onOpenMobileNav && (
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="md:hidden inline-flex items-center justify-center h-11 w-11 shrink-0 rounded-md text-sidebar-foreground/80 hover:bg-sidebar-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="button-mobile-nav"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {/* Brand */}
      <Link
        href={isAdmin ? "/admin" : "/platform"}
        className="flex items-center gap-2 shrink-0 me-1 sm:me-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={tenantName ? `${tenantName} home` : "Lead Capture Pro home"}
        data-testid="link-brand"
        data-brand={tenantIdentity ? "tenant" : "platform"}
      >
        {tenantLogo ? (
          <img
            src={tenantLogo}
            alt=""
            className="h-8 w-8 rounded-lg object-contain bg-white/95 p-0.5 shadow-sm"
            data-testid="brand-logo"
          />
        ) : (
          <span className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary text-primary-foreground shadow-sm" data-testid="brand-mark">
            <Zap className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
        )}
        {tenantName ? (
          <span className="hidden sm:inline font-bold text-base tracking-tight whitespace-nowrap max-w-[220px] truncate" data-testid="brand-name">
            {tenantName}
          </span>
        ) : (
          <span className="hidden sm:inline font-bold text-base tracking-tight whitespace-nowrap" data-testid="brand-name">
            Lead Capture <span className="text-primary">Pro</span>
          </span>
        )}
      </Link>

      {/* Global search */}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label="Search (Ctrl+K)"
        className="flex items-center gap-2 h-11 w-full max-w-md px-3 rounded-lg border border-sidebar-accent bg-sidebar-accent/50 text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="button-global-search"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left truncate">
          {isAdmin ? "Search contacts, companies, leads…" : "Search…"}
        </span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-sidebar-accent bg-sidebar px-1.5 text-[10px] font-medium text-sidebar-foreground/60">
          Ctrl+K
        </kbd>
      </button>

      <div className="flex-1" />

      {isAdmin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Quick create"
              className="inline-flex items-center justify-center h-11 w-11 shrink-0 rounded-full bg-primary text-primary-foreground shadow-sm hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="button-quick-create"
            >
              <Plus className="h-4.5 w-4.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Quick create</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/admin/contacts/new")}>
              <Contact className="mr-2 h-4 w-4" /> New Contact
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/admin/leads")}>
              <Plus className="mr-2 h-4 w-4" /> New Lead
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/admin/events")}>
              <Calendar className="mr-2 h-4 w-4" /> New Event
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/admin/scan")}>
              <Camera className="mr-2 h-4 w-4" /> Scan Card
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {isAdmin && (
        <Link
          href="/admin/notifications"
          aria-label={
            unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
          }
          className={iconBtnCls}
          data-testid="link-notifications"
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-semibold"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Link>
      )}

      {canViewAssistant && (
        <Link href="/admin/ai-command" aria-label="AI Command Center" className={`${iconBtnCls} hidden sm:inline-flex`}>
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </Link>
      )}

      <ThemeToggle variant="sidebar" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="User menu"
            className="flex items-center gap-2 h-11 ps-1 pe-1.5 rounded-lg hover:bg-sidebar-accent transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="button-user-menu"
          >
            <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-primary/25 text-primary font-bold text-xs">
              {user?.name?.substring(0, 2).toUpperCase() || "U"}
            </span>
            <span className="hidden lg:flex flex-col items-start leading-tight max-w-[140px]">
              <span className="text-xs font-semibold truncate w-full text-left">{user?.name}</span>
              <span className="text-[10px] text-sidebar-foreground/60 truncate w-full text-left">
                {ROLE_LABEL[user?.role ?? ""] ?? user?.role}
              </span>
            </span>
            <ChevronDown className="hidden lg:block h-3.5 w-3.5 text-sidebar-foreground/50" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <p className="text-sm font-medium truncate">{user?.name}</p>
            <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {isAdmin && (
            <>
              <DropdownMenuItem onClick={() => navigate("/admin/profile")}>
                <UserCircle className="mr-2 h-4 w-4" /> My Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate("/admin/settings")}>
                <Settings className="mr-2 h-4 w-4" /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" /> Sign Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        navGroups={navGroups}
        portal={portal}
        canViewAssistant={canViewAssistant}
      />
    </header>
  );
}
