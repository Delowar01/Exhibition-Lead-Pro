# Android Release Readiness — R1 / R2 build (Batch 38, static validation only)

**Status of record (2026-10-30):** APK NOT BUILT · EAS CLOUD BUILD NOT TRIGGERED ·
NO SIGNING CREDENTIAL RETRIEVED OR UPLOADED · NOTHING PUBLISHED OR DISTRIBUTED ·
**PHYSICAL TEST PENDING** (no device was available to this batch; the last recorded
device pass remains Batch 8 on the Honor Magic V5, Android 16).

This report is the pre-build readiness record for the mobile client at the deployed
product head (`develop` `6a8dad1`, server + web deployed 2026-10-23) plus the Batch 37 /
Batch 38 mobile hardening on the review branch `claude/lead-capture-pro-onboarding-dlwfd4`.
Everything below was established by reading configuration and by local static /
unit validation. Nothing here is a claim of hosted, provider or device verification.

---

## 1. Configuration inspected (facts, not changes)

| Item | Value found | Readiness note |
|---|---|---|
| App name / slug / version (`artifacts/mobile/app.json`) | `Card Scanner Pro Mobile` / `mobile` / `1.0.0` | `appVersionSource` is `remote` (`eas.json`), so the Android `versionCode` is allocated by EAS at build time; none is pinned locally |
| Android application id | `com.elitemarcom.cardscannerpro` | fixed; a release keystore must match the id that is already published, if any |
| Expo SDK / runtime | SDK 54 (`expo ~54.0.27`, `react-native 0.81.5`, `expo-router ~6.0.17`), Hermes, New Architecture enabled, portrait only | evaluated with `expo config --type public` offline (exit 0) — the config resolves without network |
| EAS project binding | `extra.eas.projectId` present, `owner` present (`elite-marcom`) | the build runs in that Expo account; account access is an owner-held credential (never in the repository) |
| Native modules (config plugins, 13) | expo-router, expo-font (Inter), expo-web-browser, expo-file-system, expo-camera, expo-secure-store, expo-contacts, expo-local-authentication, expo-location, expo-image-picker, expo-notifications, react-native-nfc-manager (NDEF entitlement), expo-splash-screen | all native → **Expo Go cannot run this app**; a development-client or preview APK is required (`PRODUCTION_RELEASE_CHECKLIST.md`) |
| Android permissions (12) | storage read/write, INTERNET, CAMERA, RECORD_AUDIO, READ/WRITE_CONTACTS, USE_BIOMETRIC / USE_FINGERPRINT, ACCESS_COARSE/FINE_LOCATION, NFC | each maps to a shipped capture / contact / lock feature; RECORD_AUDIO is requested by the camera plugin — confirm on device that no audio prompt appears outside the camera |
| Build profiles (`artifacts/mobile/eas.json`) | `development` (dev client, internal, APK) · `preview` (internal, APK, `EXPO_PUBLIC_API_URL=https://admin.kaptnow.com`) · `production` (autoIncrement, same API URL, default AAB) | the acceptance APK is the `preview` profile; `development` is for debugging only; `production` produces a store bundle, not the APK under test |
| API origin baked into the binary | `EXPO_PUBLIC_API_URL` from the profile env (public, non-secret) | the APK talks to the deployed server + web origin of the same head; a wrong value is only detectable on device (login fails) |
| Package manager on the EAS builder | `eas-build-pre-install` installs pnpm `10.26.1` (the workspace pin) | matches `packageManager`; no change needed |
| Secrets in the client | none required (Gemini runs server-side; the no-bundled-secret guard test is part of the mobile suite) | the APK must never carry a provider key; see `GEMINI_PRODUCTION_CONFIG_RUNBOOK.md` |

## 2. Safe local static validation performed (Batch 38)

| Gate | Result |
|---|---|
| `expo config --type public` (offline, `EXPO_OFFLINE=1`) | exit 0; name / slug / package / plugins / projectId / owner resolve as in §1 |
| Mobile typecheck (`pnpm --filter @workspace/mobile run typecheck`) | PASS |
| Mobile unit tests (`pnpm --filter @workspace/mobile run test`, vitest, node environment) | 298 passed / 0 failed (24 files; includes the Batch 38 `query-state` and `batch-store` session tests) |
| Workspace typecheck (`pnpm run typecheck`) | PASS |
| EAS cloud build | **NOT TRIGGERED** (prohibited in this batch) |
| Credential inspection (`eas credentials`) | **NOT RUN** (would require account access; nothing retrieved) |

## 3. APK build-readiness checklist (to be executed by the owner / operator, not by automation)

| # | Item | State |
|---|---|---|
| B-1 | Source head to build = the exact reviewed commit (deployed `6a8dad1` + the accepted Batch 37 / 38 mobile commits once merged); record the SHA in the build notes | PENDING (owner picks the head after the review of the feature branch) |
| B-2 | Server + web of the same head deployed and healthy (criterion 2 of `MASTER_ROADMAP.md` §6) | MET for `6a8dad1` (run 39979375833); PENDING for any later head |
| B-3 | `EXPO_PUBLIC_API_URL` in the chosen profile points at the deployed origin | present in `preview` / `production`; VERIFY on device at first login |
| B-4 | Expo account access (`elite-marcom`) for the person running `eas build` | OWNER ACTION (credential never in the repo or automation) |
| B-5 | Android signing: EAS-managed keystore in the Expo project **or** a local `credentials.json` + keystore kept by the owner — decide once; a changed keystore breaks upgrades of an already-installed app | OWNER DECISION — nothing retrieved, created or uploaded in this batch |
| B-6 | Profile: `preview` for the acceptance APK (internal distribution) | READY (config present) |
| B-7 | Build command (operator, interactive, outside automation): `eas build --platform android --profile preview` from `artifacts/mobile` | NOT RUN |
| B-8 | Install path: the EAS internal-distribution link or the downloaded `.apk` side-loaded on the test devices; **no store submission** | NOT RUN |
| B-9 | Gemini production credential configured server-side before any OCR acceptance case is marked PASS | OWNER ACTION (`GEMINI_PRODUCTION_CONFIG_RUNBOOK.md`); until then the app must show the `AI_NOT_CONFIGURED` notice (case R1-1 below) |
| B-10 | Physical acceptance matrix (§4) executed and recorded; every FAIL triages to a fix batch before a release claim | PHYSICAL TEST PENDING |

## 4. Physical acceptance matrix

Devices: **D-1** Honor Magic V5 (foldable, Android 16 — the last recorded pass device)
and **D-2** one ordinary candy-bar Android phone (Android 13 or newer, 6.1"–6.7").
Every case in §5 is run in the cells marked ●.

| Dimension | D-1 folded | D-1 unfolded | D-2 |
|---|---|---|---|
| EN · light | ● | ● | ● |
| EN · dark | ● | — | ● |
| AR (RTL) · light | ● | ● | ● |
| AR (RTL) · dark | ● | — | — |
| Online → offline → online (airplane-mode toggle) | ● | — | ● |
| Fold / unfold while a screen is open (layout re-flow, no crash, no lost input) | ● | ● | — |

Record per cell: build SHA, profile, device, OS build, result PASS / FAIL, screenshot id.

## 5. Executable manual acceptance cases

Preconditions for all cases: preview APK of the recorded SHA installed; a demo tenant
with at least one event, a few contacts / leads and one notification; the tester has
an `admin` or `employee` account **and** the platform-owner account; the server of the
same head is reachable. "Error state" below means the localized error card with the
Retry action; "loading" means the skeleton / spinner.

### 5.1 MOBILE-R1 — production AI readiness

| ID | Steps | Expected |
|---|---|---|
| R1-1 | With Gemini **not** configured on the server, open Scan → camera mode | the pre-scan readiness notice explains that AI scanning is not configured; the shutter remains usable; QR, NFC and manual modes are offered |
| R1-2 | Take a card photo in that state | the localized `AI_NOT_CONFIGURED` scan error, no crash, no contact created; manual entry offered |
| R1-3 | With Gemini configured (after B-9), scan a real card | fields extracted into the review form; nothing saved until the tester taps Save |
| R1-4 | Scan a QR / vCard, an NFC tag (D-1 or D-2 with NFC on), and use manual entry | each produces a review form; NFC prompts for the tag; no mode is missing |

### 5.2 MOBILE-R2 — "No Event" capture and later assignment

| ID | Steps | Expected |
|---|---|---|
| R2-1 | Scan with **no** event selected | the first-scan warning appears once; capture proceeds; the contact shows no event |
| R2-2 | From a contact, assign an event later | event set; timeline shows the assignment |
| R2-3 | Select several no-event contacts → bulk assign an event | all selected contacts updated; a contact of another tenant can never appear in the picker |
| R2-4 | Capture while offline (airplane mode), then go online | the queued capture syncs; no duplicate contact; the queue empties |
| R2-5 | Switch account (log out / log in as another user of the same tenant) | no queued item of the first user is replayed under the second; lists refresh for the new user |

### 5.3 Batch 37 / 38 error-state and retry behaviour

| ID | Screen | Steps | Expected (Batch 37 state) | Expected (Batch 38 transition rule) |
|---|---|---|---|---|
| E-1 | Home | Open Home with the server unreachable (airplane mode after login) | the metrics grid shows the error state, **not** zeros; the last-event card shows an error state, not an empty card | tap Retry while still offline → the grid shows **loading**, then the error again (never a stale error card during the retry); go online → Retry → metrics render |
| E-2 | Home | Make only the pipeline query fail (block the pipeline endpoint with a debugging proxy) | the whole grid shows the error state (pipeline / won / lost are never displayed as 0) | Retry re-fetches **both** dashboard and pipeline queries |
| E-3 | Notifications (More → Notifications or the Home bell) | Open with the server unreachable | the error state with Retry, **not** "no notifications" | Retry → loading skeleton → error or list; with the server reachable and zero notifications → the empty state (never the error state) |
| E-4 | Lead edit (Pipeline → lead → Edit) | Open an existing lead's edit form with the server unreachable | the error state with Retry; **no form is rendered**, so Save cannot write blank values | Retry → loading → error or the populated form; the Save button is never reachable before the lead has loaded |
| E-5 | Any of the above | Pull-to-refresh / background refresh fails **after** data was shown | the last-known data stays on screen (no blanking) | unchanged |

### 5.4 Batch OCR pending indicator and session safety

| ID | Steps | Expected |
|---|---|---|
| O-1 | Scan → batch mode → take 3 photos quickly | the pending-OCR counter increments per shot (1, 2, 3) |
| O-2 | Wait for the results | the counter decrements on **every** completion, success or failure, back to 0; each card shows done or error |
| O-3 | Take 2 photos, then exit batch mode before the OCR finishes; re-enter batch mode | the new session starts at 0 pending; the late results of the ended session **never** appear in the new session (no ghost cards, counter never goes negative) |
| O-4 | Force one failure (cover the lens / scan a blank sheet) | the item shows the error state, the counter still decrements, the other items are unaffected |

### 5.5 Export permission parity

| ID | Steps | Expected |
|---|---|---|
| X-1 | Log in as the platform-owner account on the device | no export action is offered anywhere on Contacts / Reports |
| X-2 | Log in as an employee **without** the reports-view permission | export action hidden; a deep-linked export attempt is refused by the server |
| X-3 | Log in as an admin with reports-view | export runs; the file opens / shares |

### 5.6 Localization and layout

| ID | Steps | Expected |
|---|---|---|
| L-1 | Switch the app to Arabic | every Batch 37 / 38 string (error cards, Retry, pending counter, readiness notice) is Arabic; no English fallback text; counters keep their value |
| L-2 | In Arabic, open Home, Notifications, Scan (batch), Lead edit | RTL mirroring of icons / chevrons / progress; no clipped text; the pending counter placeholder renders the number correctly |
| L-3 | Switch back to English | strings return; no layout residue |
| L-4 | D-1: open each screen folded, unfold, fold again | re-flow without crash, inputs preserved, bottom tabs (Home, Scan, Contacts, Follow-Ups, More) stay reachable |
| L-5 | Dark mode on every screen of §5.3 / §5.4 | error / loading / empty states remain legible |

### 5.7 Offline / online recovery

| ID | Steps | Expected |
|---|---|---|
| N-1 | Start online, open Home and Contacts, go offline, navigate, come back online | cached lists remain readable offline; on reconnection the refetch succeeds without a manual app restart |
| N-2 | Trigger E-1 offline, come online, tap Retry | one successful refetch; the error state is replaced by data |

## 6. Coverage limitation (what automation could and could not prove)

The mobile test runner is vitest in the node environment over `lib/**/*.test.ts` only;
no screen is rendered by any automated test, and no device or emulator exists in the
development sandbox. Batch 38 therefore moved the decision logic of the three screens
into pure modules and tested those:

| Automated (vitest, part of the mobile suite) | Manual only (§5) |
|---|---|
| `lib/query-state.test.ts` — loading / error / ready resolution incl. retry-in-flight → loading, failed refresh keeps data, Notifications empty vs error, lead-form fetch failure, combined states (loading wins, error wins over ready) | the rendered error / loading / empty cards, Retry taps, pull-to-refresh |
| `lib/batch-store.test.ts` — pending count increments per shot and decrements on done **and** error; session token; late completion of an ended session ignored; re-entry starts at zero; token-less callers keep the original contract | the on-screen counter, camera shutter timing, visual ghost cards |
| `lib/export-permissions.test.ts` — platform-owner refusal, reports-view gate | the hidden export button, deep-link refusal |
| `lib/locale-parity.test.ts` — EN / AR key parity | RTL layout, text clipping, fold re-flow |

A PASS of the automated set is **not** a PASS of §5; the roadmap keeps
`PHYSICAL TEST PENDING` until §4 / §5 are executed on real devices and recorded.

## 7. What this batch explicitly did not do

- did not run `eas build`, `eas submit`, `eas credentials` or any EAS cloud operation;
- did not create, download, upload or inspect a keystore or any signing material;
- did not publish, distribute or side-load an APK;
- did not configure Gemini or any provider credential;
- did not claim hosted or device verification from local tests.
