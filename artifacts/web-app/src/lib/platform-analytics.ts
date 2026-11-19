// G-7 — Platform Owner Analytics: pure helpers (no React, no network).
//
// The reporting window, its URL state, the "versus previous period" comparison and every
// label/number format live here so the page stays declarative and this logic can be unit
// tested on its own. All dates are UTC calendar days — the same convention the API uses.

export type Granularity = "day" | "week" | "month";
export type GranularityChoice = Granularity | "auto";
export type RangePreset = "7d" | "30d" | "90d" | "12m" | "custom";
export type AnalyticsTab = "overview" | "growth" | "subscriptions" | "revenue" | "activity" | "ai" | "operations";

export const ANALYTICS_TABS: ReadonlyArray<{ id: AnalyticsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "growth", label: "Growth" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "revenue", label: "Revenue & billing" },
  { id: "activity", label: "Activity" },
  { id: "ai", label: "AI usage" },
  { id: "operations", label: "Operations" },
];

export const RANGE_PRESETS: ReadonlyArray<{ id: Exclude<RangePreset, "custom">; label: string; days: number }> = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "12m", label: "Last 12 months", days: 365 },
];

export const MAX_RANGE_DAYS = 731;
export const MAX_DAILY_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnalyticsState {
  tab: AnalyticsTab;
  preset: RangePreset;
  /** UTC day, YYYY-MM-DD. */
  from: string;
  /** UTC day, YYYY-MM-DD (inclusive). */
  to: string;
  granularity: GranularityChoice;
}

// ── UTC day arithmetic ───────────────────────────────────────────────────────
export function todayUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

/** Parses a strict YYYY-MM-DD calendar day; null for anything else (including 2026-02-30). */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value ? d : null;
}

export function addDays(day: string, delta: number): string {
  const d = parseDay(day);
  if (!d) return day;
  return new Date(d.getTime() + delta * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;
}

export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): { from: string; to: string } {
  const days = RANGE_PRESETS.find((p) => p.id === preset)?.days ?? 30;
  return { from: addDays(today, -(days - 1)), to: today };
}

/** The comparison window: the same number of days, ending the day before `from`. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = daysBetween(from, to);
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/** Why a custom window cannot be used; null when it is valid. */
export function validateRange(from: string, to: string, today: string): string | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return "Enter both dates.";
  if (a.getTime() > b.getTime()) return "The start date must not be after the end date.";
  if (to > today) return "The end date cannot be in the future.";
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return `A window can span at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** The granularity the API uses when none is requested. */
export function defaultGranularity(days: number): Granularity {
  if (days <= 62) return "day";
  if (days <= 366) return "week";
  return "month";
}

/** What is sent to the API: `auto` is omitted; an impossible daily choice falls back to auto. */
export function effectiveGranularity(choice: GranularityChoice, days: number): Granularity | undefined {
  if (choice === "auto") return undefined;
  if (choice === "day" && days > MAX_DAILY_RANGE_DAYS) return undefined;
  return choice;
}

// ── URL state ────────────────────────────────────────────────────────────────
const TAB_IDS = new Set<string>(ANALYTICS_TABS.map((t) => t.id));
const PRESET_IDS = new Set<string>(RANGE_PRESETS.map((p) => p.id));

/** Reads the page state from a query string; anything invalid falls back to the default. */
export function parseAnalyticsSearch(search: string, today: string): AnalyticsState {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tabRaw = q.get("tab") ?? "";
  const tab = (TAB_IDS.has(tabRaw) ? tabRaw : "overview") as AnalyticsTab;
  const gRaw = q.get("granularity") ?? "";
  const granularity: GranularityChoice = gRaw === "day" || gRaw === "week" || gRaw === "month" ? gRaw : "auto";
  const from = q.get("from");
  const to = q.get("to");
  if (from && to && validateRange(from, to, today) === null) {
    return { tab, preset: "custom", from, to, granularity };
  }
  const presetRaw = q.get("range") ?? "";
  const preset = (PRESET_IDS.has(presetRaw) ? presetRaw : "30d") as Exclude<RangePreset, "custom">;
  return { tab, preset, ...presetRange(preset, today), granularity };
}

/** The query string for a state; defaults are omitted so the plain URL stays clean. */
export function buildAnalyticsSearch(state: AnalyticsState): string {
  const q = new URLSearchParams();
  if (state.tab !== "overview") q.set("tab", state.tab);
  if (state.preset === "custom") {
    q.set("from", state.from);
    q.set("to", state.to);
  } else if (state.preset !== "30d") {
    q.set("range", state.preset);
  }
  if (state.granularity !== "auto") q.set("granularity", state.granularity);
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ── comparison with the previous period ──────────────────────────────────────
export interface Delta {
  /** Percentage change, one decimal; null when it cannot be expressed (no previous value). */
  pct: number | null;
  kind: "up" | "down" | "flat" | "new" | "none";
}

export function deltaOf(current: number, previous: number): Delta {
  if (previous === 0) return current === 0 ? { pct: null, kind: "none" } : { pct: null, kind: "new" };
  const pct = Math.round(((current - previous) / previous) * 1000) / 10;
  if (pct === 0) return { pct: 0, kind: "flat" };
  return { pct, kind: pct > 0 ? "up" : "down" };
}

/** The sentence under a KPI: what the previous window measured. */
export function comparisonText(previous: number, format: (n: number) => string = formatCount): string {
  return `${format(previous)} in the previous period`;
}

// ── number and label formats ─────────────────────────────────────────────────
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Compact axis ticks: 1.2K, 3.4M. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(n * 100) / 100);
}

/** USD with enough precision for small AI costs ($0.0042) and no noise for large ones. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

/** Money held in minor units (cents) in the provider's currency. */
export function formatMinor(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.1 ? 1 : 0)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayParts(day: string): { y: number; m: number; d: number } | null {
  const p = parseDay(day);
  return p ? { y: p.getUTCFullYear(), m: p.getUTCMonth(), d: p.getUTCDate() } : null;
}

/** Short axis label of a bucket. */
export function bucketTick(bucket: string, granularity: Granularity): string {
  const p = dayParts(bucket);
  if (!p) return bucket;
  if (granularity === "month") return `${MONTHS[p.m]} ${String(p.y).slice(2)}`;
  return `${MONTHS[p.m]} ${p.d}`;
}

/** Full label of a bucket for tooltips and data tables. */
export function bucketLabel(bucket: string, granularity: Granularity): string {
  const p = dayParts(bucket);
  if (!p) return bucket;
  if (granularity === "month") return `${MONTHS[p.m]} ${p.y}`;
  const day = `${MONTHS[p.m]} ${p.d}, ${p.y}`;
  return granularity === "week" ? `Week of ${day}` : day;
}

export function formatDay(day: string): string {
  const p = dayParts(day);
  return p ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : day;
}

export function rangeLabel(range: { from: string; to: string }): string {
  return `${formatDay(range.from)} – ${formatDay(range.to)}`;
}

export const GRANULARITY_LABEL: Record<Granularity, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

/** snake_case / dotted identifiers as words: "ai_vision" → "AI vision". */
export function humanize(id: string): string {
  const words = id.replace(/[._-]+/g, " ").trim();
  if (!words) return id;
  const s = words.charAt(0).toUpperCase() + words.slice(1);
  return s
    .replace(/\b(ai|qr|nfc|ocr|mfa|api)\b/gi, (w) => w.toUpperCase())
    .replace(/\bvcard\b/gi, "vCard")
    .replace(/\blinkedin\b/gi, "LinkedIn");
}

// ── domain labels ────────────────────────────────────────────────────────────
export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  cancelled: "Cancelled",
  expired: "Expired",
  suspended: "Suspended",
};

export type Tone = "success" | "warning" | "info" | "destructive" | "primary" | "neutral";

export function subscriptionStatusTone(status: string): Tone {
  if (status === "active") return "success";
  if (status === "trialing") return "info";
  if (status === "past_due" || status === "cancelled") return "warning";
  if (status === "expired" || status === "suspended") return "destructive";
  return "neutral";
}

/**
 * Mark colours per subscription status. A subscription status is a state, so it wears the
 * design system's status tokens (never a categorical series colour); every use also prints
 * the status name and its count, so the colour is never the only signal.
 */
export const SUBSCRIPTION_STATUS_COLOR: Record<string, string> = {
  active: "hsl(var(--success))",
  trialing: "hsl(var(--info))",
  past_due: "hsl(var(--warning))",
  cancelled: "hsl(var(--muted-foreground))",
  expired: "hsl(var(--muted-foreground) / 0.5)",
  suspended: "hsl(var(--destructive))",
};

const SUBSCRIPTION_STATUS_ORDER = ["active", "trialing", "past_due", "cancelled", "expired", "suspended"];

/** Status counts as chart items, in one fixed order (active first), each with its label and status colour. */
export function subscriptionStatusItems(byStatus: ReadonlyArray<{ status: string; count: number }>) {
  const counts = new Map(byStatus.map((s) => [s.status, s.count]));
  const order = [...SUBSCRIPTION_STATUS_ORDER, ...byStatus.map((s) => s.status).filter((s) => !SUBSCRIPTION_STATUS_ORDER.includes(s))];
  return order
    .filter((s) => counts.has(s))
    .map((s) => ({
      key: s,
      label: SUBSCRIPTION_STATUS_LABEL[s] ?? humanize(s),
      value: counts.get(s) ?? 0,
      color: SUBSCRIPTION_STATUS_COLOR[s] ?? "hsl(var(--muted-foreground))",
    }));
}

/** Series colours. The design-system chart tokens separate reliably only in these pairings. */
export const SERIES = {
  primary: "hsl(var(--chart-1))",
  secondary: "hsl(var(--chart-2))",
  failure: "hsl(var(--chart-4))",
} as const;

export const REVENUE_REASON: Record<string, string> = {
  NO_VERIFIED_PRICES: "No verified provider prices are registered.",
  NO_ACTIVE_PROVIDER_SUBSCRIPTIONS: "There are no active provider-managed subscriptions.",
  UNPRICED_SUBSCRIPTIONS: "Active provider subscriptions are not bound to verified prices.",
  MIXED_CURRENCIES: "Subscriptions are billed in more than one currency.",
  PARTIAL_UNPRICED: "Some provider subscriptions have no verified price and are not included.",
  PAYMENT_AMOUNTS_NOT_RECORDED: "Invoice and payment amounts are not stored by this system.",
};

export const BILLING_SOURCE_LABEL: Record<string, string> = {
  manual: "Managed manually",
  stripe: "Billing provider",
};

export const LIFECYCLE_FIELDS = [
  { key: "created", label: "New subscriptions" },
  { key: "toTrialing", label: "Trials started" },
  { key: "toActive", label: "Activated" },
  { key: "toPastDue", label: "Became past due" },
  { key: "toCancelled", label: "Cancelled" },
  { key: "toExpired", label: "Expired" },
  { key: "toSuspended", label: "Suspended" },
  { key: "planChanges", label: "Plan changes" },
] as const;

export type LifecycleKey = (typeof LIFECYCLE_FIELDS)[number]["key"];

/** True when every numeric field of every point is zero (nothing to chart). */
export function isEmptySeries<T extends object>(series: readonly T[], keys: ReadonlyArray<keyof T>): boolean {
  return series.every((p) => keys.every((k) => !Number(p[k])));
}

/** Share of each row in the total, for proportional bars (0 when the total is 0). */
export function withShares<T extends { count: number }>(rows: readonly T[]): Array<T & { share: number }> {
  const total = rows.reduce((a, r) => a + r.count, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? r.count / total : 0 }));
}

// ── revenue estimate ─────────────────────────────────────────────────────────
export interface RevenueEstimateInput {
  available: boolean;
  reason: string | null;
  currency: string | null;
  monthlyRecurringMinor: number | null;
  countedSubscriptions: number;
  unpricedSubscriptions: number;
}

export interface RevenueEstimateView {
  /** True only when the API could compute the estimate from verified provider prices. */
  available: boolean;
  /** Formatted estimated monthly recurring revenue, or null when unavailable. */
  mrr: string | null;
  /** Formatted estimated annual run rate (MRR × 12), or null when unavailable. */
  arr: string | null;
  /** Why it is unavailable, or what a partial estimate leaves out; null when there is nothing to add. */
  reason: string | null;
}

/** Presents the API's recurring-revenue estimate. Nothing is computed when the API says it is unavailable. */
export function revenueEstimateView(s: RevenueEstimateInput): RevenueEstimateView {
  const reason = s.reason ? (REVENUE_REASON[s.reason] ?? "The estimate cannot be computed.") : null;
  if (!s.available || s.monthlyRecurringMinor == null || !s.currency) {
    return { available: false, mrr: null, arr: null, reason: reason ?? "The estimate cannot be computed." };
  }
  return {
    available: true,
    mrr: formatMinor(s.monthlyRecurringMinor, s.currency),
    arr: formatMinor(s.monthlyRecurringMinor * 12, s.currency),
    reason,
  };
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}
