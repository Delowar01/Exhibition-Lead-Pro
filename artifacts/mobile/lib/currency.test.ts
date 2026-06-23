import { describe, it, expect } from "vitest";
import {
  convertCurrency,
  formatCurrency,
  formatCurrencyFull,
  FX_RATES_TO_USD,
} from "./currency";

/**
 * Mirrors the exact reduce the dashboard / leads screen use to aggregate a
 * pipeline: convert each lead to the display currency, THEN sum. This is the
 * regression guard for the reported "USD 85,000 should be ~SAR 318,750 but
 * showed SAR 260.4K" bug, whose root cause was summing raw mixed-currency
 * values server-side and re-labelling the total with the display currency.
 */
function pipelineTotal(
  leads: { value: number; currency: string }[],
  displayCurrency: string,
): number {
  return leads.reduce(
    (sum, l) => sum + convertCurrency(Number(l.value ?? 0), l.currency ?? "USD", displayCurrency),
    0,
  );
}

describe("convertCurrency", () => {
  it("uses the fixed SAR peg of 3.75", () => {
    expect(FX_RATES_TO_USD.SAR).toBe(3.75);
  });

  it("returns the value unchanged when currencies match", () => {
    expect(convertCurrency(35000, "USD", "USD")).toBe(35000);
    expect(convertCurrency(35000, "SAR", "SAR")).toBe(35000);
  });

  it("converts USD → SAR at the peg", () => {
    expect(convertCurrency(35000, "USD", "SAR")).toBe(131250);
    expect(convertCurrency(25000, "USD", "SAR")).toBe(93750);
    expect(convertCurrency(15000, "USD", "SAR")).toBe(56250);
    expect(convertCurrency(10000, "USD", "SAR")).toBe(37500);
    expect(convertCurrency(85000, "USD", "SAR")).toBe(318750);
  });

  it("is case-insensitive and falls back to USD (1:1) for unknown codes", () => {
    expect(convertCurrency(1000, "usd", "sar")).toBe(3750);
    expect(convertCurrency(1000, "???", "SAR")).toBe(3750);
  });

  it("round-trips through the USD base without drift", () => {
    expect(convertCurrency(convertCurrency(40000, "AED", "USD"), "USD", "AED")).toBeCloseTo(40000, 6);
  });
});

describe("pipeline aggregation (reported bug scenario)", () => {
  it("USD 35k+25k+15k+10k displayed in SAR equals 318,750 (NOT 260.4K)", () => {
    const leads = [
      { value: 35000, currency: "USD" },
      { value: 25000, currency: "USD" },
      { value: 15000, currency: "USD" },
      { value: 10000, currency: "USD" },
    ];
    const total = pipelineTotal(leads, "SAR");
    expect(total).toBe(318750);
    expect(formatCurrencyFull(total, "SAR")).toBe("SAR 318,750");
    expect(formatCurrency(total, "SAR")).toBe("SAR 318.8k");
  });

  it("never collapses to the raw-sum-relabelled bug value", () => {
    const leads = [
      { value: 35000, currency: "USD" },
      { value: 25000, currency: "USD" },
      { value: 15000, currency: "USD" },
      { value: 10000, currency: "USD" },
    ];
    // The bug summed raw (85,000) and/or mixed currencies, yielding ~260,400.
    const total = pipelineTotal(leads, "SAR");
    expect(total).not.toBe(85000);
    expect(Math.round(total)).not.toBe(260400);
  });

  it("converts each lead by ITS OWN currency before summing (mixed pipeline)", () => {
    const leads = [
      { value: 35000, currency: "USD" }, // → 131,250 SAR
      { value: 50000, currency: "AED" }, // → 50000/3.6725*3.75 ≈ 51,055.82 SAR
      { value: 20000, currency: "SAR" }, // → 20,000 SAR (unchanged)
    ];
    const expected = 131250 + (50000 / 3.6725) * 3.75 + 20000;
    expect(pipelineTotal(leads, "SAR")).toBeCloseTo(expected, 4);
  });
});

describe("formatting", () => {
  it("compact format for dashboard cards", () => {
    expect(formatCurrency(25000, "SAR")).toBe("SAR 25k");
    expect(formatCurrency(318750, "SAR")).toBe("SAR 318.8k");
    expect(formatCurrency(1250000, "AED")).toBe("AED 1.3M");
    expect(formatCurrency(500, "QAR")).toBe("QAR 500");
  });

  it("full format with thousands separators for detail views", () => {
    expect(formatCurrencyFull(318750, "SAR")).toBe("SAR 318,750");
    expect(formatCurrencyFull(1250000, "AED")).toBe("AED 1,250,000");
  });
});
