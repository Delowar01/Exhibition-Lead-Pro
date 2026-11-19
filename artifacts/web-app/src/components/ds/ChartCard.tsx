import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface ChartTableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

/** The data-table twin of a chart: the same figures, readable without colour or hover. */
export interface ChartTable {
  /** Names the table for assistive technology. */
  caption: string;
  columns: ChartTableColumn[];
  rows: Array<Record<string, ReactNode>>;
}

/**
 * A plain data table, scrollable inside its own region so the page never scrolls sideways.
 * `compact` caps its height (the table view of a chart with many periods); a short
 * standalone table shows every row.
 */
export function DataTable({
  table,
  compact = false,
  className,
  testId,
}: {
  table: ChartTable;
  compact?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      role="region"
      aria-label={table.caption}
      tabIndex={0}
      data-testid={testId}
      className={cn(
        "overflow-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact && "max-h-[320px]",
        className,
      )}
    >
      <Table>
        <caption className="sr-only">{table.caption}</caption>
        <TableHeader className="bg-secondary/50">
          <TableRow>
            {table.columns.map((c) => (
              <TableHead key={c.key} scope="col" className={cn("h-auto py-2 align-bottom leading-tight", c.align === "right" && "text-right")}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, i) => (
            <TableRow key={i}>
              {table.columns.map((c, ci) => (
                <TableCell
                  key={c.key}
                  className={cn(
                    "whitespace-nowrap",
                    c.align === "right" && "text-right tabular-nums",
                    ci === 0 && "font-medium text-foreground",
                  )}
                >
                  {row[c.key]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The single card for a chart, a breakdown or a data table on analytics pages.
 *
 * When `table` is given the header offers a Chart / Table switch, so every figure a chart
 * draws is also reachable as text (no value is gated behind colour or a tooltip).
 */
export function ChartCard({
  title,
  description,
  badge,
  action,
  table,
  footer,
  children,
  className,
  testId,
}: {
  title: string;
  description?: ReactNode;
  /** A short qualifier beside the title (for example an "Estimate" badge). */
  badge?: ReactNode;
  /** Right-aligned header slot — usually a link to the related management page. */
  action?: ReactNode;
  table?: ChartTable;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const titleId = useId();
  const toggle = (next: "chart" | "table", label: string) => (
    <button
      type="button"
      aria-pressed={view === next}
      onClick={() => setView(next)}
      className={cn(
        "rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === next ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <section
      aria-labelledby={titleId}
      data-testid={testId}
      className={cn("min-w-0 rounded-xl border border-card-border bg-card text-card-foreground shadow-sm", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 p-5 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="text-base font-semibold leading-tight text-foreground">
              {title}
            </h3>
            {badge}
          </div>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {(action || table) && (
          <div className="flex flex-wrap items-center gap-3">
            {action}
            {table && (
              <div role="group" aria-label={`${title} — view as`} className="inline-flex rounded-md border border-border bg-background p-0.5">
                {toggle("chart", "Chart")}
                {toggle("table", "Table")}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="px-5 pb-5">
        {view === "table" && table ? <DataTable table={table} compact testId={testId ? `${testId}-table` : undefined} /> : children}
        {footer && <div className="mt-3 text-xs text-muted-foreground">{footer}</div>}
      </div>
    </section>
  );
}
