import { describe, expect, it } from "vitest";
import { EMPTY_MANUAL_PRICE, MAX_MANUAL_PRICE_MINOR, rowFromStoredPrice, rowMinor, rowUntouched, type ManualPriceRow, type StoredManualPrice } from "./manual-prices";
import { SUPPORTED_CURRENCIES, currencyRule } from "./money";

// The manual prices of the plan-version editor: what a stored price becomes when the
// editor opens, and what is sent back when it saves. Pure logic, no rendering.

const stored = (currency: string, unitAmountMinor: number, extra: Partial<StoredManualPrice> = {}): StoredManualPrice => ({ interval: "month", intervalCount: 1, currency, unitAmountMinor, label: null, ...extra });
const sent = (row: ManualPriceRow) => {
  const r = rowMinor(row);
  return r.ok ? r.minor : r.error;
};
/** Open a stored price in the editor and save it without touching it. */
const reopened = (p: StoredManualPrice) => sent(rowFromStoredPrice(p));

describe("opening a stored price", () => {
  it("shows the exact amount in the currency's own unit", () => {
    expect(rowFromStoredPrice(stored("usd", 4900)).unitAmount).toBe("49.00");
    expect(rowFromStoredPrice(stored("sar", 125050)).unitAmount).toBe("1250.50");
    expect(rowFromStoredPrice(stored("jpy", 5000)).unitAmount).toBe("5000");
    expect(rowFromStoredPrice(stored("isk", 50000)).unitAmount).toBe("500");
    expect(rowFromStoredPrice(stored("huf", 490000)).unitAmount).toBe("4900.00");
    expect(rowFromStoredPrice(stored("kwd", 10000)).unitAmount).toBe("10.000");
  });

  it("carries the other fields over", () => {
    const row = rowFromStoredPrice(stored("eur", 19000, { interval: "year", intervalCount: 2, label: "Biennial" }));
    expect(row).toMatchObject({ interval: "year", intervalCount: "2", currency: "eur", unitAmount: "190.00", label: "Biennial" });
    expect(rowFromStoredPrice(stored("eur", 1900)).label).toBe("");
  });

  it("yen was shown divided by 100 before: 5,000 yen opened as 50.00 and saved as 5,000 only by luck", () => {
    // The old editor wrote (minor / 100).toFixed(2) and read Math.round(text * 100).
    expect((5000 / 100).toFixed(2)).toBe("50.00");
    expect(rowFromStoredPrice(stored("jpy", 5000)).unitAmount).toBe("5000");
  });
});

describe("saving without touching a price", () => {
  it("sends back the stored amount, for every currency and amount", () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const whole = currencyRule(code)!.kind === "whole-units";
      for (const v of [0, 1, 99, 100, 4900, 123456789, MAX_MANUAL_PRICE_MINOR]) {
        const amount = whole ? Math.floor(v / 100) * 100 : v;
        expect(reopened(stored(code.toLowerCase(), amount)), `${code} ${amount}`).toBe(amount);
      }
    }
  });

  it("keeps a stored amount that no one could type today", () => {
    // 5.50 ISK is not a whole króna: typing it is refused, but an untouched row keeps it.
    const row = rowFromStoredPrice(stored("isk", 550));
    expect(row.unitAmount).toBe("5.50");
    expect(rowUntouched(row)).toBe(true);
    expect(sent(row)).toBe(550);
    // Above today's limit: still preserved while untouched.
    expect(reopened(stored("usd", MAX_MANUAL_PRICE_MINOR + 1))).toBe(MAX_MANUAL_PRICE_MINOR + 1);
  });

  it("keeps the stored amount of an unsupported currency exactly", () => {
    const row = rowFromStoredPrice(stored("xyz", 5000));
    expect(row.unitAmount).toBe(""); // there is no sound amount to show
    expect(rowUntouched(row)).toBe(true);
    expect(sent(row)).toBe(5000); // not 500000, not 50
  });

  it("changing only the label or the period leaves the amount alone", () => {
    const row = { ...rowFromStoredPrice(stored("isk", 550)), label: "Legacy", interval: "year" as const, intervalCount: "2" };
    expect(rowUntouched(row)).toBe(true);
    expect(sent(row)).toBe(550);
  });
});

describe("editing a price", () => {
  it("parses what was typed, exactly", () => {
    const row = rowFromStoredPrice(stored("usd", 4900));
    expect(sent({ ...row, unitAmount: "59.99" })).toBe(5999);
    expect(sent({ ...row, unitAmount: "59.999" })).toBe("TOO_MANY_DECIMALS");
    expect(sent({ ...row, unitAmount: "" })).toBe("EMPTY");
  });

  it("re-reads the amount when the currency changes", () => {
    const usd = rowFromStoredPrice(stored("usd", 4900)); // "49.00"
    expect(sent({ ...usd, currency: "jpy" })).toBe(49); // 49.00 yen is 49 yen
    expect(sent({ ...usd, currency: "jpy", unitAmount: "49.50" })).toBe("WHOLE_UNITS_ONLY");
    expect(sent({ ...usd, currency: "kwd" })).toBe(49000);
    expect(sent({ ...usd, currency: "isk" })).toBe(4900);
    expect(sent({ ...usd, currency: "xyz" })).toBe("UNSUPPORTED_CURRENCY");
    // Back to the stored currency and text: untouched again.
    expect(rowUntouched({ ...usd, currency: "USD " })).toBe(true);
  });

  it("an unsupported currency cannot be given a new amount", () => {
    const row = rowFromStoredPrice(stored("xyz", 5000));
    expect(sent({ ...row, unitAmount: "60" })).toBe("UNSUPPORTED_CURRENCY");
    // Moving it to a supported currency needs the amount typed again.
    expect(sent({ ...row, currency: "usd" })).toBe("EMPTY");
    expect(sent({ ...row, currency: "usd", unitAmount: "60" })).toBe(6000);
  });

  it("enforces the API's upper limit on what is typed", () => {
    const row = { ...EMPTY_MANUAL_PRICE };
    expect(sent({ ...row, unitAmount: "10000000.00" })).toBe(MAX_MANUAL_PRICE_MINOR);
    expect(sent({ ...row, unitAmount: "10000000.01" })).toBe("TOO_LARGE");
    expect(sent({ ...row, currency: "jpy", unitAmount: "1000000001" })).toBe("TOO_LARGE");
  });
});

describe("a new price", () => {
  it("starts as 0.00 US dollars a month and is valid", () => {
    expect(EMPTY_MANUAL_PRICE).toMatchObject({ interval: "month", intervalCount: "1", currency: "usd", unitAmount: "0.00" });
    expect(rowUntouched(EMPTY_MANUAL_PRICE)).toBe(false);
    expect(sent(EMPTY_MANUAL_PRICE)).toBe(0);
  });

  it("create → save → open → save keeps the value", () => {
    for (const [currency, typed, minor] of [
      ["usd", "49.00", 4900],
      ["sar", "1250.50", 125050],
      ["jpy", "5000", 5000],
      ["isk", "500", 50000],
      ["huf", "4900", 490000],
      ["kwd", "10.5", 10500],
    ] as const) {
      const first = sent({ ...EMPTY_MANUAL_PRICE, currency, unitAmount: typed });
      expect(first, currency).toBe(minor);
      const again = rowFromStoredPrice(stored(currency, first as number));
      expect(sent(again), currency).toBe(minor);
      // And a third time, after "editing" to the very same text.
      expect(sent({ ...again, unitAmount: again.unitAmount }), currency).toBe(minor);
    }
  });
});
