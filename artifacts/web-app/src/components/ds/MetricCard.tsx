import type { ComponentType, ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The font size of a figure fitted to its card. 100cqi is the width the figure has (the
 * card is the size container); a bold tabular glyph advances about 0.55 em on average, so
 * the width divided by the number of glyphs and by 0.6 em keeps the text on one line with a
 * margin. Never larger than the ordinary figure (1.875rem), never smaller than 1rem.
 */
function fittedSize(text: string): string {
  return `clamp(1rem, calc(100cqi / ${Math.max(text.length, 1)} / 0.6), 1.875rem)`;
}

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
  deltaIntent = "higher-better",
  icon: Icon,
  footer,
  tone = "default",
  fit = false,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Positive = up (success), negative = down (destructive). */
  delta?: number;
  deltaLabel?: string;
  /**
   * What a rise means for this metric. "higher-better" (default) colours a rise as
   * success; "lower-better" (failures, errors) colours a rise as destructive;
   * "neutral" never colours the change. The arrow always follows the direction.
   */
  deltaIntent?: "higher-better" | "lower-better" | "neutral";
  icon?: ComponentType<{ className?: string }>;
  footer?: ReactNode;
  /**
   * "inverse" is for a card on the dark sidebar surface (pass `bg-sidebar` in className):
   * label, icon, figure and footer then take the sidebar's own text colour, so every part
   * stays readable on it in both themes.
   */
  tone?: "default" | "inverse";
  /**
   * Size a text figure to the card: full size wherever it fits, smaller only as far as
   * needed to stay on one line (a long currency amount in a narrow card). A figure too long
   * even at the smallest size wraps inside the card instead of running past its edge. The
   * card becomes a size container, so use this only where the card's width comes from its
   * layout (a grid cell), not from its content. Other cards are unaffected.
   */
  fit?: boolean;
  className?: string;
}) {
  const fitted = fit && typeof value === "string";
  const up = typeof delta === "number" && delta > 0;
  const down = typeof delta === "number" && delta < 0;
  const good = deltaIntent === "higher-better" ? up : deltaIntent === "lower-better" ? down : false;
  const bad = deltaIntent === "higher-better" ? down : deltaIntent === "lower-better" ? up : false;
  const inverse = tone === "inverse";
  const quiet = inverse ? "text-sidebar-foreground/75" : "text-muted-foreground";
  return (
    <div className={cn("rounded-lg border border-card-border bg-card p-5 shadow-sm", fitted && "@container", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className={cn("text-sm font-medium truncate", quiet)} title={label}>{label}</p>
        {Icon && <Icon className={cn("h-4 w-4 shrink-0", quiet)} aria-hidden="true" />}
      </div>
      <p className={cn("mt-2 text-3xl font-bold tracking-tight tabular-nums", inverse ? "text-sidebar-foreground" : "text-foreground")}>
        {fitted ? (
          <span className="inline-block max-w-full align-bottom [overflow-wrap:anywhere]" style={{ fontSize: fittedSize(value) }}>
            {value}
          </span>
        ) : (
          value
        )}
      </p>
      {(typeof delta === "number" || footer) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {typeof delta === "number" && (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                good && "text-success",
                bad && "text-destructive",
                !good && !bad && quiet,
              )}
            >
              {up && <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />}
              {down && <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />}
              {delta > 0 ? "+" : ""}
              {delta}%{deltaLabel ? <span className={cn("font-normal", quiet)}> {deltaLabel}</span> : null}
            </span>
          )}
          {footer && <span className={quiet}>{footer}</span>}
        </div>
      )}
    </div>
  );
}
