import { minorToAmountText, parseAmountToMinor, type AmountResult } from "./money";

// The manual prices of a plan version, as the editor holds them. Pure (no React): what a
// stored price becomes when the editor opens, and what the editor sends back when it saves.
//
// The rule that keeps an opened-and-saved price identical: while a row's currency and amount
// text are exactly what was loaded, the STORED minor amount is sent back — it is never
// re-derived from the text. Only a row the person actually changed is parsed, and parsing
// is exact or refused (lib/money.ts).

export type ManualPriceInterval = "day" | "week" | "month" | "year";

export interface StoredManualPrice {
  interval: ManualPriceInterval;
  intervalCount: number;
  currency: string;
  unitAmountMinor: number;
  label?: string | null;
}

export interface ManualPriceRow {
  interval: ManualPriceInterval;
  intervalCount: string;
  currency: string;
  /** What the amount field holds. */
  unitAmount: string;
  label: string;
  /** The price as loaded; absent on a row added in the editor. */
  stored?: { minor: number; currency: string; amountText: string };
}

/** The largest manual price the API accepts, in minor units (MAX_PRICE_MINOR on the server). */
export const MAX_MANUAL_PRICE_MINOR = 1_000_000_000;

export const EMPTY_MANUAL_PRICE: ManualPriceRow = { interval: "month", intervalCount: "1", currency: "usd", unitAmount: "0.00", label: "" };

/** A currency code as the editor and the API hold it: trimmed, lower case. */
function normalCurrency(currency: unknown): string {
  return typeof currency === "string" ? currency.trim().toLowerCase() : "";
}

/** A stored price as an editor row. The amount text is exact; it is empty for a currency without a rule. */
export function rowFromStoredPrice(p: StoredManualPrice): ManualPriceRow {
  // Normalised once here, so "untouched" compares like with like whatever case was stored.
  const currency = normalCurrency(p.currency);
  const amountText = minorToAmountText(p.unitAmountMinor, currency) ?? "";
  return { interval: p.interval, intervalCount: String(p.intervalCount), currency, unitAmount: amountText, label: p.label ?? "", stored: { minor: p.unitAmountMinor, currency, amountText } };
}

/** True while a loaded row still shows exactly what was stored. */
export function rowUntouched(row: ManualPriceRow): boolean {
  return !!row.stored && normalCurrency(row.currency) === row.stored.currency && row.unitAmount === row.stored.amountText;
}

/** The minor amount a row stands for: the stored one while untouched, otherwise what was typed — exact or refused. */
export function rowMinor(row: ManualPriceRow): AmountResult {
  if (rowUntouched(row)) return { ok: true, minor: row.stored!.minor };
  return parseAmountToMinor(row.unitAmount, row.currency, MAX_MANUAL_PRICE_MINOR);
}

const INTERVALS: readonly string[] = ["day", "week", "month", "year"];

/**
 * The API's one-line summary of a version's manual prices, as its comparison reports it
 * ("eur/monthx1=1900; eur/yearx1=19900 (Annual)"), back as prices — so the comparison can
 * show amounts the way every other screen does instead of raw minor units. Null when the
 * text is not exactly that format; the caller then shows it as it came.
 */
export function parseManualPricesText(text: unknown): StoredManualPrice[] | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  // Entries are joined with "; ". A label may contain that too, so split only where the next entry begins.
  const parts = text.split(/; (?=[a-z]{3}\/(?:day|week|month|year)x\d{1,2}=\d+(?: \(|;|$))/);
  const out: StoredManualPrice[] = [];
  for (const part of parts) {
    const m = /^([a-z]{3})\/([a-z]+)x(\d{1,2})=(\d{1,16})(?: \((.*)\))?$/.exec(part);
    if (!m || !INTERVALS.includes(m[2])) return null;
    const minor = Number(m[4]);
    if (!Number.isSafeInteger(minor)) return null;
    out.push({ currency: m[1], interval: m[2] as ManualPriceInterval, intervalCount: Number(m[3]), unitAmountMinor: minor, label: m[5] ?? null });
  }
  return out;
}
