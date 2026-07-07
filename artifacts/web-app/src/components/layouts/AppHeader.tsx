import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Search, Plus, Sparkles, Bell, LogOut, UserCircle, Settings, Contact,
  Calendar, Camera,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
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
}

export function AppHeader({ portal, navGroups }: AppHeaderProps) {
  const [, navigate] = useLocation();
  const { user, logout } = useAuth();
  const logoutMutation = useLogout();
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

  return (
    <header className="sticky top-0 z-20 h-14 shrink-0 bg-card border-b border-border flex items-center gap-2 px-4">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label="Search (Ctrl+K)"
        className="flex items-center gap-2 h-9 w-full max-w-sm px-3 rounded-md border border-border bg-background text-sm text-muted-foreground hover:bg-secondary/60 transition-colors"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left truncate">
          {isAdmin ? "Search pages, contacts, actions…" : "Search…"}
        </span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      <div className="flex-1" />

      {isAdmin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Quick create"
              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
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

      {canViewAssistant && (
        <Link
          href="/admin/ai-command"
          aria-label="AI Command Center"
          className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </Link>
      )}

      {isAdmin && (
        <Link
          href="/admin/notifications"
          aria-label={
            unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
          }
          className="relative inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Link>
      )}

      <ThemeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="User menu"
            className="inline-flex items-center justify-center h-9 w-9 rounded-full bg-primary/20 text-primary font-bold text-xs hover:ring-2 hover:ring-primary/30 transition-shadow"
          >
            {user?.name?.substring(0, 2).toUpperCase() || "U"}
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
