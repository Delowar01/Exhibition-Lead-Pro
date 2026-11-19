import { describe, expect, it } from "vitest";
import {
  SUPPORTED_CURRENCIES,
  amountHint,
  currencyRule,
  decimalToScaled,
  formatMinor,
  isSupportedCurrency,
  minorToAmountText,
  parseAmountToMinor,
  scaledToDecimal,
} from "./money";

// The portal's one currency policy. The rules are those of the billing provider's
// "Supported currencies" documentation (https://docs.stripe.com/currencies, read
// 2026-11-19); the lists below are written out here independently of the module.

const ZERO_DECIMAL_PER_PROVIDER = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];
const MAX = 1_000_000_000;

const minor = (text: string, currency: string, max?: number) => {
  const r = parseAmountToMinor(text, currency, max);
  return r.ok ? r.minor : r.error;
};

describe("currency rules", () => {
  it("covers the provider's list: 139 currencies, each with exactly one rule", () => {
    expect(SUPPORTED_CURRENCIES).toHaveLength(139);
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(139);
    for (const code of SUPPORTED_CURRENCIES) {
      expect(code, code).toMatch(/^[A-Z]{3}$/);
      expect(currencyRule(code), code).not.toBeNull();
      expect(isSupportedCurrency(code.toLowerCase()), code).toBe(true);
    }
  });

  it("two decimals unless the provider says otherwise", () => {
    for (const code of ["usd", "SAR", "aed", "eur", "gbp", "qar", "egp", "bdt", "inr"]) {
      expect(currencyRule(code), code).toMatchObject({ kind: "two-decimal", exponent: 2, decimals: 2 });
    }
    // Everything that is not on one of the three special lists is two-decimal.
    const special = new Set([...ZERO_DECIMAL_PER_PROVIDER, "ISK", "BHD", "JOD", "KWD", "OMR", "TND"]);
    for (const code of SUPPORTED_CURRENCIES.filter((c) => !special.has(c))) expect(currencyRule(code)?.kind, code).toBe("two-decimal");
  });

  it("zero-decimal currencies: the stored amount is the amount", () => {
    for (const code of ZERO_DECIMAL_PER_PROVIDER.filter((c) => c !== "UGX")) {
      expect(SUPPORTED_CURRENCIES, code).toContain(code);
      expect(currencyRule(code), code).toMatchObject({ kind: "zero-decimal", exponent: 0, decimals: 0 });
    }
  });

  it("ISK and UGX are stored in hundredths and entered as whole numbers", () => {
    // "represent it as a two-decimal value, where the decimal amount is always 00 … to charge 5 ISK, provide an amount value of 500"
    for (const code of ["ISK", "ugx"]) expect(currencyRule(code), code).toMatchObject({ kind: "whole-units", exponent: 2, decimals: 0 });
  });

  it("HUF and TWD are two-decimal for prices: their zero-decimal rule is for payouts only", () => {
    for (const code of ["HUF", "TWD"]) expect(currencyRule(code), code).toMatchObject({ kind: "two-decimal", exponent: 2, decimals: 2 });
  });

  it("the five three-decimal currencies", () => {
    for (const code of ["BHD", "JOD", "KWD", "OMR", "TND"]) expect(currencyRule(code), code).toMatchObject({ kind: "three-decimal", exponent: 3, decimals: 3 });
  });

  it("an unknown or malformed currency has no rule — two decimals are never assumed", () => {
    for (const code of ["xyz", "IQD", "LYD", "BTC", "US", "USDT", "", "  ", "us d", "u$d"]) {
      expect(currencyRule(code), JSON.stringify(code)).toBeNull();
      expect(isSupportedCurrency(code), JSON.stringify(code)).toBe(false);
    }
    expect(currencyRule(null)).toBeNull();
    expect(currencyRule(undefined)).toBeNull();
  });

  it("codes are matched whatever their case or surrounding space", () => {
    expect(currencyRule(" Usd ")?.code).toBe("USD");
    expect(currencyRule("jpy")?.code).toBe("JPY");
  });
});

describe("typed amount → stored minor units", () => {
  it("US dollars and Saudi riyals: two decimals", () => {
    expect(minor("49", "usd")).toBe(4900);
    expect(minor("49.5", "usd")).toBe(4950);
    expect(minor("49.50", "usd")).toBe(4950);
    expect(minor("0.01", "usd")).toBe(1);
    expect(minor(".5", "usd")).toBe(50);
    expect(minor("12.", "usd")).toBe(1200);
    expect(minor("007", "usd")).toBe(700);
    expect(minor("0", "usd")).toBe(0);
    expect(minor("1250.50", "sar")).toBe(125050);
    expect(minor("375", "SAR")).toBe(37500);
  });

  it("is exact where floating point is not", () => {
    // Each of these times 100 is off by one ulp in binary floating point.
    expect(19.99 * 100).not.toBe(1999);
    expect(minor("19.99", "usd")).toBe(1999);
    expect(minor("1.15", "usd")).toBe(115);
    expect(minor("4.35", "usd")).toBe(435);
    expect(minor("8.2", "usd")).toBe(820);
    expect(minor("0.07", "usd")).toBe(7);
    expect(minor("1.005", "usd")).toBe("TOO_MANY_DECIMALS"); // never rounded to 1.00 or 1.01
    // Every amount of cents from 0.00 to 99.99.
    for (let c = 0; c < 10_000; c++) {
      const text = `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
      if (minor(text, "usd") !== c) throw new Error(`${text} → ${minor(text, "usd")}, expected ${c}`);
    }
  });

  it("yen and won: whole numbers, stored as typed", () => {
    expect(minor("5000", "jpy")).toBe(5000);
    expect(minor("5000.00", "jpy")).toBe(5000); // zeros after the point change nothing
    expect(minor("5000.5", "jpy")).toBe("WHOLE_UNITS_ONLY");
    expect(minor("0.5", "krw")).toBe("WHOLE_UNITS_ONLY");
    expect(minor("12000", "KRW")).toBe(12000);
  });

  it("Icelandic króna and Ugandan shilling: whole numbers, stored in hundredths", () => {
    expect(minor("5", "isk")).toBe(500);
    expect(minor("5.00", "isk")).toBe(500);
    expect(minor("5.5", "isk")).toBe("WHOLE_UNITS_ONLY");
    expect(minor("1500", "ugx")).toBe(150000);
    expect(minor("1500.25", "ugx")).toBe("WHOLE_UNITS_ONLY");
  });

  it("forint and New Taiwan dollar: two decimals", () => {
    expect(minor("4900", "huf")).toBe(490000);
    expect(minor("10.45", "huf")).toBe(1045);
    expect(minor("800.45", "twd")).toBe(80045);
  });

  it("Kuwaiti dinar: three decimals", () => {
    expect(minor("10", "kwd")).toBe(10000);
    expect(minor("5.124", "kwd")).toBe(5124);
    expect(minor("5.1", "kwd")).toBe(5100);
    expect(minor("5.1245", "kwd")).toBe("TOO_MANY_DECIMALS");
  });

  it("refuses what is not a plain amount", () => {
    for (const text of ["", "   ", ".", "abc", "-5", "+5", "1e3", "1,000", "1 000", "12.3.4", "0x10", "٥", "5 usd", "$5", "NaN", "Infinity"]) {
      const r = parseAmountToMinor(text, "usd");
      expect(r.ok, JSON.stringify(text)).toBe(false);
      if (!r.ok) expect(["EMPTY", "NOT_A_NUMBER"], JSON.stringify(text)).toContain(r.error);
    }
    expect(minor("", "usd")).toBe("EMPTY");
    expect(minor("  ", "usd")).toBe("EMPTY");
    expect(minor("  49.50  ", "usd")).toBe(4950); // surrounding space is not part of the amount
  });

  it("refuses an unsupported currency, whatever was typed", () => {
    for (const code of ["xyz", "iqd", "", "us"]) {
      const r = parseAmountToMinor("10.00", code);
      expect(r.ok, code).toBe(false);
      if (!r.ok) expect(r.error, code).toBe("UNSUPPORTED_CURRENCY");
    }
    const r = parseAmountToMinor("10.00", "xyz");
    expect(!r.ok && r.message).toBe("XYZ is not a currency the billing provider supports.");
  });

  it("holds the upper limit exactly, in every kind of currency", () => {
    expect(minor("10000000.00", "usd", MAX)).toBe(MAX);
    expect(minor("10000000.01", "usd", MAX)).toBe("TOO_LARGE");
    expect(minor("1000000000", "jpy", MAX)).toBe(MAX);
    expect(minor("1000000001", "jpy", MAX)).toBe("TOO_LARGE");
    expect(minor("10000000", "isk", MAX)).toBe(MAX);
    expect(minor("10000001", "isk", MAX)).toBe("TOO_LARGE");
    expect(minor("1000000.000", "kwd", MAX)).toBe(MAX);
    expect(minor("1000000.001", "kwd", MAX)).toBe("TOO_LARGE");
    // Without a caller's limit, the safe-integer range is the limit — never a rounded double.
    expect(minor("90071992547409.91", "usd")).toBe(Number.MAX_SAFE_INTEGER);
    expect(minor("90071992547409.92", "usd")).toBe("TOO_LARGE");
    expect(minor("99999999999999999999999999", "usd")).toBe("TOO_LARGE");
    expect(minor("9007199254740991", "jpy")).toBe(Number.MAX_SAFE_INTEGER);
    expect(minor("9007199254740992", "jpy")).toBe("TOO_LARGE");
  });

  it("explains each refusal", () => {
    const message = (text: string, currency: string, max?: number) => {
      const r = parseAmountToMinor(text, currency, max);
      return r.ok ? "" : r.message;
    };
    expect(message("5000.5", "jpy")).toBe("JPY has no decimals: enter a whole number.");
    expect(message("1.005", "usd")).toBe("USD has 2 decimals: enter no more than that.");
    expect(message("", "usd")).toBe("Enter an amount.");
    expect(message("abc", "usd")).toContain("digits");
    expect(message("10000000.01", "usd", MAX)).toBe("The amount is too large (at most $10,000,000.00).");
    expect(message("1000000001", "jpy", MAX)).toBe("The amount is too large (at most ¥1,000,000,000).");
  });
});

describe("stored minor units → amount field", () => {
  it("writes the exact amount with the currency's decimals", () => {
    expect(minorToAmountText(4900, "usd")).toBe("49.00");
    expect(minorToAmountText(1, "usd")).toBe("0.01");
    expect(minorToAmountText(0, "usd")).toBe("0.00");
    expect(minorToAmountText(125050, "sar")).toBe("1250.50");
    expect(minorToAmountText(5000, "jpy")).toBe("5000");
    expect(minorToAmountText(500, "isk")).toBe("5");
    expect(minorToAmountText(490000, "huf")).toBe("4900.00");
    expect(minorToAmountText(10000, "kwd")).toBe("10.000");
    expect(minorToAmountText(5124, "kwd")).toBe("5.124");
    expect(minorToAmountText(Number.MAX_SAFE_INTEGER, "usd")).toBe("90071992547409.91");
  });

  it("never hides a stored digit", () => {
    // Not a whole króna: the provider would refuse it, but a stored value is shown as it is.
    expect(minorToAmountText(550, "isk")).toBe("5.50");
    expect(minorToAmountText(5, "ugx")).toBe("0.05");
  });

  it("has nothing to show for an unsupported currency or a value that is not a stored amount", () => {
    expect(minorToAmountText(5000, "xyz")).toBeNull();
    expect(minorToAmountText(5000, "")).toBeNull();
    expect(minorToAmountText(-1, "usd")).toBeNull();
    expect(minorToAmountText(12.5, "usd")).toBeNull();
    expect(minorToAmountText(Number.NaN, "usd")).toBeNull();
    expect(minorToAmountText(2 ** 60, "usd")).toBeNull();
  });
});

describe("round trip: a price that is opened and saved keeps its value", () => {
  const SAMPLES = [0, 1, 9, 10, 99, 100, 101, 999, 1000, 1999, 4900, 49999, 123456789, MAX];

  it("for every supported currency", () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const rule = currencyRule(code)!;
      // Whole-unit currencies only ever hold multiples of 100.
      const values = rule.kind === "whole-units" ? SAMPLES.map((v) => Math.floor(v / 100) * 100) : SAMPLES;
      for (const v of values) {
        const text = minorToAmountText(v, code);
        expect(text, `${code} ${v}`).not.toBeNull();
        expect(minor(text!, code, MAX), `${code} ${v} → "${text}"`).toBe(v);
      }
    }
  });

  it("for a spread of amounts, both ways", () => {
    // A fixed pseudo-random sequence: the same 3,000 amounts on every run.
    let seed = 20261119;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 3000; i++) {
      const v = next() % (MAX + 1);
      for (const code of ["usd", "sar", "jpy", "kwd", "huf"]) {
        const text = minorToAmountText(v, code)!;
        if (minor(text, code, MAX) !== v) throw new Error(`${code}: ${v} → "${text}" → ${minor(text, code, MAX)}`);
        // And the text itself survives: text → minor → text.
        if (minorToAmountText(minor(text, code, MAX) as number, code) !== text) throw new Error(`${code}: "${text}" did not survive`);
      }
      const whole = Math.floor(v / 100) * 100;
      if (minor(minorToAmountText(whole, "isk")!, "isk", MAX) !== whole) throw new Error(`isk: ${whole}`);
    }
  });
});

describe("stored minor units → reading", () => {
  // A currency written as a code is joined to its amount by a non-breaking space, so the two
  // never wrap apart. The expectations below are written with ordinary spaces.
  const read = (minor: number, currency: string | null) => formatMinor(minor, currency).replace(/\u00a0/g, " ");

  it("keeps a currency code and its amount on one line", () => {
    expect(formatMinor(125050, "sar")).toBe("SAR\u00a01,250.50");
  });

  it("formats each kind of currency in its own unit", () => {
    expect(read(176600, "usd")).toBe("$1,766.00");
    expect(read(5000, "USD")).toBe("$50.00");
    expect(read(125050, "sar")).toBe("SAR 1,250.50");
    expect(read(5000, "jpy")).toBe("¥5,000");
    expect(read(12000, "krw")).toBe("₩12,000");
    expect(read(10000, "kwd")).toBe("KWD 10.000");
    expect(read(490000, "huf")).toBe("HUF 4,900.00");
    expect(read(80045, "twd")).toContain("800.45");
    expect(read(1999, "eur")).toBe("€19.99");
    expect(read(0, "usd")).toBe("$0.00");
  });

  it("whole-unit currencies show no decimals — unless the stored amount has some", () => {
    expect(read(50000, "isk")).toBe("ISK 500");
    expect(read(150000, "ugx")).toBe("UGX 1,500");
    expect(read(550, "isk")).toBe("ISK 5.50");
  });

  it("does not convert an unsupported currency: it prints the minor units and says so", () => {
    expect(read(5000, "xyz")).toBe("5,000 XYZ (minor units)");
    expect(read(100, "not-a-currency")).toBe("100 NOT-A-CURRENCY (minor units)");
    expect(read(5000, "")).toBe("5,000 ? (minor units)");
    expect(read(5000, null)).toBe("5,000 ? (minor units)");
    // In particular it is not shown as 50.00 of anything.
    expect(read(5000, "xyz")).not.toContain("50.00");
  });

  it("is exact for large amounts and tolerant of estimates", () => {
    expect(read(Number.MAX_SAFE_INTEGER, "usd")).toBe("$90,071,992,547,409.91");
    expect(read(MAX, "usd")).toBe("$10,000,000.00");
    // An estimate (the monthly share of a yearly price) is rounded to the minor unit.
    expect(read(4900 / 12, "usd")).toBe("$4.08");
    expect(read(-50, "usd")).toBe("-$0.50");
    expect(read(-176600, "usd")).toBe("-$1,766.00");
    expect(read(Number.NaN, "usd")).toBe("—");
    expect(read(Number.POSITIVE_INFINITY, "usd")).toBe("—");
  });
});

describe("exact decimal scaling (AI cost allowance in micro-dollars)", () => {
  it("scales both ways without floating point", () => {
    expect(decimalToScaled("19.99", 6)).toEqual({ ok: true, value: 19_990_000 });
    expect(decimalToScaled("0.000001", 6)).toEqual({ ok: true, value: 1 });
    expect(decimalToScaled("25", 6)).toEqual({ ok: true, value: 25_000_000 });
    expect(decimalToScaled("0.0000001", 6)).toEqual({ ok: false, error: "TOO_MANY_DECIMALS" });
    expect(decimalToScaled("1e3", 6)).toEqual({ ok: false, error: "NOT_A_NUMBER" });
    expect(decimalToScaled("", 6)).toEqual({ ok: false, error: "EMPTY" });
    expect(scaledToDecimal(19_990_000, 6)).toBe("19.99");
    expect(scaledToDecimal(1, 6)).toBe("0.000001");
    expect(scaledToDecimal(25_000_000, 6)).toBe("25");
    expect(scaledToDecimal(0, 6)).toBe("0");
    expect(scaledToDecimal(-1, 6)).toBeNull();
    expect(scaledToDecimal(1.5, 6)).toBeNull();
    for (const micro of [1, 10, 999_999, 1_000_000, 12_345_678, 9_007_199_254]) {
      expect(decimalToScaled(scaledToDecimal(micro, 6)!, 6), String(micro)).toEqual({ ok: true, value: micro });
    }
  });
});

describe("form hints", () => {
  it("say what may be typed", () => {
    expect(amountHint("usd")).toBe("Up to 2 decimals.");
    expect(amountHint("kwd")).toBe("Up to 3 decimals.");
    expect(amountHint("jpy")).toBe("Whole JPY only — no decimals.");
    expect(amountHint("isk")).toBe("Whole ISK only — no decimals.");
    expect(amountHint("xyz")).toBe("Not a currency the billing provider supports.");
  });
});
