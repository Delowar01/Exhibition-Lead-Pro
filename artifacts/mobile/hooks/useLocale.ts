/**
 * useLocale — single hook for all localization needs in a component.
 *
 * Combines:
 *  - i18next translation (`t`) — reactive to language changes.
 *  - The active language + RTL direction.
 *  - The active GCC country profile + country-aware example/placeholder helpers.
 *  - RTL-aware style helpers so layouts mirror instantly without a reload.
 */

import { useMemo } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";

import { useSettings } from "@/contexts/SettingsContext";
import {
  addressExample,
  cityExample,
  countryName,
  getCountry,
  phoneExample,
  validatePhone,
  type CountryProfile,
  type PhoneValidationResult,
} from "@/lib/countries";
import { isRTLLanguage } from "@/lib/i18n";

export interface Locale {
  t: ReturnType<typeof useTranslation>["t"];
  language: string;
  isRTL: boolean;
  dir: "rtl" | "ltr";
  /** Active country profile. */
  country: CountryProfile;
  /** Localized country display name. */
  countryName: string;
  /** Country-aware, language-aware placeholders/examples. */
  phonePlaceholder: string;
  cityPlaceholder: string;
  addressPlaceholder: string;
  validatePhone: (raw: string) => PhoneValidationResult;
  // ── Style helpers (RTL-aware) ───────────────────────────────────────────────
  /** flexDirection that mirrors in RTL. */
  rowDirection: "row" | "row-reverse";
  /** textAlign that mirrors in RTL. */
  textAlign: "left" | "right";
  /** writingDirection for inputs/text. */
  writingDirection: "ltr" | "rtl";
  /** Build a row style that mirrors in RTL. */
  row: (base?: ViewStyle) => ViewStyle;
  /** Build a text style that aligns + writes in the right direction. */
  text: (base?: TextStyle) => TextStyle;
  /** Mirror transform for directional icons (chevrons, arrows). */
  mirror: ViewStyle;
}

export function useLocale(): Locale {
  const { t, i18n } = useTranslation();
  const { language, country } = useSettings();
  const lang = i18n.language || language || "en";
  const isRTL = isRTLLanguage(lang);
  const profile = getCountry(country);

  return useMemo(() => {
    const rowDirection: "row" | "row-reverse" = isRTL ? "row-reverse" : "row";
    const textAlign: "left" | "right" = isRTL ? "right" : "left";
    const writingDirection: "ltr" | "rtl" = isRTL ? "rtl" : "ltr";
    return {
      t,
      language: lang,
      isRTL,
      dir: isRTL ? "rtl" : "ltr",
      country: profile,
      countryName: countryName(profile.code, lang),
      phonePlaceholder: phoneExample(profile.code),
      cityPlaceholder: cityExample(profile.code, lang),
      addressPlaceholder: addressExample(profile.code, lang),
      validatePhone: (raw: string) => validatePhone(raw, profile.code),
      rowDirection,
      textAlign,
      writingDirection,
      row: (base: ViewStyle = {}) => ({ ...base, flexDirection: rowDirection }),
      text: (base: TextStyle = {}) => ({ ...base, textAlign, writingDirection }),
      mirror: isRTL ? { transform: [{ scaleX: -1 }] } : {},
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, lang, isRTL, profile.code]);
}
