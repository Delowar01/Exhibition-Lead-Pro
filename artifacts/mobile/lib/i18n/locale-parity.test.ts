import { describe, expect, it } from "vitest";

import ar from "./locales/ar.json";
import en from "./locales/en.json";

// Stage 5.9 Phase 5 requires EN / AR parity for every user-facing string (the
// mobile app ships both languages with RTL). Parity was previously verified by
// hand after each batch; this guard makes it a regression check:
//   • every key exists in both bundles (plural forms are compared by family);
//   • non-plural strings interpolate exactly the same placeholders;
//   • a plural form never introduces a placeholder the English form lacks
//     (Arabic "_one" forms legitimately omit {{count}} — "one lead" is a word);
//   • every plural family carries at least "_one" and "_other" in both bundles;
//   • no leaf is empty or non-string (i18next would render the key instead).

type Tree = { [key: string]: string | Tree };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(tree: Tree, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      for (const [k, v] of flatten(value as Tree, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim()).sort();
}

function baseKey(key: string): string {
  return key.replace(PLURAL_SUFFIX, "");
}

function pluralFamilies(keys: Iterable<string>): Map<string, Set<string>> {
  const families = new Map<string, Set<string>>();
  for (const key of keys) {
    const match = key.match(PLURAL_SUFFIX);
    if (!match) continue;
    const base = baseKey(key);
    if (!families.has(base)) families.set(base, new Set());
    families.get(base)!.add(match[1]);
  }
  return families;
}

const EN = flatten(en as Tree);
const AR = flatten(ar as Tree);

describe("locale parity (EN ↔ AR)", () => {
  it("both bundles contain only non-empty string leaves", () => {
    for (const [bundle, map] of [["en", EN], ["ar", AR]] as const) {
      const bad = [...map.entries()]
        .filter(([, v]) => typeof v !== "string" || v.trim() === "")
        .map(([k]) => `${bundle}:${k}`);
      expect(bad).toEqual([]);
    }
  });

  it("every key exists in both languages (plural forms compared by family)", () => {
    const enBases = new Set([...EN.keys()].map(baseKey));
    const arBases = new Set([...AR.keys()].map(baseKey));
    expect([...enBases].filter((k) => !arBases.has(k))).toEqual([]);
    expect([...arBases].filter((k) => !enBases.has(k))).toEqual([]);
  });

  it("non-plural strings interpolate exactly the same placeholders", () => {
    const mismatches: string[] = [];
    for (const [key, value] of EN) {
      if (PLURAL_SUFFIX.test(key) || !AR.has(key)) continue;
      const a = placeholders(String(AR.get(key)));
      const e = placeholders(String(value));
      if (a.join(",") !== e.join(",")) mismatches.push(`${key}: en={${e}} ar={${a}}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("plural forms never introduce a placeholder the English form lacks", () => {
    const violations: string[] = [];
    for (const [key, value] of AR) {
      if (!PLURAL_SUFFIX.test(key)) continue;
      const english = EN.get(key) ?? EN.get(`${baseKey(key)}_other`);
      if (typeof english !== "string") continue;
      const allowed = new Set(placeholders(english));
      const extra = placeholders(String(value)).filter((p) => !allowed.has(p));
      if (extra.length) violations.push(`${key}: {${extra}}`);
    }
    expect(violations).toEqual([]);
  });

  it("every plural family carries _one and _other in both languages", () => {
    const enFamilies = pluralFamilies(EN.keys());
    const arFamilies = pluralFamilies(AR.keys());
    const incomplete: string[] = [];
    for (const [base, forms] of enFamilies) {
      const arForms = arFamilies.get(base);
      if (!forms.has("one") || !forms.has("other")) incomplete.push(`en:${base}`);
      if (!arForms || !arForms.has("one") || !arForms.has("other")) incomplete.push(`ar:${base}`);
    }
    for (const base of arFamilies.keys()) {
      if (!enFamilies.has(base)) incomplete.push(`en-missing:${base}`);
    }
    expect(incomplete).toEqual([]);
  });
});
