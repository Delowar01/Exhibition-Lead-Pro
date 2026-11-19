import { describe, it, expect } from "vitest";
import {
  ANALYTICS_TABS,
  MAX_RANGE_DAYS,
  RANGE_PRESETS,
  addDays,
  bucketLabel,
  bucketTick,
  buildAnalyticsSearch,
  daysBetween,
  defaultGranularity,
  deltaOf,
  effectiveGranularity,
  formatCompact,
  formatCount,
  formatDay,
  formatMinor,
  formatPercent,
  formatUsd,
  humanize,
  minorUnitDigits,
  parseAnalyticsSearch,
  parseDay,
  plural,
  presetRange,
  previousRange,
  rangeLabel,
  revenueEstimateView,
  subscriptionStatusItems,
  todayUtc,
  validateRange,
  CAPTURE_SOURCE_LABEL,
  type AnalyticsState,
} from "./platform-analytics";

// G-7 — pure helpers of the Platform Owner Analytics page: the reporting window and its URL
// state, the previous-period comparison, and every number/label format. No DOM, no network.

const TODAY = "2026-11-19";

describe("UTC day arithmetic", () => {
  it("takes today from the UTC calendar, not the local one", () => {
    expect(todayUtc(new Date("2026-11-19T23:59:59.999Z"))).toBe("2026-11-19");
    expect(todayUtc(new Date("2026-11-20T00:00:00.000Z"))).toBe("2026-11-20");
    expect(todayUtc(new Date("2026-11-19T22:30:00-03:00"))).toBe("2026-11-20");
  });

  it("parses only real YYYY-MM-DD days", () => {
    expect(parseDay("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    for (const bad of ["2025-02-29", "2026-02-30", "2026-13-01", "2026-1-5", "20260105", "2026-01-05T00:00:00Z", "", null, undefined]) {
      expect(parseDay(bad as string), String(bad)).toBeNull();
    }
  });

  it("adds days across months, years and leap days", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-11-19", 0)).toBe("2026-11-19");
    expect(addDays("not-a-day", 5)).toBe("not-a-day");
  });

  it("counts both end days of a window", () => {
    expect(daysBetween("2026-11-19", "2026-11-19")).toBe(1);
    expect(daysBetween("2026-10-21", "2026-11-19")).toBe(30);
    expect(daysBetween("2024-01-01", "2024-12-31")).toBe(366);
    expect(daysBetween("nope", "2026-11-19")).toBe(0);
  });

  it("each preset ends today and spans its number of days", () => {
    for (const p of RANGE_PRESETS) {
      const r = presetRange(p.id, TODAY);
      expect(r.to).toBe(TODAY);
      expect(daysBetween(r.from, r.to), p.id).toBe(p.days);
    }
    expect(presetRange("30d", TODAY)).toEqual({ from: "2026-10-21", to: "2026-11-19" });
    expect(presetRange("7d", TODAY)).toEqual({ from: "2026-11-13", to: "2026-11-19" });
  });

  it("the previous window is equally long and ends the day before", () => {
    expect(previousRange("2026-10-21", "2026-11-19")).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(previousRange("2026-03-01", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    const prev = previousRange("2026-03-01", "2026-03-07");
    expect(daysBetween(prev.from, prev.to)).toBe(7);
    expect(addDays(prev.to, 1)).toBe("2026-03-01");
  });
});

describe("custom range validation", () => {
  it("accepts a valid window, including a single day and the longest allowed", () => {
    expect(validateRange("2026-11-01", "2026-11-19", TODAY)).toBeNull();
    expect(validateRange(TODAY, TODAY, TODAY)).toBeNull();
    expect(validateRange(addDays(TODAY, -(MAX_RANGE_DAYS - 1)), TODAY, TODAY)).toBeNull();
  });

  it("explains each refusal", () => {
    expect(validateRange("", "2026-11-19", TODAY)).toBe("Enter both dates.");
    expect(validateRange("2026-02-30", "2026-11-19", TODAY)).toBe("Enter both dates.");
    expect(validateRange("2026-11-19", "2026-11-01", TODAY)).toBe("The start date must not be after the end date.");
    expect(validateRange("2026-11-01", "2026-11-20", TODAY)).toBe("The end date cannot be in the future.");
    expect(validateRange(addDays(TODAY, -MAX_RANGE_DAYS), TODAY, TODAY)).toBe(`A window can span at most ${MAX_RANGE_DAYS} days.`);
  });
});

describe("granularity", () => {
  it("mirrors the API's default bucket size", () => {
    expect(defaultGranularity(1)).toBe("day");
    expect(defaultGranularity(62)).toBe("day");
    expect(defaultGranularity(63)).toBe("week");
    expect(defaultGranularity(366)).toBe("week");
    expect(defaultGranularity(367)).toBe("month");
  });

  it("sends nothing for automatic, and never a daily request the API would refuse", () => {
    expect(effectiveGranularity("auto", 30)).toBeUndefined();
    expect(effectiveGranularity("week", 30)).toBe("week");
    expect(effectiveGranularity("day", 366)).toBe("day");
    expect(effectiveGranularity("day", 367)).toBeUndefined();
    expect(effectiveGranularity("month", 731)).toBe("month");
  });
});

describe("URL state", () => {
  const base: AnalyticsState = { tab: "overview", preset: "30d", from: "2026-10-21", to: "2026-11-19", granularity: "auto" };

  it("the plain URL is the default view", () => {
    expect(parseAnalyticsSearch("", TODAY)).toEqual(base);
    expect(buildAnalyticsSearch(base)).toBe("");
  });

  it("round-trips every tab, preset, custom range and bucket size", () => {
    const states: AnalyticsState[] = [
      ...ANALYTICS_TABS.map((t) => ({ ...base, tab: t.id })),
      ...RANGE_PRESETS.map((p) => ({ ...base, preset: p.id, ...presetRange(p.id, TODAY) })),
      { ...base, tab: "revenue", preset: "custom", from: "2026-01-01", to: "2026-03-31", granularity: "month" },
      { ...base, granularity: "week" },
      { ...base, tab: "ai", preset: "12m", ...presetRange("12m", TODAY), granularity: "day" },
    ];
    for (const s of states) expect(parseAnalyticsSearch(buildAnalyticsSearch(s), TODAY), JSON.stringify(s)).toEqual(s);
  });

  it("writes only what differs from the default", () => {
    expect(buildAnalyticsSearch({ ...base, tab: "growth" })).toBe("?tab=growth");
    expect(buildAnalyticsSearch({ ...base, preset: "90d", ...presetRange("90d", TODAY) })).toBe("?range=90d");
    expect(buildAnalyticsSearch({ ...base, preset: "custom", from: "2026-01-01", to: "2026-01-31" })).toBe("?from=2026-01-01&to=2026-01-31");
    expect(buildAnalyticsSearch({ ...base, tab: "ai", granularity: "week" })).toBe("?tab=ai&granularity=week");
  });

  it("falls back to the default for anything invalid — a bad link never breaks the page", () => {
    expect(parseAnalyticsSearch("?tab=secrets&range=5y&granularity=hour", TODAY)).toEqual(base);
    // an impossible, reversed, future or over-long custom range is ignored
    for (const q of ["?from=2026-02-30&to=2026-03-01", "?from=2026-11-19&to=2026-11-01", "?from=2026-11-01&to=2027-01-01", "?from=2020-01-01&to=2026-11-19", "?from=2026-11-01"]) {
      const s = parseAnalyticsSearch(q, TODAY);
      expect(s.preset, q).toBe("30d");
      expect([s.from, s.to], q).toEqual([base.from, base.to]);
    }
    // the valid parts of a partly valid link are kept
    expect(parseAnalyticsSearch("?tab=operations&range=nope&granularity=month", TODAY)).toEqual({ ...base, tab: "operations", granularity: "month" });
    expect(parseAnalyticsSearch("tab=activity", TODAY).tab).toBe("activity");
  });

  it("an explicit custom range wins over a preset", () => {
    const s = parseAnalyticsSearch("?range=7d&from=2026-01-01&to=2026-01-31", TODAY);
    expect(s).toMatchObject({ preset: "custom", from: "2026-01-01", to: "2026-01-31" });
  });
});

describe("comparison with the previous period", () => {
  it("reports a percentage only when there is a previous value", () => {
    expect(deltaOf(150, 100)).toEqual({ pct: 50, kind: "up" });
    expect(deltaOf(75, 100)).toEqual({ pct: -25, kind: "down" });
    expect(deltaOf(100, 100)).toEqual({ pct: 0, kind: "flat" });
    expect(deltaOf(0, 100)).toEqual({ pct: -100, kind: "down" });
    expect(deltaOf(2788, 994)).toEqual({ pct: 180.5, kind: "up" });
    expect(deltaOf(0.0065, 0.0007).kind).toBe("up");
  });

  it("never invents a percentage from zero", () => {
    expect(deltaOf(12, 0)).toEqual({ pct: null, kind: "new" });
    expect(deltaOf(0, 0)).toEqual({ pct: null, kind: "none" });
  });

  it("a change too small to show reads as flat, not as +0%/-0%", () => {
    expect(deltaOf(100_001, 100_000)).toEqual({ pct: 0, kind: "flat" });
    expect(Object.is(deltaOf(99_999, 100_000).pct, -0)).toBe(false);
  });

});

describe("formats", () => {
  it("counts and compact ticks", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(1200)).toBe("1.2K");
    expect(formatCompact(1000)).toBe("1K");
    expect(formatCompact(15400)).toBe("15K");
    expect(formatCompact(4_400_000)).toBe("4.4M");
    expect(formatCompact(0.15)).toBe("0.15");
  });

  it("USD keeps the precision small AI costs need", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(3.38)).toBe("$3.38");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.734)).toBe("$0.734");
    expect(formatUsd(0.0065)).toBe("$0.0065");
    expect(formatUsd(0.5)).toBe("$0.50");
  });

  it("minor units in the provider's currency", () => {
    expect(formatMinor(176600, "usd")).toBe("$1,766.00");
    expect(formatMinor(5000, "USD")).toBe("$50.00");
    expect(formatMinor(1999, "eur")).toContain("19.99");
    expect(formatMinor(100, "not-a-currency")).toBe("1.00 NOT-A-CURRENCY");
  });

  it("does not assume every currency has cents", () => {
    expect(minorUnitDigits("usd")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("kwd")).toBe(3);
    expect(minorUnitDigits("not-a-currency")).toBe(2);
    // 5,000 yen is ¥5,000 — not ¥50; 10,000 fils are 10 dinars — not 100.
    expect(formatMinor(5000, "jpy")).toBe("¥5,000");
    expect(formatMinor(10000, "kwd")).toContain("10.000");
    expect(formatMinor(10000, "kwd")).not.toContain("100.0");
    // the annual run rate of a yen estimate is formatted the same way
    expect(revenueEstimateView({ available: true, reason: null, currency: "jpy", monthlyRecurringMinor: 5000, countedSubscriptions: 1, unpricedSubscriptions: 0 })).toMatchObject({ mrr: "¥5,000", arr: "¥60,000" });
  });

  it("percentages", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.25)).toBe("25%");
    expect(formatPercent(0.061)).toBe("6.1%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("bucket labels follow the bucket size", () => {
    expect(bucketTick("2026-11-09", "day")).toBe("Nov 9");
    expect(bucketTick("2026-11-09", "week")).toBe("Nov 9");
    expect(bucketTick("2026-11-01", "month")).toBe("Nov 26");
    expect(bucketLabel("2026-11-09", "day")).toBe("Nov 9, 2026");
    expect(bucketLabel("2026-11-09", "week")).toBe("Week of Nov 9, 2026");
    expect(bucketLabel("2026-11-01", "month")).toBe("Nov 2026");
    expect(bucketLabel("garbage", "day")).toBe("garbage");
    expect(formatDay("2026-01-05")).toBe("Jan 5, 2026");
    expect(rangeLabel({ from: "2026-10-21", to: "2026-11-19" })).toBe("Oct 21, 2026 – Nov 19, 2026");
  });

  it("turns identifiers into readable labels", () => {
    expect(humanize("ai_vision")).toBe("AI vision");
    expect(humanize("linkedin_qr")).toBe("LinkedIn QR");
    expect(humanize("invoice.payment_failed")).toBe("Invoice payment failed");
    expect(humanize("mfa_challenge")).toBe("MFA challenge");
    expect(humanize("nfc")).toBe("NFC");
    expect(humanize("email_signature")).toBe("Email signature");
    expect(humanize("")).toBe("");
  });

  it("pluralises", () => {
    expect(plural(1, "day")).toBe("1 day");
    expect(plural(30, "day")).toBe("30 days");
    expect(plural(0, "company", "companies")).toBe("0 companies");
    expect(plural(1234, "user")).toBe("1,234 users");
  });
});

describe("chart data helpers", () => {
  it("orders subscription statuses consistently and keeps unknown ones", () => {
    const items = subscriptionStatusItems([
      { status: "trialing", count: 7 },
      { status: "paused", count: 1 },
      { status: "suspended", count: 2 },
      { status: "active", count: 25 },
    ]);
    expect(items.map((i) => [i.key, i.label, i.value])).toEqual([
      ["active", "Active", 25],
      ["trialing", "Trialing", 7],
      ["suspended", "Suspended", 2],
      ["paused", "Paused", 1],
    ]);
    expect(items.every((i) => i.color.startsWith("hsl(var(--"))).toBe(true);
    expect(subscriptionStatusItems([])).toEqual([]);
  });

  it("names every capture source the API can report", () => {
    for (const source of ["camera", "qr", "vcard", "digital_card", "email_signature", "nfc", "manual", "import", "unknown"]) {
      expect(CAPTURE_SOURCE_LABEL[source], source).toBeTruthy();
    }
    // "manual" is a contact typed in by hand; it is never presented as a kind of scan.
    expect(CAPTURE_SOURCE_LABEL.manual).toBe("Typed in");
    expect(Object.values(CAPTURE_SOURCE_LABEL).some((l) => /scan/i.test(l))).toBe(false);
  });
});

describe("revenue estimate — nothing is shown as revenue unless the API computed it", () => {
  const unavailable = { available: false, reason: "NO_VERIFIED_PRICES", currency: null, monthlyRecurringMinor: null, countedSubscriptions: 0, unpricedSubscriptions: 0 };

  it("an unavailable estimate has no amounts and says why", () => {
    const v = revenueEstimateView(unavailable);
    expect(v).toEqual({ available: false, mrr: null, arr: null, reason: "No verified provider prices are registered." });
    expect(revenueEstimateView({ ...unavailable, reason: "MIXED_CURRENCIES" }).reason).toBe("Subscriptions are billed in more than one currency.");
    expect(revenueEstimateView({ ...unavailable, reason: "SOMETHING_NEW" }).reason).toBe("The estimate cannot be computed.");
    expect(revenueEstimateView({ ...unavailable, reason: null }).reason).toBe("The estimate cannot be computed.");
  });

  it("never formats an amount when the API marks the estimate unavailable, even if numbers are present", () => {
    const v = revenueEstimateView({ available: false, reason: "UNPRICED_SUBSCRIPTIONS", currency: "usd", monthlyRecurringMinor: 99900, countedSubscriptions: 3, unpricedSubscriptions: 2 });
    expect(v.available).toBe(false);
    expect(v.mrr).toBeNull();
    expect(v.arr).toBeNull();
  });

  it("an available estimate formats the monthly figure and its ×12 run rate", () => {
    const v = revenueEstimateView({ available: true, reason: null, currency: "usd", monthlyRecurringMinor: 176600, countedSubscriptions: 14, unpricedSubscriptions: 0 });
    expect(v).toEqual({ available: true, mrr: "$1,766.00", arr: "$21,192.00", reason: null });
  });

  it("a partial estimate keeps its caveat", () => {
    const v = revenueEstimateView({ available: true, reason: "PARTIAL_UNPRICED", currency: "usd", monthlyRecurringMinor: 5000, countedSubscriptions: 1, unpricedSubscriptions: 1 });
    expect(v.available).toBe(true);
    expect(v.reason).toBe("Some provider subscriptions have no verified price and are not included.");
  });

  it("an 'available' flag without an amount or a currency is still unavailable", () => {
    expect(revenueEstimateView({ available: true, reason: null, currency: null, monthlyRecurringMinor: 5000, countedSubscriptions: 1, unpricedSubscriptions: 0 }).available).toBe(false);
    expect(revenueEstimateView({ available: true, reason: null, currency: "usd", monthlyRecurringMinor: null, countedSubscriptions: 1, unpricedSubscriptions: 0 }).available).toBe(false);
  });
});
