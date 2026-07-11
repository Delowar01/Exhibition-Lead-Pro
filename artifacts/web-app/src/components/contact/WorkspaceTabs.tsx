import React, { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Activity,
  Bot,
  FileText,
  History,
  LayoutDashboard,
  MessagesSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const WORKSPACE_IDS = [
  "overview",
  "timeline",
  "activities",
  "documents",
  "interactions",
  "ai",
] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

const TAB_META: Record<WorkspaceId, { label: string; icon: React.ReactNode }> = {
  overview: { label: "Overview", icon: <LayoutDashboard className="h-4 w-4" aria-hidden /> },
  timeline: { label: "Timeline", icon: <History className="h-4 w-4" aria-hidden /> },
  activities: { label: "Activities", icon: <Activity className="h-4 w-4" aria-hidden /> },
  documents: { label: "Documents", icon: <FileText className="h-4 w-4" aria-hidden /> },
  interactions: { label: "Interactions", icon: <MessagesSquare className="h-4 w-4" aria-hidden /> },
  ai: { label: "AI Assistant", icon: <Bot className="h-4 w-4" aria-hidden /> },
};

export interface WorkspaceTabsProps {
  active: WorkspaceId;
  onChange: (id: WorkspaceId) => void;
  badges?: Partial<Record<WorkspaceId, number>>;
}

export default function WorkspaceTabs({ active, onChange, badges }: WorkspaceTabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Ctrl/Cmd + 1..6 switches workspaces (spec §57).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < WORKSPACE_IDS.length) {
        e.preventDefault();
        onChange(WORKSPACE_IDS[idx]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onChange]);

  // Arrow-key roving focus on the tablist (spec §63).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIdx = WORKSPACE_IDS.indexOf(active);
      let nextIdx: number | null = null;
      if (e.key === "ArrowRight") nextIdx = (currentIdx + 1) % WORKSPACE_IDS.length;
      if (e.key === "ArrowLeft")
        nextIdx = (currentIdx - 1 + WORKSPACE_IDS.length) % WORKSPACE_IDS.length;
      if (e.key === "Home") nextIdx = 0;
      if (e.key === "End") nextIdx = WORKSPACE_IDS.length - 1;
      if (nextIdx !== null) {
        e.preventDefault();
        const next = WORKSPACE_IDS[nextIdx];
        onChange(next);
        const btn = listRef.current?.querySelector<HTMLButtonElement>(
          `[data-workspace-tab="${next}"]`,
        );
        btn?.focus();
        btn?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    },
    [active, onChange],
  );

  return (
    <nav
      className="sticky top-0 z-20 h-12 rounded-xl border border-border/60 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/90 shadow-sm px-3 flex items-end"
      aria-label="Contact workspaces"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Workspace tabs"
        onKeyDown={onKeyDown}
        className="flex items-end gap-1 overflow-x-auto w-full scrollbar-none h-full"
      >
        {WORKSPACE_IDS.map((id) => {
          const meta = TAB_META[id];
          const isActive = id === active;
          const badge = badges?.[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`workspace-panel-${id}`}
              id={`workspace-tab-${id}`}
              tabIndex={isActive ? 0 : -1}
              data-workspace-tab={id}
              data-testid={`tab-${id}`}
              onClick={() => onChange(id)}
              className={cn(
                "flex items-center justify-center gap-2 h-full px-4 border-b-2 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-t-md",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/60",
              )}
            >
              {meta.icon}
              {meta.label}
              {typeof badge === "number" && badge > 0 && (
                <Badge
                  variant="secondary"
                  className={cn(
                    "text-[10px] px-1.5 py-0 h-4 min-w-4 justify-center",
                    isActive && "bg-primary text-primary-foreground",
                  )}
                >
                  {badge > 99 ? "99+" : badge}
                </Badge>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
