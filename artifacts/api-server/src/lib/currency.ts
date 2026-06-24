/**
 * Server-side currency conversion for cross-currency aggregation.
 *
 * Each lead/opportunity stores its own `currency` (ISO 4217) alongside `value`.
 * Any server-computed total (pipeline value, won/lost value, report pipeline
 * value) MUST convert each record to a single base currency BEFORE summing —
 * never sum raw numbers across currencies and re-label the result. USD is the
 * canonical server base: the web portal renders these totals with a "$" prefix,
 * and the mobile client recomputes its own display currency client-side.
 *
 * IMPORTANT: this FX table MUST stay in sync with
 * `artifacts/mobile/lib/currency.ts` (FX_RATES_TO_USD). They are intentional
 * duplicates (the mobile bundle can't import server code); if you change a rate
 * in one, change it in the other.
 *
 * GCC rates are fixed pegs (authoritative); EGP/MAD are representative
 * approximations. Value = how many units of that currency equal 1 USD.
 */
export const FX_RATES_TO_USD: Record<string, number> = {
  USD: 1.0,
  SAR: 3.75, // fixed peg
  AED: 3.6725, // fixed peg
  QAR: 3.64, // fixed peg
  OMR: 0.3845, // fixed peg
  KWD: 0.3067, // fixed peg
  BHD: 0.376, // fixed peg
  EGP: 50.0, // representative rate (floating)
  MAD: 10.0, // representative rate (floating)
  EUR: 0.92,
  GBP: 0.79,
  JOD: 0.709,
};

/**
 * Convert `value` from `fromCurrency` to `toCurrency` via USD as the common
 * intermediate. Same currency is a no-op; unknown currencies fall back to USD
 * (1:1). Non-finite inputs (NaN/Infinity) coerce to 0 so a single bad row can
 * never poison an aggregate total.
 */
export function convertCurrency(value: number, fromCurrency: string, toCurrency: string): number {
  if (!Number.isFinite(value)) return 0;
  const from = (fromCurrency || "USD").toUpperCase();
  const to = (toCurrency || "USD").toUpperCase();
  if (from === to) return value;
  const fromRate = FX_RATES_TO_USD[from] ?? 1.0;
  const toRate = FX_RATES_TO_USD[to] ?? 1.0;
  return (value / fromRate) * toRate;
}
