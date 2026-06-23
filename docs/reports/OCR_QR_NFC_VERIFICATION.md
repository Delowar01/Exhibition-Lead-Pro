# Pre-Build Verification — OCR, QR, NFC & Contact Extraction

_Date: 2026-06-22 · Scope: `artifacts/mobile` capture pipeline + `artifacts/api-server` OCR._

> **Method:** The on-device parser logic (QR/NFC/vCard) was exercised with the
> **vitest unit suite** (real payloads, including iOS grouped vCards). The camera,
> Gemini OCR, and NFC radio paths were **code-audited end to end** — they require a
> physical device and cannot run in this environment (the Expo web preview is blank
> for native modules). Each issue below lists its root cause, fix, and verification.

---

## 1. Root cause of every issue found

| # | Reported problem | Root cause | Severity |
|---|---|---|---|
| 1 | **QR does not extract correct contact info** | `parseVCard` derived the property key with `rawKey.split(";")[0]`, which keeps Apple/iOS **group prefixes** (`item1.URL`, `item2.EMAIL`, `item3.ADR`). Those keys never matched the `switch`, so **website, email, and address were silently dropped** from any vCard shared by an iPhone (the most common "share my contact" QR/NFC source). | **High** |
| 2 | Name fields sometimes wrong | `FN` (free-form display name) and structured `N` both wrote the name, last-writer-wins by line order. A titled/multi-word `FN` (e.g. `Dr. John Smith`) could overwrite the correct `N` split. | Medium |
| 3 | **Scanning sometimes returns only "Failed"** | The capture catch block surfaced a single generic `capture.captureFailed` regardless of cause (network down, 413 too-large, 502 OCR failure, auth expiry). The server already returns specific localized errors, but they were discarded. | Medium |
| 4 | OCR quality not observable | No developer logging in the camera → OCR → save path (only `lib/nfc.ts` was instrumented), so field failures were invisible during debugging. | Medium |

No defect was found in the **camera capture options** (`quality 0.5`, `base64`, JPEG), the **15 MB** body limit, the **30 s** OCR timeout, the **502 + localized message** failure path, or the **NFC NDEF** record handling (text/URI/MIME → shared parser). The Gemini extraction prompt and EN/AR translation rules are sound and preserve verbatim `original` text.

## 2. Files modified

- `artifacts/mobile/lib/contact-parse.ts` — `parseVCard`: strip group prefix before keying; make `N` authoritative over `FN`.
- `artifacts/mobile/app/capture-camera.tsx` — `captureErrorMessage()` status-aware error mapper; `__DEV__`-gated `scanLog()` diagnostics across capture/single/rapid + catch blocks.
- `artifacts/mobile/lib/i18n/locales/en.json` & `ar.json` — six specific capture-error strings.
- `artifacts/mobile/lib/contact-parse.test.ts` — 3 new cases (grouped properties, N-over-FN, FN fallback).

## 3. What was fixed

- **QR/NFC vCard parsing (Phase 3/4):** grouped iOS properties now resolve, so website/email/address are extracted; names use the reliable structured field.
- **Error handling (Phase 7):** "Failed" is replaced by specific, localized messages — network error, image too large, "couldn't read the card, retake with better lighting" (server message preferred), invalid image, session expired, server error.
- **Diagnostics (Phase 8):** dev-only `[Scan]` logs record image captured (+bytes), OCR started/completed (+confidence), contact saved, and failures (+HTTP status) — production builds are unaffected.

**Verification:** parser suite **17/17 pass**; `pnpm --filter @workspace/mobile run typecheck` **clean**; Expo Android **bundle exports successfully**; independent architect review **PASS, no regressions**.

## 4. Remaining limitations

- **Native flows unverified on-device (release-blocking gate):** camera focus/exposure/flash/orientation, live QR detection, and the NFC radio (NDEF + unsupported tags) must be validated on a dev-client/EAS build per the original Phase 1/3/6/9 checklist. They are correct by code audit but not field-tested.
- **vCard line-folding (RFC 2426)** continuation lines and **QUOTED-PRINTABLE** value encoding (some legacy address-book exports) are not decoded. Low real-world frequency; recommend a follow-up parser test.
- **Multiple phone numbers:** only the primary `TEL` is kept (single `mobile` field by schema design).
- **`arabicName` storage:** the extracted Arabic-script name is shown in the contact's notes (there is no dedicated `arabicName` column). Visible and editable, but not a structured field — changing it would require a DB/schema migration (out of scope for this verification).
- **Rapid mode** counts per-card failures but does not show the mapped error copy per item (product decision, non-blocking).

## 5. Production readiness assessment

| Capability | Code/Logic | On-device | Verdict |
|---|---|---|---|
| **OCR** (capture → Gemini → fields) | ✅ sound; specific errors; dev logging | ⚠️ needs device sign-off (lighting/blur/quality) | **Ready for Beta** |
| **QR** (vCard / MECARD / text / URL / email) | ✅ fixed + unit-tested incl. iOS grouped vCards | ⚠️ needs live-camera scan sign-off | **Ready** (pending device check) |
| **NFC** (NDEF text/URI/MIME → shared parser) | ✅ sound; instrumented; graceful unsupported-tag handling | ⚠️ radio untestable here | **Ready for Beta** |

### Release gate

The reported defects are fixed and verified at the logic level — there is **no remaining release-blocking issue in code**. The one outstanding gate is **on-device verification** of camera/QR/NFC on a real build (Phase 10). Run that sign-off, then the new APK is clear to build. If on-device OCR accuracy or NFC reads fail there, treat those as new blockers.
