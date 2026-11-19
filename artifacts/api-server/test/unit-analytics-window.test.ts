import { describe, it, expect } from "vitest";
import {
  resolveWindow,
  parseDay,
  bucketStart,
  bucketKeys,
  fillBuckets,
  describeWindow,
  defaultGranularity,
  dayKey,
  utcDay,
  MAX_WINDOW_DAYS,
  DEFAULT_WINDOW_DAYS,
} from "../src/lib/analytics-window.js";

// G-7 — pure unit coverage of the analytics reporting window (no DB, no live API):
// UTC-day parsing, window length limits, the "previous" window, and the bucket boundaries
// that must match PostgreSQL's date_trunc (day, ISO week starting Monday, calendar month).

const NOW = new Date("2026-11-19T15:30:00.000Z");
const iso = (d: Date) => d.toISOString();

function refusal(fn: () => unknown): { status: number; code?: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { statusCode?: number; status?: number; code?: string; message: string; details?: { code?: string } };
    return { status: e.statusCode ?? e.status ?? 0, code: e.code ?? e.details?.code, message: e.message };
  }
  throw new Error("expected a refusal");
}

describe("parseDay", () => {
  it("parses a calendar day as UTC midnight", () => {
    expect(iso(parseDay("2026-03-01", "from")!)).toBe("2026-03-01T00:00:00.000Z");
    expect(iso(parseDay(" 2024-02-29 ", "to")!)).toBe("2024-02-29T00:00:00.000Z"); // leap day, trimmed
  });

  it("evaluates an ISO date-time with a zone as its UTC day", () => {
    expect(iso(parseDay("2026-03-01T23:30:00+05:00", "from")!)).toBe("2026-03-01T00:00:00.000Z");
    expect(iso(parseDay("2026-03-01T22:30:00-03:00", "from")!)).toBe("2026-03-02T00:00:00.000Z"); // next UTC day
    expect(iso(parseDay("2026-03-01T02:00:00+05:00", "from")!)).toBe("2026-02-28T00:00:00.000Z"); // previous UTC day
    expect(iso(parseDay("2026-03-01T10:00:00Z", "to")!)).toBe("2026-03-01T00:00:00.000Z");
    expect(iso(parseDay("2026-03-01T10:00Z", "to")!)).toBe("2026-03-01T00:00:00.000Z");
    expect(iso(parseDay("2026-03-01T10:00:00.123456Z", "to")!)).toBe("2026-03-01T00:00:00.000Z");
    expect(iso(parseDay("2026-03-01T10:00:00+0530", "to")!)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("refuses a date-time without a zone — it would depend on the server's time zone", () => {
    for (const bad of ["2026-03-01T10:00:00", "2026-03-01T10:00", "2026-03-01T", "2026-03-01T10", "2026-03-01 10:00:00Z"]) {
      expect(refusal(() => parseDay(bad, "from")).status, bad).toBe(400);
    }
  });

  it("refuses an impossible day inside a date-time instead of rolling it over", () => {
    for (const bad of ["2026-02-30T00:00:00Z", "2025-02-29T12:00:00+02:00", "2026-13-01T00:00:00Z", "2026-04-31T23:59:59Z", "2026-03-01T25:00:00Z"]) {
      expect(refusal(() => parseDay(bad, "to")).status, bad).toBe(400);
    }
  });

  it("refuses years outside the supported range", () => {
    expect(iso(parseDay("1970-01-01", "from")!)).toBe("1970-01-01T00:00:00.000Z");
    expect(iso(parseDay("2100-12-31", "to")!)).toBe("2100-12-31T00:00:00.000Z");
    for (const bad of ["1969-12-31", "2101-01-01", "9999-12-31", "0001-01-01", "9999-12-31T00:00:00Z"]) {
      const r = refusal(() => parseDay(bad, "to"));
      expect(r.status, bad).toBe(400);
      expect(r.code, bad).toBe("INVALID_ANALYTICS_WINDOW");
    }
    // An offset can push a date-time over the edge of the range.
    expect(refusal(() => parseDay("2100-12-31T23:00:00-05:00", "to")).status).toBe(400);
  });

  it("treats a missing value as absent", () => {
    expect(parseDay(undefined, "from")).toBeNull();
    expect(parseDay(null, "from")).toBeNull();
    expect(parseDay("", "to")).toBeNull();
  });

  it("refuses impossible days instead of rolling them over", () => {
    for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      expect(refusal(() => parseDay(bad, "from")).status, bad).toBe(400);
    }
  });

  it("refuses anything that is not an ISO day or date-time", () => {
    for (const bad of ["yesterday", "20260301", "1764000000000", "03/01/2026", "2026-3-1", "2026-03-01Tgarbage", 20260301, ["2026-03-01"], {}]) {
      const r = refusal(() => parseDay(bad, "to"));
      expect(r.status, String(bad)).toBe(400);
      expect(r.message).toContain("to");
    }
  });
});

describe("resolveWindow", () => {
  it("defaults to the last 30 UTC days ending today", () => {
    const w = resolveWindow({}, NOW);
    expect(w.days).toBe(DEFAULT_WINDOW_DAYS);
    expect(iso(w.start)).toBe("2026-10-21T00:00:00.000Z");
    expect(iso(w.endExclusive)).toBe("2026-11-20T00:00:00.000Z");
    expect(w.granularity).toBe("day");
    expect(describeWindow(w)).toEqual({ from: "2026-10-21", to: "2026-11-19", days: 30, granularity: "day", previousFrom: "2026-09-21", previousTo: "2026-10-20", timezone: "UTC" });
  });

  it("uses today as the end when only `from` is given, and 30 days back when only `to` is given", () => {
    expect(describeWindow(resolveWindow({ from: "2026-11-01" }, NOW))).toMatchObject({ from: "2026-11-01", to: "2026-11-19", days: 19 });
    expect(describeWindow(resolveWindow({ to: "2026-01-30" }, NOW))).toMatchObject({ from: "2026-01-01", to: "2026-01-30", days: 30 });
  });

  it("includes both end days and makes the previous window equally long and adjacent", () => {
    const w = resolveWindow({ from: "2026-03-01", to: "2026-03-07" }, NOW);
    expect(w.days).toBe(7);
    expect(iso(w.previousStart)).toBe("2026-02-22T00:00:00.000Z");
    expect(iso(w.previousEndExclusive)).toBe(iso(w.start));
    expect(w.endExclusive.getTime() - w.start.getTime()).toBe(w.start.getTime() - w.previousStart.getTime());
  });

  it("accepts a single day", () => {
    const w = resolveWindow({ from: "2026-03-01", to: "2026-03-01" }, NOW);
    expect(w.days).toBe(1);
    expect(describeWindow(w)).toMatchObject({ previousFrom: "2026-02-28", previousTo: "2026-02-28" });
    expect(bucketKeys(w)).toEqual(["2026-03-01"]);
  });

  it("does not drift across a daylight-saving change (the window is UTC)", () => {
    // 29 March 2026 is a 23-hour day in much of Europe; in UTC it is an ordinary day.
    const w = resolveWindow({ from: "2026-03-28", to: "2026-03-30" }, NOW);
    expect(w.days).toBe(3);
    expect(bucketKeys(w)).toEqual(["2026-03-28", "2026-03-29", "2026-03-30"]);
  });

  it("refuses a reversed window and one longer than the maximum", () => {
    const reversed = refusal(() => resolveWindow({ from: "2026-03-02", to: "2026-03-01" }, NOW));
    expect(reversed.status).toBe(400);
    expect(reversed.code).toBe("INVALID_ANALYTICS_WINDOW");
    expect(resolveWindow({ from: "2024-11-20", to: "2026-11-19" }, NOW).days).toBe(730);
    expect(resolveWindow({ from: "2024-11-19", to: "2026-11-19" }, NOW).days).toBe(MAX_WINDOW_DAYS);
    expect(refusal(() => resolveWindow({ from: "2024-11-18", to: "2026-11-19" }, NOW)).status).toBe(400);
  });

  it("chooses the bucket size from the window length unless one is requested", () => {
    expect(defaultGranularity(1)).toBe("day");
    expect(defaultGranularity(62)).toBe("day");
    expect(defaultGranularity(63)).toBe("week");
    expect(defaultGranularity(366)).toBe("week");
    expect(defaultGranularity(367)).toBe("month");
    expect(resolveWindow({ from: "2026-01-01", to: "2026-01-31", granularity: "month" }, NOW).granularity).toBe("month");
    expect(resolveWindow({ from: "2026-01-01", to: "2026-01-31", granularity: "" }, NOW).granularity).toBe("day");
  });

  it("refuses an unknown bucket size and daily buckets beyond 366 days", () => {
    expect(refusal(() => resolveWindow({ granularity: "hour" }, NOW)).status).toBe(400);
    expect(refusal(() => resolveWindow({ granularity: ["day"] }, NOW)).status).toBe(400);
    expect(resolveWindow({ from: "2025-11-19", to: "2026-11-19", granularity: "day" }, NOW).days).toBe(366);
    expect(refusal(() => resolveWindow({ from: "2025-11-18", to: "2026-11-19", granularity: "day" }, NOW)).status).toBe(400);
  });
});

describe("buckets mirror date_trunc", () => {
  it("day, ISO week (Monday) and calendar month starts", () => {
    const d = (s: string) => new Date(`${s}Z`);
    expect(dayKey(bucketStart(d("2026-11-19T15:30:00"), "day"))).toBe("2026-11-19");
    expect(dayKey(bucketStart(d("2026-11-19T15:30:00"), "week"))).toBe("2026-11-16"); // Thursday → Monday
    expect(dayKey(bucketStart(d("2026-11-16T00:00:00"), "week"))).toBe("2026-11-16"); // Monday stays
    expect(dayKey(bucketStart(d("2026-11-22T23:59:59"), "week"))).toBe("2026-11-16"); // Sunday → previous Monday
    expect(dayKey(bucketStart(d("2027-01-01T12:00:00"), "week"))).toBe("2026-12-28"); // a week that spans the year end
    expect(dayKey(bucketStart(d("2026-11-19T15:30:00"), "month"))).toBe("2026-11-01");
    expect(dayKey(utcDay(d("2026-11-19T23:59:59.999")))).toBe("2026-11-19");
  });

  it("lists every bucket that intersects the window, in order", () => {
    const daily = bucketKeys(resolveWindow({ from: "2026-02-26", to: "2026-03-02" }, NOW));
    expect(daily).toEqual(["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    // A window that starts mid-week begins with the bucket of the Monday before it.
    const weekly = bucketKeys(resolveWindow({ from: "2026-11-04", to: "2026-11-19", granularity: "week" }, NOW));
    expect(weekly).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    const monthly = bucketKeys(resolveWindow({ from: "2025-11-20", to: "2026-02-10", granularity: "month" }, NOW));
    expect(monthly).toEqual(["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"]);
  });

  it("covers a leap year with 366 daily buckets", () => {
    const w = resolveWindow({ from: "2024-01-01", to: "2024-12-31", granularity: "day" }, NOW);
    const keys = bucketKeys(w);
    expect(keys).toHaveLength(366);
    expect(keys).toContain("2024-02-29");
    expect(new Set(keys).size).toBe(366);
  });

  it("zero-fills grouped rows onto the bucket list and ignores rows outside it", () => {
    const w = resolveWindow({ from: "2026-03-01", to: "2026-03-04" }, NOW);
    const filled = fillBuckets(w, [{ bucket: "2026-03-03", a: 5, b: 1 }, { bucket: "2026-03-01", a: 2, b: 0 }, { bucket: "2026-02-28", a: 99, b: 99 }], { a: 0, b: 0 });
    expect(filled).toEqual([
      { bucket: "2026-03-01", a: 2, b: 0 },
      { bucket: "2026-03-02", a: 0, b: 0 },
      { bucket: "2026-03-03", a: 5, b: 1 },
      { bucket: "2026-03-04", a: 0, b: 0 },
    ]);
  });
});
