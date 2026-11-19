import { AppError } from "../middlewares/errorHandler.js";

// G-7 — Platform Owner Analytics: the reporting window.
//
// Pure, clock-injected helpers shared by every /platform/analytics endpoint. A window is a
// whole number of UTC calendar days; the "previous" window has the same length and ends the
// day before `from`. Series are bucketed by UTC day, ISO week (Monday) or calendar month —
// the same boundaries PostgreSQL's date_trunc uses, so the zero-filled bucket list produced
// here always lines up with the grouped rows.

export type Granularity = "day" | "week" | "month";

export interface AnalyticsWindow {
  /** First instant of the window (UTC midnight of `from`). */
  start: Date;
  /** First instant AFTER the window (UTC midnight after `to`). */
  endExclusive: Date;
  days: number;
  granularity: Granularity;
  previousStart: Date;
  previousEndExclusive: Date;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_WINDOW_DAYS = 731;
export const DEFAULT_WINDOW_DAYS = 30;
const MAX_DAILY_WINDOW_DAYS = 366;

function invalid(message: string): never {
  throw new AppError(400, message, { code: "INVALID_ANALYTICS_WINDOW" });
}

export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Calendar years a window may touch. The lower bound predates any data this system can hold;
// the upper bound keeps every derived instant inside the four-digit years the database and
// the ISO format handle.
const MIN_YEAR = 1970;
const MAX_YEAR = 2100;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** UTC midnight of a real calendar day, or a refusal (2026-02-30 is not rolled over to March). */
function calendarDay(y: number, mo: number, da: number, name: "from" | "to"): Date {
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) invalid(`Invalid ${name} date`);
  return d;
}

/**
 * A UTC calendar day from `YYYY-MM-DD`, or from an ISO date-time WITH an explicit zone
 * (`Z` or an offset), which is evaluated as its UTC day. A date-time without a zone is
 * refused: it would otherwise depend on the server's local time zone.
 */
export function parseDay(raw: unknown, name: "from" | "to"): Date | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") invalid(`Invalid ${name} date`);
  const s = raw.trim();
  let day: Date;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    day = calendarDay(Number(m[1]), Number(m[2]), Number(m[3]), name);
  } else {
    const dt = ISO_DATE_TIME.exec(s);
    if (!dt) invalid(`Invalid ${name} date`);
    // The written date must itself be a real day before the instant is converted to UTC.
    calendarDay(Number(dt[1]), Number(dt[2]), Number(dt[3]), name);
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) invalid(`Invalid ${name} date`);
    day = utcDay(t);
  }
  const year = day.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) invalid(`The ${name} date must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  return day;
}

export function defaultGranularity(days: number): Granularity {
  if (days <= 62) return "day";
  if (days <= 366) return "week";
  return "month";
}

export function resolveWindow(query: { from?: unknown; to?: unknown; granularity?: unknown }, now: Date = new Date()): AnalyticsWindow {
  const to = parseDay(query.to, "to") ?? utcDay(now);
  const from = parseDay(query.from, "from") ?? new Date(to.getTime() - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS);
  if (from.getTime() > to.getTime()) invalid("from must not be after to");
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_WINDOW_DAYS) invalid(`The reporting window may span at most ${MAX_WINDOW_DAYS} days`);

  let granularity: Granularity;
  if (query.granularity == null || query.granularity === "") {
    granularity = defaultGranularity(days);
  } else if (query.granularity === "day" || query.granularity === "week" || query.granularity === "month") {
    granularity = query.granularity;
  } else {
    invalid("Invalid granularity");
  }
  if (granularity === "day" && days > MAX_DAILY_WINDOW_DAYS) invalid(`Daily buckets are limited to ${MAX_DAILY_WINDOW_DAYS} days — use week or month`);

  const start = from;
  const endExclusive = new Date(to.getTime() + DAY_MS);
  return {
    start,
    endExclusive,
    days,
    granularity,
    previousStart: new Date(start.getTime() - days * DAY_MS),
    previousEndExclusive: start,
  };
}

/** First day of the bucket that contains `d` — mirrors date_trunc(granularity, timestamp). */
export function bucketStart(d: Date, granularity: Granularity): Date {
  const day = utcDay(d);
  if (granularity === "day") return day;
  if (granularity === "month") return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  // ISO week: Monday. getUTCDay(): 0 = Sunday … 6 = Saturday.
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

function nextBucket(d: Date, granularity: Granularity): Date {
  if (granularity === "day") return new Date(d.getTime() + DAY_MS);
  if (granularity === "week") return new Date(d.getTime() + 7 * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Every bucket key (YYYY-MM-DD of the bucket's first day) that intersects the window, in order. */
export function bucketKeys(w: Pick<AnalyticsWindow, "start" | "endExclusive" | "granularity">): string[] {
  const out: string[] = [];
  for (let b = bucketStart(w.start, w.granularity); b.getTime() < w.endExclusive.getTime(); b = nextBucket(b, w.granularity)) {
    out.push(dayKey(b));
  }
  return out;
}

/** Zero-fills grouped rows onto the window's bucket list. */
export function fillBuckets<T extends object>(
  w: Pick<AnalyticsWindow, "start" | "endExclusive" | "granularity">,
  rows: Array<{ bucket: string } & T>,
  zero: T,
): Array<{ bucket: string } & T> {
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return bucketKeys(w).map((bucket) => {
    const r = byKey.get(bucket);
    return r ? { ...zero, ...r, bucket } : { ...zero, bucket };
  });
}

/** The wire shape of a window (PlatformAnalyticsRange). */
export function describeWindow(w: AnalyticsWindow) {
  return {
    from: dayKey(w.start),
    to: dayKey(new Date(w.endExclusive.getTime() - DAY_MS)),
    days: w.days,
    granularity: w.granularity,
    previousFrom: dayKey(w.previousStart),
    previousTo: dayKey(new Date(w.previousEndExclusive.getTime() - DAY_MS)),
    timezone: "UTC" as const,
  };
}
