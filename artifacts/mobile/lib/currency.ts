/**
 * Shared currency formatting for the mobile app.
 *
 * All financial values should flow through formatCurrency() so the display
 * automatically reflects the user's selected country currency.
 *
 * Future-ready design:
 *  - currencyCode is stored per-opportunity in the DB; existing records are
 *    unaffected when the user changes their country setting.
 *  - Multi-currency, exchange-rate sync, and user overrides can be added later
 *    by replacing this formatter — no data model changes required.
 */

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
