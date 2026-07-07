import type { ComponentType, ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The single KPI / metric card for dashboards and report pages.
 * Replaces the duplicated stat-card implementations across
 * KpiCards.tsx and the portal dashboards.
 */
export function MetricCard({
  label,
  value,
  delta,
  deltaLabel,
  icon: Icon,
  footer,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Positive = up (success), negative = down (destructive). */
  delta?: number;
  deltaLabel?: string;
  icon?: ComponentType<{ className?: string }>;
  footer?: ReactNode;
  className?: string;
}) {
  const up = typeof delta === "number" && delta > 0;
  const down = typeof delta === "number" && delta < 0;
  return (
    <div className={cn("rounded-lg border border-card-border bg-card p-5 shadow-sm", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground truncate">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />}
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight text-foreground tabular-nums">{value}</p>
      {(typeof delta === "number" || footer) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {typeof delta === "number" && (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                up && "text-success",
                down && "text-destructive",
                !up && !down && "text-muted-foreground",
              )}
            >
              {up && <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />}
              {down && <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />}
              {delta > 0 ? "+" : ""}
              {delta}%{deltaLabel ? <span className="text-muted-foreground font-normal"> {deltaLabel}</span> : null}
            </span>
          )}
          {footer && <span className="text-muted-foreground">{footer}</span>}
        </div>
      )}
    </div>
  );
}
