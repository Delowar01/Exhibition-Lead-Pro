/**
 * Shared currency formatting and conversion for the mobile app.
 *
 * Every financial value flows through formatCurrency() so the display
 * automatically reflects the user's selected country currency.
 *
 * Multi-currency design:
 *  - Each opportunity stores its own `currency` (ISO 4217) alongside `value`.
 *  - Totals are computed by converting each record to the user's display
 *    currency via convertCurrency(), then summing — never by summing raw
 *    numbers and re-labelling them with a different currency code.
 *  - GCC rates are fixed pegs (authoritative); EGP/MAD are representative
 *    approximations. Update FX_RATES_TO_USD to refresh rates in future.
 */

/**
 * Exchange rates relative to USD as the common base.
 * Value = how many units of that currency equal 1 USD.
 *   SAR: 3.75  → 1 USD = 3.75 SAR  → 35,000 USD × 3.75 = 131,250 SAR
 */
export const FX_RATES_TO_USD: Record<string, number> = {
  USD: 1.0,
  SAR: 3.75,    // fixed peg
  AED: 3.6725,  // fixed peg
  QAR: 3.64,    // fixed peg
  OMR: 0.3845,  // fixed peg (1 OMR ≈ 2.60 USD)
  KWD: 0.3067,  // fixed peg (1 KWD ≈ 3.26 USD)
  BHD: 0.376,   // fixed peg (1 BHD ≈ 2.66 USD)
  EGP: 50.0,    // representative rate (floating)
  MAD: 10.0,    // representative rate (floating)
  EUR: 0.92,
  GBP: 0.79,
  JOD: 0.709,
};

/**
 * Convert `value` from `fromCurrency` to `toCurrency` using USD as the
 * common intermediate. Returns the original value unchanged when both
 * currencies are the same. Unknown currencies fall back to USD (1:1).
 *
 * Example:
 *   convertCurrency(35000, "USD", "SAR") → 131,250
 *   convertCurrency(85000, "USD", "SAR") → 318,750
 */
export function convertCurrency(
  value: number,
  fromCurrency: string,
  toCurrency: string,
): number {
  const from = (fromCurrency || "USD").toUpperCase();
  const to = (toCurrency || "USD").toUpperCase();
  if (from === to) return value;
  const fromRate = FX_RATES_TO_USD[from] ?? 1.0;
  const toRate = FX_RATES_TO_USD[to] ?? 1.0;
  return (value / fromRate) * toRate;
}

/**
 * Format a numeric amount with an ISO 4217 currency code prefix.
 * Uses compact notation for large values (1k, 1.5M) to fit dashboard cards.
 *
 * Examples:
 *   formatCurrency(25000, "SAR")  → "SAR 25k"
 *   formatCurrency(1250000, "AED") → "AED 1.3M"
 *   formatCurrency(500, "QAR")    → "QAR 500"
 *
 * @param value       Numeric value (raw, not pre-formatted)
 * @param currencyCode  ISO 4217 code, e.g. "SAR", "AED", "USD"
 */
export function formatCurrency(value: number, currencyCode = "USD"): string {
  const code = (currencyCode || "USD").toUpperCase();
  if (value >= 1_000_000) {
    return `${code} ${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${code} ${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  }
  return `${code} ${Math.round(value)}`;
}

/**
 * Format a full (non-compact) currency amount with thousands separators.
 * Use this in detail views where space is not a concern.
 *
 * Examples:
 *   formatCurrencyFull(25000, "SAR") → "SAR 25,000"
 *   formatCurrencyFull(1250000, "AED") → "AED 1,250,000"
 */
export function formatCurrencyFull(value: number, currencyCode = "USD"): string {
  const code = (currencyCode || "USD").toUpperCase();
  return `${code} ${Math.round(value).toLocaleString("en-US")}`;
}
