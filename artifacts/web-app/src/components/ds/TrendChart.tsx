import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

export interface TrendSeries {
  key: string;
  label: string;
  /** A design-system colour token, e.g. `hsl(var(--chart-1))`. */
  color: string;
}

/** A row of the series: the x value plus one numeric field per series key. */
type Point = object;

const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 12, tickLine: false, axisLine: false } as const;

function plainNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 100) / 100);
}

function compactTick(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${Math.round(n / 1_000)}K`;
  return plainNumber(n);
}

/** Series key list: a swatch that mirrors the mark, with the name in a text token. */
export function ChartLegend({ series, kind, className }: { series: TrendSeries[]; kind: "line" | "bar"; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground", className)} data-testid="chart-legend">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={kind === "line" ? "h-0.5 w-4 rounded-full" : "h-2.5 w-2.5 rounded-sm"}
            style={{ backgroundColor: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function TrendTooltip({
  active,
  payload,
  label,
  series,
  xLabel,
  valueFormat,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | string }>;
  label?: string | number;
  series: TrendSeries[];
  xLabel: (x: string) => string;
  valueFormat: (n: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byKey = new Map(payload.map((p) => [String(p.dataKey), p.value]));
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium text-foreground">{xLabel(String(label ?? ""))}</p>
      <ul className="space-y-0.5">
        {series.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
            <span className="font-semibold tabular-nums text-foreground">{valueFormat(Number(byKey.get(s.key) ?? 0))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The single time-series chart for analytics pages.
 *
 * - `area`  — one series: a 2px line over a light wash.
 * - `line`  — two series compared on ONE axis.
 * - `bar`   — counts per bucket; with `stacked`, the parts of one total.
 *
 * One y-axis only, never two. With two or more series a legend is always shown and the
 * tooltip lists every series at the hovered bucket; a single series needs no legend — the
 * card title names it. Colour never carries a value alone: pair the chart with a
 * `ChartCard` table view. Arrow keys move the tooltip once the chart is focused.
 */
export function TrendChart({
  data,
  series,
  kind = "area",
  stacked = false,
  xKey = "bucket",
  xTick = (x) => x,
  xLabel = (x) => x,
  valueFormat = plainNumber,
  tickFormat = compactTick,
  allowDecimals = false,
  height = 260,
  ariaLabel,
  empty,
}: {
  data: readonly Point[];
  series: TrendSeries[];
  kind?: "area" | "line" | "bar";
  stacked?: boolean;
  xKey?: string;
  /** Short axis label of an x value. */
  xTick?: (x: string) => string;
  /** Full label of an x value (tooltip). */
  xLabel?: (x: string) => string;
  valueFormat?: (n: number) => string;
  tickFormat?: (n: number) => string;
  allowDecimals?: boolean;
  height?: number;
  ariaLabel: string;
  /** Rendered instead of the plot when every value is zero. */
  empty?: ReactNode;
}) {
  const rows = data as readonly Record<string, unknown>[];
  const hasValues = rows.some((p) => series.some((s) => Number(p[s.key]) !== 0));
  if (!hasValues && empty) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: height }} data-testid="chart-empty">
        {empty}
      </div>
    );
  }

  const margin = { top: 8, right: 8, left: 0, bottom: 0 };
  const grid = <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />;
  const xAxis = <XAxis dataKey={xKey} tickFormatter={(v) => xTick(String(v))} minTickGap={28} tickMargin={6} {...AXIS} />;
  const yAxis = <YAxis width={44} allowDecimals={allowDecimals} tickFormatter={(v) => tickFormat(Number(v))} {...AXIS} />;
  const tooltip = (cursor: object) => (
    <Tooltip
      cursor={cursor}
      isAnimationActive={false}
      content={<TrendTooltip series={series} xLabel={xLabel} valueFormat={valueFormat} />}
    />
  );
  const lineCursor = { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1 };
  const activeDot = { r: 4, stroke: "hsl(var(--card))", strokeWidth: 2 };

  let chart: ReactNode;
  if (kind === "bar") {
    chart = (
      <BarChart data={rows as Record<string, unknown>[]} margin={margin} accessibilityLayer barCategoryGap="20%">
        {grid}
        {xAxis}
        {yAxis}
        {tooltip({ fill: "hsl(var(--muted))", opacity: 0.6 })}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId={stacked ? "total" : undefined}
            fill={s.color}
            maxBarSize={24}
            // A surface-coloured edge is the 2px gap between touching segments.
            stroke="hsl(var(--card))"
            strokeWidth={stacked ? 1 : 0}
            radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    );
  } else if (kind === "line") {
    chart = (
      <LineChart data={rows as Record<string, unknown>[]} margin={margin} accessibilityLayer>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip(lineCursor)}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={activeDot}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  } else {
    chart = (
      <AreaChart data={rows as Record<string, unknown>[]} margin={margin} accessibilityLayer>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip(lineCursor)}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            fill={s.color}
            fillOpacity={0.1}
            dot={false}
            activeDot={activeDot}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  }

  return (
    <figure aria-label={ariaLabel} className="m-0 min-w-0" data-testid="trend-chart">
      {series.length > 1 && <ChartLegend series={series} kind={kind === "bar" ? "bar" : "line"} className="mb-3" />}
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
