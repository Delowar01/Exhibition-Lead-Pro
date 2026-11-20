// Phase 2 Batch 1 — plural categories for the app's two languages, guaranteed.
//
// i18next picks a plural form (`…_one`, `…_few`, …) by asking
// `Intl.PluralRules`. Where the JavaScript engine does not provide it, i18next
// silently falls back to "one / other" — which is wrong for Arabic, whose
// grammar distinguishes six categories. The Arabic and English rules are short
// and fixed (Unicode CLDR), so the app carries them itself and installs them
// ONLY when the engine's own implementation is missing or does not know
// Arabic. Pure and unit-tested; no dependency.

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** CLDR cardinal rule for Arabic. */
export function arabicCardinal(n: number): PluralCategory {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs) || !Number.isInteger(abs)) return "other";
  if (abs === 0) return "zero";
  if (abs === 1) return "one";
  if (abs === 2) return "two";
  const mod100 = abs % 100;
  if (mod100 >= 3 && mod100 <= 10) return "few";
  if (mod100 >= 11 && mod100 <= 99) return "many";
  return "other";
}

/** CLDR cardinal rule for English. */
export function englishCardinal(n: number): PluralCategory {
  return Math.abs(n) === 1 && Number.isInteger(n) ? "one" : "other";
}

/** CLDR ordinal rule for English (1st, 2nd, 3rd, 4th). Arabic ordinals have a single category. */
export function englishOrdinal(n: number): PluralCategory {
  const abs = Math.abs(n);
  if (!Number.isInteger(abs)) return "other";
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 === 2 && mod100 !== 12) return "two";
  if (mod10 === 3 && mod100 !== 13) return "few";
  return "other";
}

const ARABIC_CATEGORIES: PluralCategory[] = ["zero", "one", "two", "few", "many", "other"];

function baseLanguage(locales: unknown): string {
  const first = Array.isArray(locales) ? locales[0] : locales;
  return typeof first === "string" && first.length > 0 ? first.toLowerCase().split(/[-_]/)[0]! : "en";
}

/** The minimal `Intl.PluralRules` surface i18next uses, for Arabic and English. */
export class AppPluralRules {
  private readonly language: string;
  private readonly type: "cardinal" | "ordinal";

  constructor(locales?: string | string[], options?: { type?: "cardinal" | "ordinal" }) {
    this.language = baseLanguage(locales);
    this.type = options?.type === "ordinal" ? "ordinal" : "cardinal";
  }

  select(n: number): PluralCategory {
    if (this.type === "ordinal") return this.language === "ar" ? "other" : englishOrdinal(n);
    return this.language === "ar" ? arabicCardinal(n) : englishCardinal(n);
  }

  resolvedOptions(): { locale: string; type: "cardinal" | "ordinal"; pluralCategories: PluralCategory[] } {
    const pluralCategories: PluralCategory[] =
      this.type === "ordinal"
        ? this.language === "ar"
          ? ["other"]
          : ["one", "two", "few", "other"]
        : this.language === "ar"
          ? [...ARABIC_CATEGORIES]
          : ["one", "other"];
    return { locale: this.language, type: this.type, pluralCategories };
  }

  static supportedLocalesOf(locales?: string | string[]): string[] {
    const list = Array.isArray(locales) ? locales : locales ? [locales] : [];
    return list.filter((l) => ["en", "ar"].includes(baseLanguage(l)));
  }
}

type IntlLike = { PluralRules?: unknown };

/** Does this `Intl.PluralRules` give the right category for Arabic and English? */
export function pluralRulesAreUsable(intl: IntlLike | undefined): boolean {
  const Rules = intl?.PluralRules as (new (l: string) => { select(n: number): string; resolvedOptions(): { pluralCategories?: string[] } }) | undefined;
  if (typeof Rules !== "function") return false;
  try {
    const ar = new Rules("ar");
    const en = new Rules("en");
    return (
      ar.select(0) === "zero" &&
      ar.select(2) === "two" &&
      ar.select(3) === "few" &&
      ar.select(11) === "many" &&
      ar.select(100) === "other" &&
      en.select(1) === "one" &&
      en.select(2) === "other" &&
      (ar.resolvedOptions().pluralCategories?.length ?? 0) === 6
    );
  } catch {
    return false;
  }
}

/**
 * Make sure plural selection works for Arabic and English. Leaves a working
 * engine implementation alone; otherwise installs {@link AppPluralRules}.
 * Returns which one is in use. Must run before the first translation.
 */
export function ensurePluralRules(target: { Intl?: IntlLike } = globalThis as { Intl?: IntlLike }): "engine" | "app" {
  if (pluralRulesAreUsable(target.Intl)) return "engine";
  if (!target.Intl) target.Intl = {};
  target.Intl.PluralRules = AppPluralRules;
  return "app";
}
