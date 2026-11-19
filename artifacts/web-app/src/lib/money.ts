/**
 * The portal's one currency policy: how a stored amount — an integer in the currency's
 * smallest unit, exactly as the billing provider reports it — relates to the amount people
 * read and type. Every price and revenue figure in minor units goes through this file;
 * nothing else divides or multiplies by 100.
 *
 * Source: Stripe, "Supported currencies" — https://docs.stripe.com/currencies
 * (read 2026-11-19). What that page states, and what this file does with it:
 *
 *  - "Currencies are two-decimal currencies unless otherwise specified. All API requests
 *    expect amount values in the currency's minor unit": 1000 is 10 USD.
 *  - Zero-decimal currencies: "the charge and the amount are the same" — 500 is 500 JPY.
 *  - Special cases, charges:
 *      ISK and UGX "transitioned to a zero-decimal currency, but backward compatibility
 *      requires you to represent it as a two-decimal value, where the decimal amount is
 *      always 00" — 500 is 5 ISK, and fractions cannot be charged. They are stored as
 *      hundredths and entered and shown as whole numbers. (UGX is also printed in the
 *      page's zero-decimal list; the special-case rule is the more specific one.)
 *  - Special cases, payouts only:
 *      HUF and TWD are "a zero-decimal currency for payouts, even though you can charge
 *      two-decimal amounts". This product records prices and never creates payouts, so
 *      both are ordinary two-decimal currencies here.
 *  - Three-decimal currencies (BHD, JOD, KWD, OMR, TND): the page lists them as supported
 *    for some account countries and gives no amount rule for them. ISO 4217 gives each
 *    three decimals, which is what this file applies. Confirm with the provider before one
 *    of them is used for a live price.
 *
 * A currency that is not in the provider's list is UNSUPPORTED: it is never assumed to
 * have two decimals. Its stored amounts are shown as what they are (a number of minor
 * units) and it cannot be used for a new price.
 *
 * No floating point: conversions are done on digit strings, so 19.99 is 1999 and never
 * 1998.9999999999998, and an amount with more decimals than the currency has is refused,
 * not rounded.
 */

const ZERO_DECIMAL = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"] as const;
/** Stored in hundredths for backward compatibility; the hundredths are always 00. */
const WHOLE_UNITS_IN_HUNDREDTHS = ["ISK", "UGX"] as const;
const THREE_DECIMAL = ["BHD", "JOD", "KWD", "OMR", "TND"] as const;

/** Every presentment currency of the provider (the union of its per-country lists). */
export const SUPPORTED_CURRENCIES: readonly string[] = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD",
  "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ETB", "EUR", "FJD",
  "FKP", "GBP", "GEL", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "ISK", "JMD", "JOD", "JPY", "KES",
  "KGS", "KHR", "KMF", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "STD", "SZL", "THB", "TJS", "TND", "TOP", "TRY",
  "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW",
];

export type CurrencyKind = "two-decimal" | "zero-decimal" | "three-decimal" | "whole-units";

export interface CurrencyRule {
  /** Upper-case ISO code. */
  code: string;
  kind: CurrencyKind;
  /** The stored amount is the readable amount × 10^exponent. */
  exponent: 0 | 2 | 3;
  /** Decimals a person may type, and the decimals normally shown. */
  decimals: 0 | 2 | 3;
}

const SUPPORTED = new Set(SUPPORTED_CURRENCIES);
const RULES = new Map<string, CurrencyRule>();
for (const code of SUPPORTED_CURRENCIES) {
  if ((ZERO_DECIMAL as readonly string[]).includes(code)) RULES.set(code, { code, kind: "zero-decimal", exponent: 0, decimals: 0 });
  else if ((WHOLE_UNITS_IN_HUNDREDTHS as readonly string[]).includes(code)) RULES.set(code, { code, kind: "whole-units", exponent: 2, decimals: 0 });
  else if ((THREE_DECIMAL as readonly string[]).includes(code)) RULES.set(code, { code, kind: "three-decimal", exponent: 3, decimals: 3 });
  else RULES.set(code, { code, kind: "two-decimal", exponent: 2, decimals: 2 });
}

function codeOf(currency: string | null | undefined): string {
  return typeof currency === "string" ? currency.trim().toUpperCase() : "";
}

/** The rule of a supported currency, or null: an unknown currency has no rule to guess. */
export function currencyRule(currency: string | null | undefined): CurrencyRule | null {
  return RULES.get(codeOf(currency)) ?? null;
}

export function isSupportedCurrency(currency: string | null | undefined): boolean {
  return SUPPORTED.has(codeOf(currency));
}

/** One line for a form: what may be typed for this currency. */
export function amountHint(currency: string | null | undefined): string {
  const rule = currencyRule(currency);
  if (!rule) return "Not a currency the billing provider supports.";
  if (rule.decimals === 0) return `Whole ${rule.code} only — no decimals.`;
  return `Up to ${rule.decimals} decimals.`;
}

// ── Exact scaling on digit strings ───────────────────────────────────────────────────────

/** Digits of a non-negative safe integer split into whole part and `scale` decimals. */
function splitScaled(value: number, scale: number): { whole: string; fraction: string } {
  const digits = String(value).padStart(scale + 1, "0");
  return { whole: digits.slice(0, digits.length - scale), fraction: scale === 0 ? "" : digits.slice(digits.length - scale) };
}

/**
 * A non-negative integer scaled by 10^scale, as an exact decimal string without trailing
 * zeros (1_500_000 at scale 6 is "1.5"). Null when the value is not a non-negative safe
 * integer.
 */
export function scaledToDecimal(value: number, scale: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const { whole, fraction } = splitScaled(value, scale);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? whole : `${whole}.${trimmed}`;
}

export type DecimalError = "EMPTY" | "NOT_A_NUMBER" | "TOO_MANY_DECIMALS" | "TOO_LARGE";

/**
 * Plain decimal text ("12", "12.5", ".5") scaled by 10^scale to an exact integer. Refuses
 * signs, exponents, separators and spaces, and any non-zero digit beyond `scale` decimals:
 * nothing is rounded.
 */
export function decimalToScaled(text: string, scale: number, max: number = Number.MAX_SAFE_INTEGER): { ok: true; value: number } | { ok: false; error: DecimalError } {
  const t = text.trim();
  if (t === "") return { ok: false, error: "EMPTY" };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { ok: false, error: "NOT_A_NUMBER" };
  const whole = m[1].replace(/^0+(?=\d)/, "");
  const fraction = m[2] ?? "";
  if (/[1-9]/.test(fraction.slice(scale))) return { ok: false, error: "TOO_MANY_DECIMALS" };
  const digits = ((whole === "" ? "0" : whole) + fraction.slice(0, scale).padEnd(scale, "0")).replace(/^0+(?=\d)/, "");
  // 16 digits can exceed the safe-integer range; compare as text before converting.
  const limit = String(Math.min(max, Number.MAX_SAFE_INTEGER));
  if (digits.length > limit.length || (digits.length === limit.length && digits > limit)) return { ok: false, error: "TOO_LARGE" };
  return { ok: true, value: Number(digits) };
}

// ── Prices ────────────────────────────────────────────────────────────────────────────────

/**
 * The text a stored amount shows in an amount field. Exact, and never hides a stored
 * digit: an ISK amount that is not a whole number (which the provider would not accept, but
 * a row may hold) keeps its hundredths. Null when the currency is unsupported or the amount
 * is not a non-negative safe integer — there is then nothing sound to prefill.
 */
export function minorToAmountText(minor: number, currency: string | null | undefined): string | null {
  const rule = currencyRule(currency);
  if (!rule || !Number.isSafeInteger(minor) || minor < 0) return null;
  const { whole, fraction } = splitScaled(minor, rule.exponent);
  if (rule.exponent === 0) return whole;
  if (rule.decimals === 0) return /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
  return `${whole}.${fraction}`;
}

export type AmountError = "UNSUPPORTED_CURRENCY" | "EMPTY" | "NOT_A_NUMBER" | "TOO_MANY_DECIMALS" | "WHOLE_UNITS_ONLY" | "TOO_LARGE";
export type AmountResult = { ok: true; minor: number } | { ok: false; error: AmountError; message: string };

/**
 * What a person typed, as the stored amount in the currency's minor unit. Exact or
 * refused: "19.99" USD is 1999, "5000" JPY is 5000, "5" ISK is 500, "12.345" USD is an
 * error. `maxMinor` is the largest stored amount the caller accepts.
 */
export function parseAmountToMinor(text: string, currency: string | null | undefined, maxMinor: number = Number.MAX_SAFE_INTEGER): AmountResult {
  const rule = currencyRule(currency);
  const code = codeOf(currency) || "This";
  if (!rule) return { ok: false, error: "UNSUPPORTED_CURRENCY", message: `${code} is not a currency the billing provider supports.` };
  const r = decimalToScaled(text, rule.decimals);
  if (!r.ok) {
    if (r.error === "EMPTY") return { ok: false, error: "EMPTY", message: "Enter an amount." };
    if (r.error === "NOT_A_NUMBER") return { ok: false, error: "NOT_A_NUMBER", message: "Enter the amount as digits, for example 49 or 49.50." };
    if (r.error === "TOO_MANY_DECIMALS") {
      return rule.decimals === 0
        ? { ok: false, error: "WHOLE_UNITS_ONLY", message: `${rule.code} has no decimals: enter a whole number.` }
        : { ok: false, error: "TOO_MANY_DECIMALS", message: `${rule.code} has ${rule.decimals} decimals: enter no more than that.` };
    }
    return { ok: false, error: "TOO_LARGE", message: `The amount is too large (at most ${formatMinor(Math.min(maxMinor, Number.MAX_SAFE_INTEGER), rule.code)}).` };
  }
  // r.value is in units of 10^-decimals; the stored unit is 10^-exponent (they differ for ISK and UGX).
  const factor = 10 ** (rule.exponent - rule.decimals);
  const limit = Math.min(maxMinor, Number.MAX_SAFE_INTEGER);
  if (r.value > Math.floor(limit / factor)) return { ok: false, error: "TOO_LARGE", message: `The amount is too large (at most ${formatMinor(limit, rule.code)}).` };
  return { ok: true, minor: r.value * factor };
}

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * A stored amount for reading: "$1,766.00", "¥5,000", "SAR 1,250.00", "KWD 10.000",
 * "ISK 500". US-English notation everywhere, so a figure reads the same on every page.
 *
 * An unsupported currency is not converted: its amount is printed as the number of minor
 * units it is, and says so. A value that is not a whole number of minor units (the monthly
 * share of a yearly price, for instance) is rounded to the nearest minor unit first.
 */
export function formatMinor(minor: number, currency: string | null | undefined): string {
  const code = codeOf(currency);
  if (!Number.isFinite(minor)) return "—";
  const rounded = Math.round(minor);
  const rule = currencyRule(code);
  if (!rule || !Number.isSafeInteger(rounded)) return `${GROUPED.format(rounded)} ${code || "?"} (minor units)`;
  const negative = rounded < 0;
  const { whole, fraction } = splitScaled(Math.abs(rounded), rule.exponent);
  // Whole-unit currencies show no decimals unless the stored amount really has some.
  const shown = rule.decimals === 0 && /^0*$/.test(fraction) ? "" : fraction;
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: rule.code, minimumFractionDigits: shown.length, maximumFractionDigits: shown.length }).formatToParts(
      negative ? -Number(whole) || -0 : Number(whole),
    );
    // The whole part is an exact integer; the decimals are placed as digits, never computed.
    return parts.map((p) => (p.type === "fraction" ? shown : p.value)).join("");
  } catch {
    return `${negative ? "-" : ""}${GROUPED.format(Number(whole))}${shown ? `.${shown}` : ""} ${rule.code}`;
  }
}
