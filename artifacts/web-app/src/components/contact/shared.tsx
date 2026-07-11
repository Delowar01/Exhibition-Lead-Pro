import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  differenceInCalendarDays,
  format,
  isThisMonth,
  isThisWeek,
  isToday,
  isYesterday,
  parseISO,
} from "date-fns";
import { AlertCircle, RefreshCw } from "lucide-react";

/* ── Date helpers ─────────────────────────────────────────────────────────── */

export const TIMELINE_GROUPS = [
  "Today",
  "Yesterday",
  "This Week",
  "Last Week",
  "This Month",
  "Older",
] as const;
export type TimelineGroup = (typeof TIMELINE_GROUPS)[number];

export function timelineGroupFor(dateIso: string): TimelineGroup {
  const d = new Date(dateIso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  if (isThisWeek(d, { weekStartsOn: 1 })) return "This Week";
  const days = differenceInCalendarDays(new Date(), d);
  if (days <= 14) return "Last Week";
  if (isThisMonth(d)) return "This Month";
  return "Older";
}

export function activityGroupFor(dateIso: string): "Today" | "Yesterday" | "Earlier" {
  const d = new Date(dateIso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return "Earlier";
}

export function relativeAge(fromIso: string): string {
  const days = differenceInCalendarDays(new Date(), new Date(fromIso));
  if (days <= 0) return "Today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month" : `${months} months`;
  }
  const years = Math.floor(days / 365);
  const rem = Math.floor((days % 365) / 30);
  return rem > 0 ? `${years}y ${rem}m` : years === 1 ? "1 year" : `${years} years`;
}

export function formatDay(dateIso: string): string {
  const d = dateIso.length === 10 ? parseISO(dateIso) : new Date(dateIso);
  return format(d, "MMM d, yyyy");
}

export function formatTimestamp(dateIso: string): string {
  return format(new Date(dateIso), "MMM d, yyyy · h:mm a");
}

export function formatTimeOnly(dateIso: string): string {
  return format(new Date(dateIso), "h:mm a");
}

/* ── Workspace card shell (spec §75–76: icon + title + optional subtitle) ─── */

export function WorkspaceCard({
  icon,
  title,
  subtitle,
  headerRight,
  children,
  footer,
  className,
  contentClassName,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  testId?: string;
}) {
  return (
    <Card
      className={cn("rounded-2xl border-border/60 shadow-sm flex flex-col", className)}
      data-testid={testId}
    >
      <CardHeader className="p-6 pb-4 flex flex-row items-start justify-between space-y-0 gap-2">
        <div className="min-w-0">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <span className="text-primary shrink-0">{icon}</span>
            <span className="truncate">{title}</span>
          </CardTitle>
          {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
        </div>
        {headerRight && <div className="shrink-0 flex items-center gap-1">{headerRight}</div>}
      </CardHeader>
      <CardContent className={cn("px-6 pb-6 pt-0 flex-1", contentClassName)}>{children}</CardContent>
      {footer && (
        <div className="px-6 pb-5 pt-0 flex items-center justify-end gap-2">{footer}</div>
      )}
    </Card>
  );
}

/* ── Empty / loading / error states ──────────────────────────────────────── */

export function EmptyState({
  icon,
  headline,
  description,
  actions,
  className,
}: {
  icon: React.ReactNode;
  headline: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-10 px-4 rounded-xl border border-dashed border-border bg-secondary/20",
        className,
      )}
    >
      <div className="h-12 w-12 rounded-full bg-primary-soft text-primary flex items-center justify-center mb-3">
        {icon}
      </div>
      <p className="text-sm font-semibold">{headline}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-sm leading-relaxed">{description}</p>
      )}
      {actions && <div className="flex flex-wrap items-center justify-center gap-2 mt-4">{actions}</div>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-10 px-4 rounded-xl border border-destructive/25 bg-destructive-soft/40",
        className,
      )}
      role="alert"
    >
      <AlertCircle className="h-8 w-8 text-destructive mb-2" aria-hidden />
      <p className="text-sm font-medium">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        <RefreshCw className="h-4 w-4 mr-2" /> Retry
      </Button>
    </div>
  );
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  );
}

/* ── Sticky workspace toolbar (spec: 56px, sticky) ───────────────────────── */

export function WorkspaceToolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 min-h-[56px] flex items-center gap-2 flex-wrap sm:flex-nowrap px-3 py-2 rounded-xl border border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-sm",
        className,
      )}
      role="toolbar"
    >
      {children}
    </div>
  );
}

/* ── Stat tile ───────────────────────────────────────────────────────────── */

export function StatTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  const toneCls =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "destructive"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/20 px-3 py-2.5 min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn("text-sm font-semibold mt-0.5 truncate", toneCls)}>{value}</div>
    </div>
  );
}

/* ── Status / priority badges (never color-only: icon + label) ───────────── */

export const TASK_STATUS_META: Record<
  string,
  { label: string; cls: string }
> = {
  pending: { label: "Planned", cls: "bg-info-soft text-info border-info/25" },
  in_progress: { label: "In Progress", cls: "bg-warning-soft text-warning border-warning/25" },
  completed: { label: "Completed", cls: "bg-success-soft text-success border-success/25" },
  overdue: { label: "Overdue", cls: "bg-destructive-soft text-destructive border-destructive/25" },
  rescheduled: { label: "Rescheduled", cls: "bg-warning-soft text-warning border-warning/25" },
  cancelled: { label: "Cancelled", cls: "bg-secondary text-muted-foreground border-border" },
};

/* ── Initials avatar helper ──────────────────────────────────────────────── */

export function initialsOf(first?: string | null, last?: string | null): string {
  const a = (first ?? "").trim().charAt(0);
  const b = (last ?? "").trim().charAt(0);
  return (a + b).toUpperCase() || "?";
}
