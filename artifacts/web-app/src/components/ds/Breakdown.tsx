import type { ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

export interface BreakdownItem {
  key: string;
  label: string;
  value: number;
  /** Mark colour (a design-system token). Omit for the single default hue. */
  color?: string;
  /** Makes the label a link to the related page. */
  href?: string;
  /** Secondary text under the label (for example the previous period's figure). */
  hint?: ReactNode;
}

function defaultFormat(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function shareText(value: number, total: number): string {
  if (total <= 0) return "0%";
  const pct = (value / total) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * One whole split into its parts, as a thin bar with a 2px surface gap between segments.
 * It prints no text: use it above a `BreakdownList` that names every part and its figure.
 */
export function SegmentedBar({ items, label, className }: { items: BreakdownItem[]; label: string; className?: string }) {
  const parts = items.filter((i) => i.value > 0);
  const total = parts.reduce((a, i) => a + i.value, 0);
  const summary = parts.map((i) => `${i.label} ${defaultFormat(i.value)} (${shareText(i.value, total)})`).join(", ");
  return (
    <div
      role="img"
      aria-label={total > 0 ? `${label}: ${summary}` : `${label}: no data`}
      data-testid="segmented-bar"
      className={cn("flex h-2 w-full gap-0.5 overflow-hidden rounded-full", total === 0 && "bg-muted", className)}
    >
      {parts.map((i) => (
        <span
          key={i.key}
          className="h-full min-w-[2px] rounded-full"
          style={{ flexGrow: i.value, flexBasis: 0, backgroundColor: i.color ?? "hsl(var(--primary))" }}
        />
      ))}
    </div>
  );
}

/**
 * Ranked horizontal bars: a name, a bar and a figure per row, bars on one baseline.
 * The part-to-whole and "top N" pattern for analytics pages (used instead of a donut —
 * close values stay comparable and every row prints its own figure and share).
 *
 * When the rows are only the largest parts of a longer list, pass the true `total`: the
 * shares are then computed against it, and the remainder is shown as its own "Other" row
 * instead of silently disappearing.
 */
export function BreakdownList({
  items,
  valueFormat = defaultFormat,
  showShare = true,
  total,
  otherLabel = "Other",
  empty = "No data for this period.",
  label,
  testId,
  className,
}: {
  items: BreakdownItem[];
  valueFormat?: (n: number) => string;
  /** Print each row's share of the total beside its figure. */
  showShare?: boolean;
  /** The total the rows are parts of, when it is larger than their sum (a truncated list). */
  total?: number;
  /** Name of the row that carries the remainder up to `total`. */
  otherLabel?: string;
  empty?: ReactNode;
  /** Names the list for assistive technology. */
  label: string;
  testId?: string;
  className?: string;
}) {
  const listed = items.reduce((a, i) => a + i.value, 0);
  const whole = Math.max(total ?? listed, listed);
  const rows: BreakdownItem[] = whole > listed ? [...items, { key: "__other", label: otherLabel, value: whole - listed, color: "hsl(var(--muted-foreground))" }] : items;
  const max = rows.reduce((a, i) => Math.max(a, i.value), 0);
  if (rows.length === 0 || whole === 0) {
    return (
      <p className={cn("py-6 text-center text-sm text-muted-foreground", className)} data-testid={testId ? `${testId}-empty` : undefined}>
        {empty}
      </p>
    );
  }
  return (
    <ul aria-label={label} className={cn("space-y-3", className)} data-testid={testId}>
      {rows.map((i) => (
        <li key={i.key} data-testid={testId ? `${testId}-row-${i.key}` : undefined}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {i.color && <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: i.color }} />}
              {i.href ? (
                <Link href={i.href} className="truncate font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline">
                  {i.label}
                </Link>
              ) : (
                <span className="truncate font-medium text-foreground">{i.label}</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-foreground">
              <span className="font-semibold">{valueFormat(i.value)}</span>
              {showShare && <span className="ml-2 text-xs text-muted-foreground">{shareText(i.value, whole)}</span>}
            </span>
          </div>
          <div aria-hidden="true" className="mt-1.5 h-2 w-full rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: `${max > 0 ? Math.max((i.value / max) * 100, i.value > 0 ? 1.5 : 0) : 0}%`, backgroundColor: i.color ?? "hsl(var(--primary))" }}
            />
          </div>
          {i.hint && <p className="mt-1 text-xs text-muted-foreground">{i.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
