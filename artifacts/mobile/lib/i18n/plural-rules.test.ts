// Phase 2 Batch 1 — Arabic plural forms. Arabic grammar has six categories;
// before this change every family but one carried only two of them, so counts
// like 3 or 11 fell back to the ENGLISH sentence inside the Arabic interface.
import i18next from "i18next";
import { describe, expect, it } from "vitest";

import ar from "./locales/ar.json";
import en from "./locales/en.json";
import { AppPluralRules, arabicCardinal, englishCardinal, englishOrdinal, ensurePluralRules, pluralRulesAreUsable } from "./plural-rules";

type Tree = { [k: string]: string | Tree };
function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out[prefix + k] = v;
    else Object.assign(out, flatten(v, `${prefix}${k}.`));
  }
  return out;
}
const EN = flatten(en as Tree);
const AR = flatten(ar as Tree);
const FORMS = ["zero", "one", "two", "few", "many", "other"] as const;
const FAMILIES = [...new Set(Object.keys(EN).filter((k) => k.endsWith("_one")).map((k) => k.slice(0, -4)))].sort();
const ARABIC_LETTER = /[\u0600-\u06FF]/;

describe("the rules", () => {
  it("Arabic: zero, one, two, few (3–10), many (11–99), other — also past one hundred", () => {
    const expected: Record<number, string> = { 0: "zero", 1: "one", 2: "two", 3: "few", 10: "few", 11: "many", 99: "many", 100: "other", 101: "other", 102: "other", 103: "few", 110: "few", 111: "many", 199: "many", 200: "other", 1000: "other", 1003: "few", 1011: "many" };
    for (const [n, category] of Object.entries(expected)) expect(arabicCardinal(Number(n)), n).toBe(category);
    expect(arabicCardinal(1.5)).toBe("other");
    expect(arabicCardinal(-2)).toBe("two");
  });

  it("agree with the platform's own rules wherever those exist (checked for 0…1200)", () => {
    const arRules = new Intl.PluralRules("ar");
    const enRules = new Intl.PluralRules("en");
    const enOrdinal = new Intl.PluralRules("en", { type: "ordinal" });
    for (let n = 0; n <= 1200; n += 1) {
      expect(arabicCardinal(n), `ar ${n}`).toBe(arRules.select(n));
      expect(englishCardinal(n), `en ${n}`).toBe(enRules.select(n));
      expect(englishOrdinal(n), `en ordinal ${n}`).toBe(enOrdinal.select(n));
    }
  });

  it("a working engine implementation is left alone; a missing or Arabic-blind one is replaced", () => {
    expect(pluralRulesAreUsable(Intl)).toBe(true);
    expect(ensurePluralRules({ Intl })).toBe("engine");

    const noIntl: { Intl?: { PluralRules?: unknown } } = {};
    expect(ensurePluralRules(noIntl)).toBe("app");
    expect(noIntl.Intl?.PluralRules).toBe(AppPluralRules);

    const missing = { Intl: {} as { PluralRules?: unknown } };
    expect(pluralRulesAreUsable(missing.Intl)).toBe(false);
    expect(ensurePluralRules(missing)).toBe("app");

    // an engine that knows only "one / other" for every language
    class EnglishOnly {
      select(n: number) {
        return n === 1 ? "one" : "other";
      }
      resolvedOptions() {
        return { pluralCategories: ["one", "other"] };
      }
    }
    const blind = { Intl: { PluralRules: EnglishOnly as unknown } };
    expect(pluralRulesAreUsable(blind.Intl)).toBe(false);
    expect(ensurePluralRules(blind)).toBe("app");
    expect(blind.Intl.PluralRules).toBe(AppPluralRules);
  });

  it("the app's implementation offers what i18next asks for", () => {
    const rules = new AppPluralRules("ar-SA");
    expect(rules.select(5)).toBe("few");
    expect(rules.resolvedOptions().pluralCategories).toEqual([...FORMS]);
    expect(new AppPluralRules("en-GB").resolvedOptions().pluralCategories).toEqual(["one", "other"]);
    expect(new AppPluralRules("en", { type: "ordinal" }).select(22)).toBe("two");
    expect(new AppPluralRules("ar", { type: "ordinal" }).select(22)).toBe("other");
    expect(new AppPluralRules(undefined).select(1)).toBe("one");
    expect(AppPluralRules.supportedLocalesOf(["ar", "fr", "en-US"])).toEqual(["ar", "en-US"]);
  });
});

describe("the Arabic strings", () => {
  it("there are plural families to check", () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(22);
  });

  it("EVERY plural family has all six Arabic forms, each actually in Arabic", () => {
    for (const family of FAMILIES) {
      for (const form of FORMS) {
        const value = AR[`${family}_${form}`];
        expect(typeof value, `${family}_${form}`).toBe("string");
        expect(value, `${family}_${form}`).toMatch(ARABIC_LETTER);
      }
    }
  });

  it("the forms that state a number carry the number", () => {
    for (const family of FAMILIES) {
      for (const form of ["few", "many", "other"] as const) {
        expect(AR[`${family}_${form}`], `${family}_${form}`).toContain("{{count}}");
      }
    }
  });
});

async function translator(withoutIntlPluralRules: boolean) {
  const saved = Intl.PluralRules;
  if (withoutIntlPluralRules) {
    // The situation on a JavaScript engine without Intl.PluralRules.
    (Intl as unknown as { PluralRules?: unknown }).PluralRules = undefined;
    ensurePluralRules();
  }
  const instance = i18next.createInstance();
  await instance.init({
    resources: { en: { translation: en }, ar: { translation: ar } },
    lng: "ar",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
  });
  return {
    t: (key: string, count: number) => instance.t(key, { count, size: "1.2", name: "x", index: 1, total: 2, saved: 1 }),
    restore: () => {
      (Intl as unknown as { PluralRules: unknown }).PluralRules = saved;
    },
  };
}

const COUNTS = [0, 1, 2, 3, 7, 10, 11, 25, 99, 100, 101, 250, 1000];

describe("what an Arabic user actually reads, for every plural family and count", () => {
  for (const mode of ["with the engine's Intl.PluralRules", "on an engine without Intl.PluralRules"] as const) {
    it(`${mode}: always Arabic, never the English sentence, never a raw key`, async () => {
      const { t, restore } = await translator(mode.startsWith("on an engine"));
      try {
        for (const family of FAMILIES) {
          for (const n of COUNTS) {
            const value = t(family, n);
            expect(value, `${family} (${n})`).toMatch(ARABIC_LETTER);
            expect(value, `${family} (${n})`).not.toBe(family);
            expect(value, `${family} (${n})`).not.toBe(EN[`${family}_one`]?.replace("{{count}}", String(n)));
            expect(value, `${family} (${n})`).not.toBe(EN[`${family}_other`]?.replace("{{count}}", String(n)));
            expect(value, `${family} (${n})`).not.toContain("{{");
            // the form used is the one Arabic grammar asks for
            expect(value, `${family} (${n})`).toBe(AR[`${family}_${arabicCardinal(n)}`]!.replace(/\{\{count\}\}/g, String(n)).replace("{{size}}", "1.2").replace("{{name}}", "x"));
          }
        }
      } finally {
        restore();
      }
    });
  }

  it("examples: contacts", async () => {
    const { t, restore } = await translator(true);
    try {
      expect(t("contacts.count", 0)).toBe("لا توجد جهات اتصال");
      expect(t("contacts.count", 1)).toBe("جهة اتصال واحدة");
      expect(t("contacts.count", 2)).toBe("جهتا اتصال");
      expect(t("contacts.count", 5)).toBe("5 جهات اتصال");
      expect(t("contacts.count", 12)).toBe("12 جهة اتصال");
      expect(t("contacts.count", 100)).toBe("100 جهة اتصال");
    } finally {
      restore();
    }
  });
});

describe("English is unchanged", () => {
  it("one / other, with the engine's rules and with the app's", async () => {
    for (const without of [false, true]) {
      const saved = Intl.PluralRules;
      if (without) {
        (Intl as unknown as { PluralRules?: unknown }).PluralRules = undefined;
        ensurePluralRules();
      }
      try {
        const instance = i18next.createInstance();
        await instance.init({ resources: { en: { translation: en } }, lng: "en", fallbackLng: "en", interpolation: { escapeValue: false } });
        expect(instance.t("contacts.count", { count: 1 })).toBe("1 contact");
        expect(instance.t("contacts.count", { count: 0 })).toBe("0 contacts");
        expect(instance.t("contacts.count", { count: 2 })).toBe("2 contacts");
        expect(instance.t("sync.queuedItems", { count: 21 })).toBe("21 items queued");
      } finally {
        (Intl as unknown as { PluralRules: unknown }).PluralRules = saved;
      }
    }
  });
});
