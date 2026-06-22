/**
 * i18n engine for the mobile app.
 *
 * Architecture goals (per spec):
 *  - External translation resources (JSON), NOT hardcoded strings.
 *  - Adding a future language = drop a new locale JSON + register it here.
 *    No component or call-site changes required.
 *  - English is always the default + fallback.
 *
 * RTL is handled in JS (see hooks/useLocale.ts) so switching language applies
 * instantly without a native reload or logout.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import ar from "./locales/ar.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES = ["en", "ar"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Languages that render right-to-left. */
const RTL_LANGUAGES: readonly string[] = ["ar"];

export function isRTLLanguage(lang: string | null | undefined): boolean {
  return !!lang && RTL_LANGUAGES.includes(lang);
}

/**
 * Resource registry. To add a language later, import its JSON above and add one
 * line here — nothing else in the app needs to change.
 */
export const resources = {
  en: { translation: en },
  ar: { translation: ar },
} as const;

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: "en",
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    defaultNS: "translation",
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
  });
}

export default i18n;
