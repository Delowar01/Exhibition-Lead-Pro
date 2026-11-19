import type { ComponentType, ReactNode } from "react";
import { Link } from "wouter";
import { keepPreviousData, type UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CardGridSkeleton, ErrorState, MetricCard } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  bucketLabel,
  bucketTick,
  deltaOf,
  formatCount,
  type AnalyticsTab,
  type Granularity,
} from "@/lib/platform-analytics";

// G-7 — Platform Owner Analytics: what every tab section shares.

/** The window sent to every /platform/analytics endpoint. */
export interface AnalyticsParams {
  from: string;
  to: string;
  granularity?: Granularity;
}

export interface SectionProps {
  params: AnalyticsParams;
  /** Switches to another tab of the analytics page (keeps the window). */
  onOpenTab: (tab: AnalyticsTab) => void;
}

/** React Query options shared by every section: keep the previous figures on screen while a new window loads. */
export function sectionQuery<K extends readonly unknown[]>(queryKey: K) {
  return { queryKey, placeholderData: keepPreviousData, staleTime: 30_000, retry: 1 } as const;
}

export function SectionSkeleton({ cards = 4, charts = 2 }: { cards?: number; charts?: number }) {
  return (
    <div className="space-y-6" data-testid="analytics-loading" aria-busy="true" aria-label="Loading analytics">
      <CardGridSkeleton cards={cards} />
      <div className={cn("grid gap-6", charts > 1 && "lg:grid-cols-2")}>
        {Array.from({ length: charts }).map((_, i) => (
          <Skeleton key={i} className="h-[340px] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function errorText(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 400) return "This reporting window is not valid. Choose a different range and try again.";
  if (status === 403) return "Platform analytics are available to the Platform Owner only.";
  return "The analytics could not be loaded. Check your connection and try again.";
}

/**
 * The loading / error / stale-data states of one analytics request.
 * While a new window loads, the previous figures stay on screen at reduced opacity
 * (no skeleton flash, no layout jump).
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  children,
}: {
  query: UseQueryResult<T, unknown>;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const retry = (
    <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching} data-testid="analytics-retry">
      <RefreshCw className={cn("mr-2 h-4 w-4", query.isFetching && "animate-spin")} aria-hidden="true" />
      Try again
    </Button>
  );
  if (query.data === undefined) {
    if (query.isError) {
      return (
        <div data-testid="analytics-error">
          <ErrorState title="Analytics unavailable" description={errorText(query.error)} action={retry} />
        </div>
      );
    }
    return <>{skeleton ?? <SectionSkeleton />}</>;
  }
  return (
    <div className="space-y-6">
      {query.isError && (
        <div
          role="alert"
          data-testid="analytics-stale"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-foreground"
        >
          <span>The latest figures could not be loaded. Showing the last figures received.</span>
          {retry}
        </div>
      )}
      <div
        className={cn("space-y-6 transition-opacity", query.isPlaceholderData && "opacity-60")}
        aria-busy={query.isFetching}
        data-refreshing={query.isPlaceholderData ? "true" : "false"}
      >
        {children(query.data)}
      </div>
    </div>
  );
}

/** KPI card for a counted metric with its previous-period comparison. */
export function Kpi({
  label,
  count,
  icon,
  format = formatCount,
  intent = "higher-better",
  testId,
}: {
  label: string;
  count: { current: number; previous: number };
  icon?: ComponentType<{ className?: string }>;
  format?: (n: number) => string;
  intent?: "higher-better" | "lower-better" | "neutral";
  testId?: string;
}) {
  const d = deltaOf(count.current, count.previous);
  const footer =
    d.kind === "none"
      ? "None in either period"
      : d.kind === "new"
        ? "None in the previous period"
        : `vs ${format(count.previous)} in the previous period`;
  return (
    <div data-testid={testId}>
      <MetricCard
        label={label}
        value={format(count.current)}
        icon={icon}
        delta={d.pct ?? undefined}
        deltaIntent={intent}
        footer={footer}
        className="h-full"
      />
    </div>
  );
}

/** KPI card for a value with no comparison (a snapshot "as of now"). */
export function Stat({
  label,
  value,
  note,
  icon,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <MetricCard label={label} value={value} icon={icon} footer={note} className="h-full" />
    </div>
  );
}

export function KpiGrid({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", columns === 4 ? "xl:grid-cols-4" : "lg:grid-cols-3")}>{children}</div>
  );
}

/** A titled group inside a tab, with an optional qualifier badge and link. */
export function SectionHeading({
  title,
  description,
  badge,
  action,
}: {
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          {badge}
        </div>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Link to an existing management page. */
export function PageLink({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

/** Button that opens another analytics tab, styled like a page link. */
export function TabLink({ onClick, children, testId }: { onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** "Unavailable" in place of a figure the system cannot truthfully compute. */
export function Unavailable() {
  return <span className="text-xl font-semibold text-muted-foreground">Unavailable</span>;
}

/** Axis and tooltip formatters for a bucketed series. */
export function bucketFormatters(granularity: Granularity) {
  return {
    xTick: (b: string) => bucketTick(b, granularity),
    xLabel: (b: string) => bucketLabel(b, granularity),
  };
}

/** Column header of the bucket column in a chart's table view. */
export function bucketColumnLabel(granularity: Granularity): string {
  return granularity === "day" ? "Day" : granularity === "week" ? "Week starting" : "Month";
}

/** Small text block for a note that explains what a figure does and does not mean. */
export function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-4 text-center text-sm text-muted-foreground">{children}</p>;
}
