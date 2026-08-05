# Batch 8 — Physical Android Device Test Checklist

Fill this in while testing the preview APK on a real Android device. Batch 8
cannot be marked complete until every row has a result (Pass / Fail / N-A with
a note). Use safe test-card data only — never real customer data.

## Device record (required)

| Field | Value |
| --- | --- |
| Device manufacturer & model | |
| Android version | |
| APK version / build number | (from the build record below) |
| Network used (Wi-Fi / mobile data) | |
| Date of verification | |
| Tester | |

## Build record (filled at build time)

| Field | Value |
| --- | --- |
| App version | 1.0.0 |
| Build number (versionCode) | 1 |
| Package name | com.elitemarcom.cardscannerpro |
| Build profile | preview (internal distribution, APK) — Expo SDK 54 |
| Staging API | https://contact-aggregator--DelowarHossain1.replit.app |
| Build timestamp | 2026-08-05 ~01:10 UTC (EAS build a68f6101) |
| Git commit | e22f304 |
| Build page | https://expo.dev/accounts/elite-marcom/projects/mobile/builds/a68f6101-9aec-4239-b9fc-8dcf9a328c1a |
| Direct APK download | https://expo.dev/artifacts/eas/CAfYgxfmTcmj348yWqSwwN67wrcqKDLFI-CUH67jtQU.apk |

Post-build APK content scan (done on the built APK): no Gemini/API keys,
no SESSION_SECRET, no database or SMTP strings, no Expo token — only the
public staging URL is baked in. ✔

## 1. Install & core flows

| # | Flow | Result | Notes |
| --- | --- | --- | --- |
| 1 | APK installs without developer tooling and the app launches | | |
| 2 | Login with a staging test account | | |
| 3 | MFA login when the account requires it (code challenge, wrong code rejected, correct code passes) | | |
| 4 | Camera permission is requested with the explanatory message | | |
| 5 | Deny camera → clear guidance shown; grant later in Settings → capture works | | |
| 6 | Clear business-card capture (single card) | | |
| 7 | OCR processing completes and shows extracted fields | | |
| 8 | Review screen: extracted fields can be edited | | |
| 9 | Explicit Save creates exactly ONE contact | | |
| 10 | Cancel / back from review creates NO contact | | |
| 11 | Duplicate card → duplicate-found flow (no silent auto-merge) | | |
| 12 | Batch capture with at least 2 cards | | |
| 13 | Force one batch item to fail (e.g. airplane mode mid-item) → Retry OCR retries ONLY that item | | |
| 14 | Manual capture (form validation, save) | | |
| 15 | QR capture (vCard and MECARD if available) | | |
| 16 | NFC capture — real tag if the device supports NFC; otherwise confirm the unsupported-device message and note "NFC unverified on this hardware" | | |
| 17 | Event selection → captured lead is associated with the event | | |
| 18 | Scan history lists past scans; scan image loads (authenticated) | | |
| 19 | Airplane mode during capture → honest error; retry succeeds after reconnect | | |
| 20 | Background the app mid-flow (e.g. on review) → resume returns to a usable state | | |
| 21 | Logout → app returns to login; reopening does not restore the session; API calls are rejected | | |

## 2. Real OCR from the device (staging Gemini)

Scan each card type with the device camera against staging:

| Card | Extracted correctly? | Editable? | Saved only on confirm? | Notes |
| --- | --- | --- | --- | --- |
| Clear English card | | | | |
| Arabic or bilingual card | | | | |
| Rotated / angled card | | | | |
| Difficult / low-light card | | | | |

Also confirm: a failed scan shows a readable error and Retry works.

## 3. Responsiveness & UX (same device)

| Check | EN / LTR | AR / RTL | Notes |
| --- | --- | --- | --- |
| No horizontal overflow, no clipped buttons/inputs | | | |
| Keyboard does not block required fields/actions | | | |
| Safe-area handling (notch / gesture bar) | | | |
| Loading indicators + disabled states during submission | | | |
| Light theme readable | | | |
| Dark theme readable | | | |
| Camera + review usable in portrait | | | |

## 4. HEIC note (already verified server-side)

The camera and gallery paths convert to JPEG on-device, so the app never
uploads HEIC. If you share a HEIC file into the app from another source and it
reaches the server, the server rejects it with:
"This HEIC image cannot be processed. Please use or convert it to JPEG."
(shown localized in EN/AR). No action needed unless you see a different error.
