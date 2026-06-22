---
name: Mobile i18n + RTL + OCR language
description: How the Expo mobile app does bilingual EN/AR i18n, JS-driven RTL, GCC country localization, and capture-time OCR language — and the non-obvious rules that keep it correct.
---

# Mobile i18n / RTL / OCR localization

Mobile-only (artifacts/mobile, + api-server OCR rules). Web-app is intentionally untouched.

## Locale file parity is load-bearing
- `lib/i18n/locales/en.json` and `ar.json` must stay key-for-key identical. Add keys to BOTH via a deep-merge-no-overwrite script (never hand-edit one side), then assert `EN diff AR == []`.
- **Why:** a missing AR key silently renders the raw key string to Arabic users; parity is the only cheap guard.

## RTL is JS-driven, not native
- Direction comes from `useLocale()` (`isRTL`/`dir`/`textAlign`/`row()` helpers) fed by SettingsContext, so switching language re-renders instantly with NO logout/reload. Do not reach for React Native's native `I18nManager.forceRTL` (it needs an app restart).

## Status/type badges use defaultValue fallback
- Pattern: `t("statuses." + x, { defaultValue: prettyLabel(x) })` (and `t("tasks.types." + x, ...)`, `t("leads.stages." + x, ...)`). Lets new backend enum values degrade to a humanized label instead of showing a raw key.

## OCR `original` must never store a translation
- In `api-server/src/lib/ai.ts`, the `original` object is verbatim card text. Translatable fields (firstName/lastName/jobTitle/company/address) must NOT fall back to the translated `display` value when the model omits them — leave them null. Only never-translated fields (email/mobile/website/linkedin, arabicName) may fall back to display.
- **Why:** falling back to `display` silently records translated text as if it were the printed original, corrupting the "as-printed" guarantee.

## Offline scans translate by CAPTURE-time language, not sync-time
- `QueueItem.appLanguage` is stamped at enqueue (capture) from `useSettings().language` and passed to `createScan` on sync (`item.appLanguage ?? current-i18n fallback` for legacy items).
- **Why:** a user can capture offline in EN then switch to AR before reconnecting; without the stamp the OCR would translate to the wrong language on sync.
- **Gotcha:** in `capture-camera.tsx` the current language is `useSettings().language` (already in scope, correctly typed as the union), NOT `useLocale().language` (typed `string`) — destructuring the latter shadows it and widens the type, breaking `appLanguage` assignment.
