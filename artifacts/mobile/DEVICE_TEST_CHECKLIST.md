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
| Staging API | https://contact-aggregator--DelowarHossain1.replit.app (retired Replit backend — historical record of this build only; new builds target https://admin.kaptnow.com per eas.json) |
| Build timestamp | 2026-08-05 (fix round 1, EAS build 61f65ee3, finished 13:03 UTC) |
| Build page | https://expo.dev/accounts/elite-marcom/projects/mobile/builds/61f65ee3-8e36-46a7-86fa-f94f7d5d0c64 |
| Direct APK download | https://expo.dev/artifacts/eas/o3Uust0Rq5HloMuZI6_Jo2tD6D4G_kT1SJAL4uuQT0Q.apk |

Previous build (superseded): a68f6101 —
https://expo.dev/artifacts/eas/CAfYgxfmTcmj348yWqSwwN67wrcqKDLFI-CUH67jtQU.apk

## 0. Fix round 1 — retest these first (from your device findings)

| # | Finding → fix | Result | Notes |
| --- | --- | --- | --- |
| A | Bottom nav shows Home / Scan / Contacts / Notifications / More (Pipeline moved out; still reachable from Home quick actions). All labels fully visible — no "…" — on your device width | | |
| B | Contact Workspace shows exactly 3 tabs: Overview, Timeline, Documents (evenly divided, no scrolling tab strip). Timeline includes interactions + status history | | |
| C | Workspace tabs look correct in AR/RTL (order mirrored, labels fit) and in dark mode | | |
| D | Capture: saved scan image is cropped to the card guide frame (not the full camera view), single AND batch modes | | |
| E | A normal, well-lit card capture does NOT show a low-quality warning; a genuinely blurry/dark capture still does | | |
| F | AI Assistant (More → AI Assistant): sending a message returns a real answer. NOTE: requires the app to be REPUBLISHED first — the production database is missing the AI tables, which is the root cause of "The AI could not generate a response" | | |

Post-build APK content scan (done on the built APK): no Gemini/API keys,
no SESSION_SECRET, no database or SMTP strings, no Expo token — only the
public staging URL is baked in. ✔

## 0b. Fix round 2 — retest these (no new APK built yet; owner builds after review)

| # | Change → what to verify | Result | Notes |
| --- | --- | --- | --- |
| G | Bottom nav is now Home / Scan / Contacts / Follow-Ups / More (Notifications replaced by Follow-Ups). All 5 labels fully visible on your device width, EN and AR | | |
| H | Notifications now lives in More → Workspace group with an unread-count badge; opening it shows the full Notification Center and deep links still work | | |
| I | Home header shows a notification bell (right in EN, left in AR) with unread badge; tapping opens a small panel with the latest 3 notifications; tapping an item marks it read + deep-links; "View all notifications" opens the full Center; panel fits on-screen at your device width | | |
| J | More → CRM group shows Pipeline again and it opens the pipeline list | | |
| K | Contact Workspace: Call / WhatsApp / Email / Website bar shows 4 equal buttons, none clipped at the right edge (EN + AR, light + dark); buttons with missing data (no mobile/email/website) look disabled and do nothing | | |
| L | The quick-action bar stays pinned below the header while scrolling Overview, Timeline AND Documents | | |
| M | Documents tab: category chips wrap onto multiple lines with full labels (no "Signed Agreemen…" clipping); title and Upload button aligned on one row; long file names truncate cleanly; empty state is compact | | |
| N | No page-level horizontal scrolling anywhere in the Contact Workspace, including with the keyboard open | | |

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

---

# Phase 2 · Batch 1 — reliability checks (NOT yet run on a device)

These behaviours were implemented and tested with the unit suite and against a
local API only. They need a real Android device and a fresh APK built from the
branch (the manifest change of row R1 exists only in a new native build). Use
synthetic test cards and test accounts only.

## A. Arabic and layout direction

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| R1 | Phone SYSTEM language Arabic, app language Arabic: rows run right-to-left, text is right-aligned, nothing is mirrored twice | | |
| R2 | Phone SYSTEM language Arabic, app language English: the interface is NOT mirrored | | |
| R3 | Phone SYSTEM language English, app language Arabic: same picture as R1 | | |
| R4 | Switching the app language applies at once, without restart, in all three combinations | | |
| R5 | Back arrows point right and "more" chevrons point left in Arabic (home, contacts, contact page, settings, events, sync, camera Done) | | |
| R6 | Arabic counts: 0, 1, 2, 5, 12 and 100 contacts / queued items / unread notifications read as Arabic, never as English | | |
| R7 | Contact page in Arabic: details, lead section, status options, assignment list, manage rows mirrored; no clipped text | | |
| R8 | Camera in Arabic: close button, banners and Done mirrored; a long error message wraps inside the screen | | |
| R9 | Typing Arabic and English into the contact form: cursor, alignment and mixed text behave | | |
| R10 | Native elements with the manifest change: system alerts, permission dialogs, date/time pickers, keyboard — usable in both languages | | |

## B. Offline scanning

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| O1 | Upgrade from the previous APK with scans already queued: all still listed under the right account, and they sync | | |
| O2 | Airplane mode, rapid capture of 60+ cards: every one listed; force-stop and reopen: all still there | | |
| O3 | Storage nearly full (under 25 MB free): capture shows "not saved — storage almost full"; nothing is listed as kept | | |
| O4 | Sync 20 queued scans and switch airplane mode on/off repeatedly: each card ends as one contact; no duplicate contact | | |
| O5 | Force-stop the app in the middle of a sync, reopen: sync continues; no duplicate contact | | |
| O6 | Queue a scan of a card whose contact already exists: "Already exists" with the three choices; each choice does what it says | | |
| O7 | Sign in as another account with scans pending: they are not shown and not sent; sign back in: they are there | | |
| O8 | Remove a queued capture: confirmation first; cancel keeps it | | |
| O9 | Online but with a dead connection (router without internet): a capture is kept for later with an explanation, not lost | | |
| O10 | Batch mode, close review with unsaved cards: confirmation first | | |
| O11 | Background the app for 10+ minutes with items queued, return: sync runs without opening the Sync Center | | |
| O12 | Photo size and time per capture are not noticeably worse than before | | |
| O13 | AI unavailable while online: the capture is kept; with the app left open it is tried again by itself (first after about 30 s, then at growing intervals) | | |
| O14 | Rapid capture on a slow connection, then sign out and sign in as another account before it finishes: nothing of the first account appears under the second; after signing back in, the first account has it | | |
| O15 | Fill the storage during a sync: the Sync Center says syncing is paused; after freeing space and "Sync now", every card ends as one contact | | |
| O16 | Rapid and batch captures made online: each contact shows its card image, and its history shows the scan | | |
| O17 | Very slow or stalled connection during sync (network throttling): the sync does not hang; items wait and continue later | | |
| O18 | "Create separately" for an "Already exists" item, switching airplane mode on right after the tap: exactly one new contact results; the item asks again instead of creating a second one | | |
| O19 | An item being sent has no remove button; double tap on Save (manual entry, scan review) while offline queues one entry | | |

## C. Session

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| S1 | Leave the app unused past the access-token lifetime (or use a test server with a short one): reopening works without signing in | | |
| S2 | End the session from the web portal (terminate session / change password): the app returns to sign-in with the "session has ended" notice; queued captures remain | | |
| S3 | Sign in again as the same account after S2: queued captures sync | | |
| S4 | Biometric sign-in after a session renewal: still works | | |
| S5 | Biometric sign-in after S2: no longer offered; after a password sign-in and re-enabling it, it works | | |
| S6 | Lose the connection for a minute while using the app: nobody is signed out | | |
| S7 | Wrong password several times: "too many attempts" message | | |
| S8 | Settings → change password with a WRONG current password: "incorrect password" is shown, the user stays signed in, biometric sign-in still works afterwards | | |
| S9 | Change the profile photo, then keep using the app past the access-token lifetime: still signed in | | |

## D. AI messages (needs a test tenant an operator can configure)

| # | Check | Result | Notes |
| --- | --- | --- | --- |
| A1 | AI not configured: camera, batch review, scan review reprocess and the Assistant each say so, in EN and AR | | |
| A2 | AI budget exhausted: the budget message everywhere; a queued scan waits instead of failing | | |
| A3 | Provider unavailable / platform limit: "temporarily unavailable; manual, QR and NFC still work" | | |
| A4 | Photo without a card: "no readable card", and the Sync Center does not upload it again by itself | | |
| A5 | No message shows a provider name, a model name, a status code or raw error text | | |
