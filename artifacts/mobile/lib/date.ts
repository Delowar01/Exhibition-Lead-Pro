// Forces the Gregorian calendar with Latin digits for ALL date/time display,
// ignoring the device's regional calendar (e.g. Hijri on some Android/iOS
// locales). Always use these helpers instead of Date.toLocaleDateString /
// toLocaleString so dates render identically on every device.

const GREGORIAN_LOCALE = "en-US";

export function formatGregorian(
  date: Date,
  opts: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(GREGORIAN_LOCALE, {
    calendar: "gregory",
    numberingSystem: "latn",
    ...opts,
  }).format(date);
}
