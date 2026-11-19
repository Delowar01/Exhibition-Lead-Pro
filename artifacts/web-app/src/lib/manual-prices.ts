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

/** A stored price as an editor row. The amount text is exact; it is empty for a currency without a rule. */
export function rowFromStoredPrice(p: StoredManualPrice): ManualPriceRow {
  const amountText = minorToAmountText(p.unitAmountMinor, p.currency) ?? "";
  return { interval: p.interval, intervalCount: String(p.intervalCount), currency: p.currency, unitAmount: amountText, label: p.label ?? "", stored: { minor: p.unitAmountMinor, currency: p.currency, amountText } };
}

/** True while a loaded row still shows exactly what was stored. */
export function rowUntouched(row: ManualPriceRow): boolean {
  return !!row.stored && row.currency.trim().toLowerCase() === row.stored.currency && row.unitAmount === row.stored.amountText;
}

/** The minor amount a row stands for: the stored one while untouched, otherwise what was typed — exact or refused. */
export function rowMinor(row: ManualPriceRow): AmountResult {
  if (rowUntouched(row)) return { ok: true, minor: row.stored!.minor };
  return parseAmountToMinor(row.unitAmount, row.currency, MAX_MANUAL_PRICE_MINOR);
}
