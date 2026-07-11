import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavGroup } from "./navigation";

interface SidebarNavProps {
  groups: NavGroup[];
  storageKey: string;
  /** Icon-only rail mode (desktop collapse). */
  mini?: boolean;
}

function loadCollapsed(storageKey: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return {};
}

export function SidebarNav({ groups, storageKey, mini = false }: SidebarNavProps) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    loadCollapsed(storageKey),
  );

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed, storageKey]);

  const isItemActive = (href: string) =>
    location === href ||
    (href !== "/admin" && href !== "/platform" && location.startsWith(href + "/"));

  const toggle = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <nav
      aria-label="Primary"
      className={cn("flex-1 py-3 flex flex-col gap-0.5 overflow-y-auto", mini ? "px-2" : "px-3")}
    >
      {groups.map((group) => {
        const hasActive = group.items.some((i) => isItemActive(i.href));
        // Active group is always expanded so the current page is never hidden.
        const isCollapsed = !mini && !hasActive && !!collapsed[group.id];
        const listId = `nav-group-${group.id}`;

        const itemNodes = (
          <ul id={listId} className="flex flex-col gap-0.5 list-none m-0 p-0">
            {group.items.map((item) => {
              const isActive = isItemActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    title={mini ? item.name : undefined}
                    className={cn(
                      "flex items-center rounded-lg transition-colors duration-150 text-sm font-medium",
                      mini ? "justify-center h-10 w-10 mx-auto" : "gap-3 px-3 py-2",
                      isActive
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {!mini && <span className="flex-1 truncate">{item.name}</span>}
                    {mini && <span className="sr-only">{item.name}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        );

        if (!group.label || mini) {
          return (
            <div key={group.id} className={cn("mb-1", mini && group.label ? "pt-2 mt-1 border-t border-border/60" : "")}>
              {itemNodes}
            </div>
          );
        }

        return (
          <div key={group.id} className="mt-2 first:mt-0">
            <button
              type="button"
              onClick={() => toggle(group.id)}
              aria-expanded={!isCollapsed}
              aria-controls={listId}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-foreground rounded-md transition-colors"
            >
              <span>{group.label}</span>
              <ChevronDown
                aria-hidden="true"
                className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${
                  isCollapsed ? "-rotate-90" : ""
                }`}
              />
            </button>
            {!isCollapsed && itemNodes}
          </div>
        );
      })}
    </nav>
  );
}
