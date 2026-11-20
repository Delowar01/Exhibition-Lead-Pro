# Android APK readiness — Phase 1 integrated head (2026-11-20)

Point-in-time report. It supersedes the Batch 38 readiness report for the integrated
Phase 1 application (Batches 37–43, Platform Owner Analytics, pricing corrections,
Claude + Gemini provider management). **No build was triggered, no device was used and
no hosted system was contacted for this report.** Everything below was read from the
repository at `9ba7ebb6b8a80afb892bee88cc411584aa8ca9e7`; the mobile unit suite was run
locally (26 files, 333 passed, 0 failed) and the mobile typecheck exits 0.

`artifacts/mobile/app.json`, `eas.json` and `package.json` are byte-identical to the
deployed baseline (`develop`, `6a8dad1`). The stack changes 28 other mobile files.

## 1. Verdict

The repository can produce an installable APK through the existing `preview` profile.
No configuration change is needed and none was made. Three things outside the repository
must be true first; each is an owner or operator action:

1. The server the APK talks to must already run the integrated application (§4).
2. The operator must hold access to the Expo project and reuse its existing keystore (§3).
3. The owner must confirm which public host serves the hosted stack (§4).

## 2. Configuration as it stands

| Item | Value | Where |
| --- | --- | --- |
| Android application ID | `com.elitemarcom.cardscannerpro` | `artifacts/mobile/app.json` |
| App name / slug / version | `Card Scanner Pro Mobile` / `mobile` / `1.0.0` | `app.json` |
| Version code | held by EAS (`appVersionSource: remote`) | `eas.json` |
| Expo SDK / React Native / Router | 54 / 0.81.5 / 6 | `package.json` |
| New architecture, engine | enabled, Hermes | `app.json` |
| Over-the-air updates | none (`expo-updates` is not installed) | `package.json` |
| EAS CLI | `>= 12.0.0` required; `^20.3.0` pinned in the workspace | `eas.json`, `package.json` |

| EAS profile | Output | Distribution | API URL baked in |
| --- | --- | --- | --- |
| `development` | APK, development client | internal | none (loads from Metro) |
| **`preview`** | **APK** | **internal** | `https://admin.kaptnow.com` |
| `production` | AAB (store default), auto-increment | store | `https://admin.kaptnow.com` |

Credentials: no profile sets `credentialsSource`, so all use EAS-managed (remote)
credentials. No keystore, `credentials.json` or `google-services.json` is tracked.

## 3. Build command and signing prerequisites (not run)

From a **clean checkout of the exact commit that is deployed on the server**:

```bash
cd artifacts/mobile
pnpm exec eas whoami                                   # an account with access to the project owner
pnpm exec eas build --platform android --profile preview
```

Before the build:

- Expo access to the project owner named in `app.json`, by interactive `eas login` or an
  `EXPO_TOKEN` in the operator's own shell. The token is never committed and never stored
  as a repository secret for this step.
- **Reuse the existing EAS-managed Android keystore.** Inspect it with `eas credentials`
  first. A newly generated keystore produces an APK that cannot update an earlier
  install: testers must uninstall first, and app data on the device is lost.
- Check the project's EAS environment variables (`pnpm exec eas env:list preview`) for a
  stale `EXPO_PUBLIC_API_URL` or `EXPO_PUBLIC_DOMAIN`; a hosted value can override `eas.json`.
- The workspace pins EAS CLI 20.3.0, which satisfies the `>= 12.0.0` the project requires.
- No build-time secret is required. The only variable is `EXPO_PUBLIC_API_URL`, supplied
  by the profile. The bundled-secrets test allows no key in the mobile bundle.

Record with the build: the commit SHA, the EAS build ID, the version code EAS assigned
and the SHA-256 of the downloaded APK.

Not recommended: a local `expo prebuild` + Gradle release build. It signs with the
template debug keystore, and `babel-preset-expo` does not resolve from the mobile
directory in this workspace layout without the package manager's shim.

## 4. Backend the APK talks to

- The base URL is resolved once at start from `EXPO_PUBLIC_API_URL`
  (`artifacts/mobile/lib/api-url.ts`); there is no runtime override and no other host in
  the app source. Cleartext HTTP is not enabled; a test enforces `https:` for the
  `preview` and `production` profiles and pins both to `https://admin.kaptnow.com`.
- **The code and the hosting documents disagree about the public host, and the code is
  authoritative.** `artifacts/api-server/src/lib/portal-host.ts` — already part of the
  deployed baseline — defines `admin.kaptnow.com` as the customer portal (tenant roles),
  `elite.kaptnow.com` as the Platform Owner portal, and `dev.kaptnow.com` as retired: every
  login on it is refused. `CLAUDE.md` and `docs/HOSTINGER_VPS_DEPLOYMENT.md` still name
  `dev.kaptnow.com`. An APK pointed at the retired host could not sign in. **Owner
  confirmation required:** `https://admin.kaptnow.com` is served by the hosted stack.
- A Platform Owner account is refused on the customer host by design. Device tests use
  tenant accounts of a designated test tenant, never a customer's credentials.
- The mobile code at this commit expects the integrated API (entitlements in the sign-in
  response, the new AI outage codes). **Build only after the final deployment wave is
  verified, from that same commit.**

## 5. Features and native dependencies

| Area | Implementation | Android permissions |
| --- | --- | --- |
| Camera capture | `expo-camera`; the photo is resized and sent to the server | CAMERA |
| OCR | **server-side** through the Enterprise AI Layer (Claude or Gemini by platform policy); only image-quality scoring runs on the device | — |
| QR / LinkedIn QR | decoded on the device by `expo-camera` | CAMERA |
| NFC | `react-native-nfc-manager` with its config plugin; needs a development or release build (not Expo Go); `nfc` feature not required by the manifest | NFC |
| Biometric quick sign-in, app lock | `expo-local-authentication`, `expo-secure-store` | USE_BIOMETRIC, USE_FINGERPRINT |
| Offline queue | AsyncStorage, one key, scoped per user and company | — |
| Documents, avatar | `expo-image-picker`, `expo-file-system`, `expo-media-library` | storage / media |
| Contacts export, location stamp, reminders | `expo-contacts`, `expo-location`, `expo-notifications` | contacts, location, notifications |

Nothing a shipped feature needs is missing from the declared permissions. Some declared
or plugin-added permissions exceed what the code uses (RECORD_AUDIO, video and audio
media, SYSTEM_ALERT_WINDOW): acceptable for an internal APK, to be trimmed before a store
submission.

## 6. Messages for the two AI providers

- `AI_PROVIDER_UNAVAILABLE` and `AI_PLATFORM_LIMIT_REACHED` map to one localized message
  (`capture.errAiUnavailable`) in English and Arabic; it says manual, QR and NFC capture
  still work. `AI_NOT_CONFIGURED`, budget and rate-limit codes keep their existing
  messages. Covered by `lib/scan-error.test.ts`.
- Locale keys: every English key exists in Arabic (1425 against 1429; the four extra are
  Arabic plural forms).
- The AI Assistant shows its generic "could not send" message for these codes.

## 7. Risks to cover in the device pass

None blocks producing the APK. They are ordered by how likely a tester is to meet them.

1. **Offline scans are stored as inline images in one AsyncStorage key.** A long offline
   session (roughly a dozen card photos or more) may exceed Android's storage limits for
   that key; write errors are swallowed. Keep offline scan sessions short until measured.
2. **Arabic as the phone's system language.** The app mirrors its layout in JavaScript
   and the manifest also declares RTL support, so a system-Arabic phone may mirror twice.
3. **Arabic plurals** for counts such as 2, 5 and 15 may fall back to English wording,
   depending on the device runtime.
4. **Remote push** has no FCM configuration and is expected not to work; local reminders
   are unaffected.
5. **Session expiry.** There is no token refresh and no global 401 handling; biometric
   sign-in can restore an expired session, which then fails every request.
6. **Queued items that the server refuses as duplicates** stay failed, with Retry and
   Remove as the only actions; there is no retry backoff.
7. **Unfolded foldable.** Target SDK 36 ignores the portrait lock on wide displays.
8. Remaining English-only strings (NFC errors, biometric prompts, reminder titles, the
   crash screen); NFC tag contents are written to the device log in release builds.

Two existing behaviours need an owner ruling, not a fix in this batch; both are already
in the deployed baseline:

- Rapid capture and offline scan sync create a contact directly from the OCR result,
  while the standing rule is review and explicit save before a contact exists.
- The lead detail's Intelligence tab and the company detail show workflow
  recommendations, while Workflow Intelligence is excluded from mobile scope.

## 8. Physical-device acceptance checklist

Preconditions: final deployment wave verified; the APK built from the deployed commit;
a designated test tenant with an administrator and an employee account; a second test
tenant on a plan without NFC and documents; at least one AI provider configured on the
server for the OCR cases; a physical NFC tag; a QR vCard and a LinkedIn QR code.
Record device model, Android version, APK SHA-256 and server commit.

| # | Case | Expected |
| --- | --- | --- |
| I-1 | Install over the previous APK, or clean install | Installs; the launcher opens the sign-in screen |
| A-1 | Sign in as tenant administrator and as employee | Home loads; role-appropriate menus |
| A-2 | Sign in with a Platform Owner account | Refused with the "contact your administrator" message |
| A-3 | Repeated wrong passwords | A too-many-attempts message; no crash; sign-in works again after the lockout |
| A-4 | Enable biometric quick sign-in, sign out, sign in with biometrics | Session restored for the same account |
| A-5 | Sign in as a different account | The remembered biometric account is cleared; no data of the first account is visible |
| P-1 | Deny, then grant, camera permission | Rationale screen; Open Settings works; capture resumes |
| P-2 | Location, notifications, contacts, media prompts | Each asked at first use; refusal does not block capture |
| C-1 | Camera capture of a printed card, server AI configured | Fields extracted; review screen; contact saved only after Save |
| C-2 | Same with the primary provider disabled by the Platform Owner | Served by the other provider; same result |
| C-3 | Capture when no provider can serve | The outage message; manual, QR and NFC still offered |
| C-4 | Tenant AI budget exhausted (test tenant) | The budget message, not the outage message |
| C-5 | QR vCard and LinkedIn QR | Contact draft from the code; no AI call |
| C-6 | NFC tag on the entitled tenant | Contact draft; saved with NFC as source |
| C-7 | NFC on the tenant whose plan has no NFC | Refused with the feature message; nothing saved |
| C-8 | Email-signature paste and manual entry | Contact saved |
| C-9 | Rapid capture of three cards | Three contacts; counters correct (see §7 ruling) |
| O-1 | Airplane mode: two manual contacts and two scans, then reconnect | Queue shows four; all sync once; no duplicates |
| O-2 | Queue items for account A, sign out, sign in as B | B sees none of A's items and sends none; A's reappear for A |
| O-3 | Force-stop the app with queued items, reopen | Items still queued and sync |
| O-4 | Eight offline scans in one session, restart, reconnect | All eight survive and sync |
| W-1 | Contact workspace | Overview, Timeline, Documents only; Call / WhatsApp / Email / Website actions; no AI panel |
| W-2 | Documents on the tenant whose plan has no documents | Feature-unavailable screen |
| E-1 | Platform Owner changes the test tenant's plan; bring the app to the foreground | Entitlements refresh without signing out |
| S-1 | AI Assistant on an entitled tenant; on a tenant without it | Answers; hidden or refused |
| N-1 | Bottom tabs and More menu | Home, Scan, Contacts, Follow-Ups, More; no administration, AI Command Center, Workflow or Executive Intelligence screens |
| L-1 | Switch the app language to Arabic and back | Live switch; layout mirrored once; the new outage message in Arabic |
| L-2 | Phone system language Arabic, app Arabic and app English | No double mirroring in either |
| L-3 | Arabic lists with 2, 5 and 15 items | Arabic plural wording |
| T-1 | Light and dark theme | Readable in both |
| F-1 | Unfolded foldable, landscape | Camera frame and lists usable |
| X-1 | Leave the app signed in past the session lifetime | A clear route back to sign-in (record the behaviour) |

Last recorded device pass before this report: Honor Magic V5, Android 16 (Batch 8).
Nothing in this report is a device verification.
