import { describe, it, expect } from "vitest";
import {
  MAX_MANUAL_PRICES,
  compareVersions,
  defaultTrialPolicy,
  effectiveFeatureMatrix,
  manualPricesOf,
  manualPricesText,
  noAllowances,
  parseManualPricesInput,
  priceKey,
  unlimitedLimits,
  validateVersionForPublish,
  type PlanVersionSnapshot,
  type PriceLike,
} from "../src/lib/billing/plan-versions.js";
import { digestOf } from "../src/services/plan-change.service.js";

// Batch 42 (PB-4) — PURE pricing rules (no database, no HTTP): the canonical
// period key, the draft's manual price summaries (D2), the publication price
// validation over the applicable provider mappings (verified, mode-matched,
// consistent, one active offer per period, manual summaries well formed and
// reported when shadowed), the comparison row and the dry-run digest.

function snap(over: Partial<PlanVersionSnapshot> = {}): PlanVersionSnapshot {
  return { name: "Pro", description: null, sortOrder: 10, limits: unlimitedLimits(), features: effectiveFeatureMatrix(null), prices: [], featureEnforcement: "legacy", allowances: noAllowances(), manualPrices: [], ...over };
}
const trial = defaultTrialPolicy(14);
function price(id: number, over: Partial<PriceLike> = {}): PriceLike {
  return { id, interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, providerMode: "test", nickname: null, active: true, verifiedAt: new Date(), planVersionId: null, ...over };
}
const ctx = (prices: PriceLike[]) => ({ configuredProviderMode: "test" as const, prices });
const codes = (v: { errors: Array<{ code: string }>; warnings: Array<{ code: string }> }) => ({ errors: v.errors.map((e) => e.code), warnings: v.warnings.map((w) => w.code) });

describe("period key", () => {
  it("is currency/interval×count, lowercase and stable", () => {
    expect(priceKey({ currency: "eur", interval: "month", intervalCount: 1 })).toBe("eur/monthx1");
    expect(priceKey({ currency: "usd", interval: "year", intervalCount: 1 })).toBe("usd/yearx1");
    expect(priceKey({ currency: "usd", interval: "month", intervalCount: 12 })).toBe("usd/monthx12");
  });
});

describe("manual price summaries (draft input)", () => {
  const base = [{ interval: "month" as const, intervalCount: 1, currency: "usd", unitAmountMinor: 100, label: null }];
  it("undefined keeps the base; a non-array is rejected", () => {
    expect(parseManualPricesInput(undefined, base)).toEqual({ value: base, issues: [] });
    const r = parseManualPricesInput("x", base);
    expect(r.value).toBe(base);
    expect(r.issues.map((i) => i.code)).toEqual(["MANUAL_PRICES_INVALID"]);
  });
  it("normalizes valid entries (currency lowercased, count defaults to 1, label trimmed / collapsed, blank label = null)", () => {
    const r = parseManualPricesInput([{ interval: "month", currency: " EUR ", unitAmountMinor: 1900, label: "  Monthly   plan " }, { interval: "year", intervalCount: 1, currency: "eur", unitAmountMinor: 19900, label: "   " }], base);
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual([
      { interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, label: "Monthly plan" },
      { interval: "year", intervalCount: 1, currency: "eur", unitAmountMinor: 19900, label: null },
    ]);
  });
  it("rejects every malformed entry with its index and keeps the base untouched", () => {
    // Exactly MAX_MANUAL_PRICES malformed objects (the list is capped at the maximum before per-entry validation).
    const bad = [
      { interval: "quarter", currency: "eur", unitAmountMinor: 1 },
      { interval: "month", currency: "euro", unitAmountMinor: 1 },
      { interval: "month", currency: "eur", unitAmountMinor: -1 },
      { interval: "month", currency: "eur", unitAmountMinor: 1.5 },
      { interval: "month", intervalCount: 13, currency: "eur", unitAmountMinor: 1 },
      { interval: "month", intervalCount: 0, currency: "eur", unitAmountMinor: 1 },
      { interval: "month", currency: "eur", unitAmountMinor: 1, label: "x".repeat(61) },
      { interval: "month", currency: "eur", unitAmountMinor: 1, label: 5 },
    ];
    expect(bad).toHaveLength(MAX_MANUAL_PRICES);
    const r = parseManualPricesInput(bad, base);
    expect(r.value).toBe(base);
    expect(r.issues).toHaveLength(bad.length);
    r.issues.forEach((i, idx) => {
      expect(i.code).toBe("MANUAL_PRICE_INVALID");
      expect(i.field).toBe(`manualPrices.${idx}`);
    });
    const nonObjects = parseManualPricesInput([null, "month", 7], base);
    expect(nonObjects.value).toBe(base);
    expect(nonObjects.issues.map((i) => [i.code, i.field])).toEqual([["MANUAL_PRICE_INVALID", "manualPrices.0"], ["MANUAL_PRICE_INVALID", "manualPrices.1"], ["MANUAL_PRICE_INVALID", "manualPrices.2"]]);
  });
  it("rejects a repeated period (same currency, interval and count) and more than the maximum", () => {
    const dup = parseManualPricesInput([{ interval: "month", currency: "eur", unitAmountMinor: 1 }, { interval: "month", intervalCount: 1, currency: "EUR", unitAmountMinor: 2 }], base);
    expect(dup.issues).toEqual([expect.objectContaining({ code: "MANUAL_PRICE_DUPLICATE", field: "manualPrices.1" })]);
    expect(dup.value).toBe(base);
    const many = Array.from({ length: MAX_MANUAL_PRICES + 1 }, (_, i) => ({ interval: "month", intervalCount: i + 1, currency: "eur", unitAmountMinor: 1 }));
    const r = parseManualPricesInput(many, base);
    expect(r.issues.map((i) => i.code)).toContain("MANUAL_PRICES_TOO_MANY");
    expect(r.value).toBe(base);
    // Different count or currency = a different period.
    const ok = parseManualPricesInput([{ interval: "month", currency: "eur", unitAmountMinor: 1 }, { interval: "month", intervalCount: 12, currency: "eur", unitAmountMinor: 2 }, { interval: "month", currency: "usd", unitAmountMinor: 3 }], base);
    expect(ok.issues).toEqual([]);
    expect(ok.value).toHaveLength(3);
  });
  it("a stored snapshot yields only its valid entries; the text form is canonical and sorted", () => {
    const stored = snap({ manualPrices: [{ interval: "year", intervalCount: 1, currency: "eur", unitAmountMinor: 19900, label: "Annual" }, { interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, label: null }, { interval: "bogus", intervalCount: 1, currency: "eur", unitAmountMinor: 1, label: null } as never] });
    expect(manualPricesOf(stored)).toHaveLength(2);
    expect(manualPricesText(stored)).toBe("eur/monthx1=1900; eur/yearx1=19900 (Annual)");
    expect(manualPricesText(snap())).toBe("—");
    expect(manualPricesText(null)).toBe("—");
    expect(manualPricesOf({ manualPrices: "nope" as never })).toEqual([]);
  });
});

describe("publication price validation", () => {
  it("a version without any provider price is valid (manual billing) and says so", () => {
    const v = validateVersionForPublish(snap(), trial, ctx([]));
    expect(v.ok).toBe(true);
    expect(codes(v).warnings).toContain("NO_PROVIDER_PRICE");
  });
  it("an active price must be provider-verified in the configured mode; inactive prices are ignored", () => {
    const v = validateVersionForPublish(snap(), trial, ctx([price(1, { verifiedAt: null }), price(2, { providerMode: "live", currency: "usd" }), price(3, { active: false, verifiedAt: null, providerMode: "live" })]));
    expect(v.ok).toBe(false);
    expect(codes(v).errors).toEqual(expect.arrayContaining(["PRICE_UNVERIFIED", "PRICE_MODE_MISMATCH"]));
    expect(v.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["prices.1", "prices.2"]));
    expect(v.errors.some((e) => e.field === "prices.3")).toBe(false);
  });
  it("two active prices on the same period are inconsistent (PRICE_DUPLICATE_PERIOD names both); other periods and inactive duplicates are fine", () => {
    const dup = validateVersionForPublish(snap(), trial, ctx([price(10), price(11, { unitAmountMinor: 2900, planVersionId: 7 })]));
    expect(dup.ok).toBe(false);
    const e = dup.errors.find((x) => x.code === "PRICE_DUPLICATE_PERIOD");
    expect(e?.field).toBe("prices.11");
    expect(e?.message).toContain("10");
    expect(e?.message).toContain("eur/monthx1");
    const ok = validateVersionForPublish(snap(), trial, ctx([price(10), price(12, { interval: "year" }), price(13, { currency: "usd" }), price(14, { intervalCount: 12 }), price(15, { active: false })]));
    expect(ok.ok).toBe(true);
    expect(codes(ok).warnings).not.toContain("NO_PROVIDER_PRICE");
  });
  it("a price outside the supported interval / currency / amount range is PRICE_INCONSISTENT and never counted as an offer", () => {
    const v = validateVersionForPublish(snap(), trial, ctx([price(20, { interval: "quarter" }), price(21, { currency: "EUR" }), price(22, { unitAmountMinor: -5 }), price(23, { intervalCount: 13 })]));
    expect(v.ok).toBe(false);
    expect(v.errors.filter((e) => e.code === "PRICE_INCONSISTENT").map((e) => e.field)).toEqual(["prices.20", "prices.21", "prices.22", "prices.23"]);
    expect(codes(v).errors).not.toContain("PRICE_DUPLICATE_PERIOD");
  });
  it("manual summaries must be well formed and unique; one on a period with an active provider price is reported, not refused", () => {
    const v = validateVersionForPublish(
      snap({ manualPrices: [{ interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, label: null }, { interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 2000, label: null }, { interval: "day", intervalCount: 99, currency: "eur", unitAmountMinor: 1, label: null }] }),
      trial,
      ctx([price(30)]),
    );
    expect(codes(v).errors).toEqual(expect.arrayContaining(["MANUAL_PRICE_DUPLICATE", "MANUAL_PRICE_INVALID"]));
    expect(v.errors.find((e) => e.code === "MANUAL_PRICE_DUPLICATE")?.field).toBe("manualPrices.1");
    expect(v.errors.find((e) => e.code === "MANUAL_PRICE_INVALID")?.field).toBe("manualPrices.2");
    expect(v.warnings.find((w) => w.code === "MANUAL_PRICE_SHADOWED")?.field).toBe("manualPrices.0");
    const clean = validateVersionForPublish(snap({ manualPrices: [{ interval: "year", intervalCount: 1, currency: "eur", unitAmountMinor: 19900, label: "Annual" }] }), trial, ctx([price(31)]));
    expect(clean.ok).toBe(true);
    expect(codes(clean).warnings).not.toContain("MANUAL_PRICE_SHADOWED");
    expect(codes(validateVersionForPublish(snap({ manualPrices: "x" as never }), trial, ctx([]))).errors).toContain("MANUAL_PRICES_INVALID");
    const many = Array.from({ length: MAX_MANUAL_PRICES + 1 }, (_, i) => ({ interval: "month" as const, intervalCount: i + 1, currency: "eur", unitAmountMinor: 1, label: null }));
    expect(codes(validateVersionForPublish(snap({ manualPrices: many }), trial, ctx([]))).errors).toContain("MANUAL_PRICES_TOO_MANY");
  });
});

describe("comparison and digest", () => {
  it("the comparison carries one pricing row with the canonical manual price text", () => {
    const a = { snapshot: snap({ manualPrices: [{ interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, label: null }] }), trialPolicy: trial };
    const b = { snapshot: snap({ manualPrices: [{ interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 2900, label: "New" }] }), trialPolicy: trial };
    const rows = compareVersions(a, b).filter((r) => r.group === "pricing");
    expect(rows).toEqual([{ group: "pricing", field: "manualPrices", left: "eur/monthx1=1900", right: "eur/monthx1=2900 (New)", changed: true }]);
    expect(compareVersions(a, a).find((r) => r.group === "pricing")?.changed).toBe(false);
  });
  it("the digest is a sha-256 hex independent of key order but sensitive to values and array order", () => {
    const d1 = digestOf({ rows: [{ companyId: 1, reason: "ELIGIBLE" }, { companyId: 2, reason: "ELIGIBLE" }], targetVersionId: 5 });
    const d2 = digestOf({ targetVersionId: 5, rows: [{ reason: "ELIGIBLE", companyId: 1 }, { reason: "ELIGIBLE", companyId: 2 }] });
    expect(d1).toMatch(/^[a-f0-9]{64}$/);
    expect(d2).toBe(d1);
    expect(digestOf({ targetVersionId: 5, rows: [{ companyId: 2, reason: "ELIGIBLE" }, { companyId: 1, reason: "ELIGIBLE" }] })).not.toBe(d1);
    expect(digestOf({ targetVersionId: 6, rows: [{ companyId: 1, reason: "ELIGIBLE" }, { companyId: 2, reason: "ELIGIBLE" }] })).not.toBe(d1);
    expect(digestOf({ targetVersionId: 5, rows: [{ companyId: 1, reason: "DOWNGRADE_BLOCKED" }, { companyId: 2, reason: "ELIGIBLE" }] })).not.toBe(d1);
    expect(digestOf(null)).toBe(digestOf(undefined));
  });
});
