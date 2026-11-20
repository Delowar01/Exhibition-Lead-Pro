# Phase 2 · Batch 1 — Android reliability and mobile UX

Development only. Nothing here is merged, built, deployed or device-verified.
Branch `claude/phase2-android-reliability`, from the Phase 1 integrated commit
`cd08c733ee0d1bd329eea59e96707fae42723b83`.

No API route, API contract, database schema, billing or subscription behaviour
changed. One shared client file changed (`lib/api-client-react/src/custom-fetch.ts`,
§3). Everything else is inside `artifacts/mobile`.

## 1. Offline scanning

### What was wrong

| Risk | Cause in the code |
| --- | --- |
| The queue vanished during a long session | Every queued scan kept its photo, as base64 text, inside ONE AsyncStorage value. Android's AsyncStorage cannot read a value back beyond about 2 MB and has a small total budget. After a few scans the read failed, the app treated that as "empty queue", and the next save replaced everything |
| "Saved" although it was not | Storage errors were swallowed; the capture screen reported success in every case |
| A capture made right after launch wiped the queue | Saving was possible before the stored queue had been loaded |
| Tapping the bin removed a pending capture at once | No confirmation |
| A second card reading and a second contact after an interruption | A queued scan is two requests (card reading, then contact). Nothing was remembered between them |
| The same refused photo uploaded again at every reconnect | Every failed item was retried automatically, whatever the reason |
| One expired session marked every item "Failed" | A 401 was handled like any other error, item by item |
| A contact that already exists stayed "Failed" for ever | The API answers 409 and creates nothing; the app had no way to resolve it and showed the raw `HTTP 409 …` text |
| Wrong-account risk inside one item | The account was checked before an item, not before its second request |
| A sign-in page of a public Wi-Fi counted as success | Any 2xx answer was accepted, also one that is not the API's |
| Items waited until the user opened the Sync Center | Sync ran only on reconnect; nothing tried again while the app stayed open and online |
| One stalled connection stopped all syncing until the app was restarted | Requests had no time limit |

### What it does now

- **Photos are files.** One file per scan in the app's private document
  directory, one sub-directory per account (`<userId>_<companyId>`). The
  AsyncStorage index holds the file's name, a few hundred bytes per scan
  (`lib/scan-files.ts`, `lib/scan-file-driver.ts`).
- **A write is all or nothing.** Temporary file → size check → rename. Less than
  25 MB free, a short write or an I/O error is refused with a reason.
- **A save reports the truth.** `enqueueScan / enqueueContact / enqueueCard`
  resolve only after the device stored the capture; otherwise the user is told
  why (not signed in, storage full, storage error, unusable photo) and the
  capture is not shown as kept.
- **Nothing stored is overwritten while it cannot be read.** An unreadable index
  disables writing for the session. No write happens before the stored queue is
  loaded.
- **A damaged index is recovered, kept and reported** (§5b-A). The entries that
  can still be read come back exactly as they were stored; the damaged original
  is kept untouched under a key of its own before anything replaces it; the
  user is told at once and in the Sync Center; photos whose entry was lost are
  put back but not sent until the user decides.
- **Upgrade keeps existing work.** The previous queue (`csp_offline_queue`) is
  taken over: its items move to the new index (`csp_offline_queue_v2`) with
  their owners unchanged and their photos move into files. The old value is
  removed only after the STORED new index was read back and found to hold every
  one of its items (§5b-C). If it cannot be read — in whole or in part — it is
  left where it is and the Sync Center says so. A take-over interrupted after
  any single step is completed by the next start.
- **A scan resumes instead of repeating.** The scan id returned by the first
  request is stored on the item before the second request. After an
  interruption the app asks the API whether that scan already has its contact
  (`GET /scans/{id}` → `contactId`) and creates the contact only if not. The
  contact is linked to its scan (`scanId`), so contacts synced from offline
  scans now carry their card image. The same question is asked for a reviewed
  card that was kept after its save request failed. For this, rapid capture and
  batch review now name the scan in their own (online) contact request too —
  the server links the two, and those contacts carry their card image as well.
- **A lost answer is not answered by sending again blindly.** Where a scan
  stands behind the item, the scan is asked. Where none does (a typed, QR or NFC
  contact), the repeat goes through the server's duplicate detection again: a
  decision the user had already given ("create separately", "add to this
  contact") is asked a second time instead of being sent twice, and a match is
  shown as "may be this very capture — open it to check".
- **Nothing is sent that the device cannot record.** If the queue cannot be
  stored (storage full), the sync pauses before the next request and says so;
  a photo is deleted only after its entry's removal is stored; the list of
  finished captures is stored even when the index cannot be.
- **Failures are classified** (`lib/offline-sync.ts`):

  | Situation | Result |
  | --- | --- |
  | No connection, expired session, rate limit | The run stops. Items keep waiting; nothing is marked failed |
  | AI unavailable, not configured, off, over budget, platform limit | Scans wait (one request, not one per photo). Contacts and card edits still sync |
  | The contact already exists (409) | The item becomes "Already exists" with View contact / Add to this contact / Create separately |
  | No readable card, refused image, plan limit, no permission | Failed; retried only when the user taps Retry |
  | Server-side hiccup | Failed; retried automatically after 30 s, 1, 2, 5, then 15 minutes |
  | An answer that is not the API's | Not a success. The item stays |
  | The request is refused for a reason other than the photo (its event no longer exists) | Failed with that explanation, not "capture the card again" |
  | The device cannot store the progress | The run pauses; nothing further is sent |

- **Waiting work is tried again by itself.** A run that leaves work behind is
  followed by another after 30 s, then 1, 2, 5 and every 15 minutes while the
  app is open and online; an upload starts the sequence over. After "too many
  requests" no automatic run starts before the delay has passed; while AI is
  unavailable, scans are left out of automatic runs for the delay (one question
  to the server per delay, not one per trigger). "Sync now" ignores both, and
  also tries again what was refused for an account-wide reason (plan limit, no
  permission). A plan-limit refusal is asked once per run, not once per item.
- **Every sync request has a time limit** (3 minutes for a card photo, 1 minute
  otherwise). A stalled connection counts as "no answer" and no longer blocks
  the queue.

- **Accounts.** Items remain stamped with their owner; another account never
  sees or sends them. The account is now re-checked immediately before every
  request, including the second request of a scan. A photo is read only from
  its owner's directory. A capture that is kept only after its request failed
  is stored for the account that MADE it (read before the request was sent) —
  never for whoever signed in while the request was under way.
- **Nothing is deleted automatically.** An item leaves the queue after a
  confirmed upload or the user's own, confirmed, removal.
- **Lost entries come back.** A photo of the signed-in account that the index no
  longer lists is restored as a waiting scan of that account. This happens only
  when the index was read: while it cannot be read, nothing is adopted and
  nothing is synced (the list is unknown, not empty).
- **Captures are kept when sending fails for a reason that is not the photo's
  fault** (connection lost, session ended, AI unavailable): single and rapid
  camera capture, batch review, scan review and manual entry keep the capture
  on the device instead of dropping it. Batch review asks before closing with
  unsaved cards.
- **Sync also runs when the app returns to the foreground**, and connectivity is
  re-probed then.

### Storage keys and files (reviewed in `lib/persistence-inventory.test.ts`)

| Where | Content |
| --- | --- |
| `csp_offline_queue_v2` | queue index; every item carries its owner |
| `csp_offline_queue` | previous queue; read once, never written |
| `csp_offline_queue_migrated`, `csp_offline_done` | take-over note; ids already uploaded or removed |
| `csp_offline_queue_damaged`, `…_damaged_2`, `…_damaged_3` | the original of an index that could not be read as it was; each incident under a key of its own; removed only by the user |
| `csp_offline_queue_incident` | record of such damage: when, how many entries read back / unreadable, where the originals are |
| `csp_refresh` (secure store) | refresh token of the current session |
| `<documents>/offline-scans/<userId>_<companyId>/<id>.jpg` | one photo per queued scan |

### Rolling back to an older APK

An older build reads only `csp_offline_queue`, which the new build has emptied.
Captures queued by the new build are not lost — they stay on the device — but an
older build does not show or sync them. Sync the queue before downgrading, or
install the new build again.

## 2. Arabic and right-to-left

| Finding | Correction |
| --- | --- |
| **Double mirroring.** The app mirrors its layout itself, from the language chosen in the app. React Native also mirrors natively when the phone's SYSTEM language is right-to-left (the build's manifest allowed it and nothing switched it off). On an Arabic-language phone the Arabic interface came out left-to-right again and the English interface came out mirrored | Native mirroring is off: a config plugin sets `android:supportsRtl="false"` (first launch onward) and start-up code stores the same choice in React Native's preferences (`plugins/withNativeLtr.js`, `lib/layout-direction.ts`). Verified in the resolved Expo config; **not** on a device |
| **Arabic plurals fell back to English.** 18 of 19 plural families had only two of Arabic's six forms. With a standards-conforming engine, "3 contacts" and "11 items queued" appeared in English inside the Arabic interface | All 22 families now carry the six Arabic forms. Plural selection is guaranteed for Arabic and English on any engine (`lib/i18n/plural-rules.ts`) |
| Back arrows and "more" chevrons pointed the wrong way in Arabic on about 25 screens | A `directional` icon prop mirrors them in a right-to-left language |
| Shared buttons, badges, list rows and inputs were left-to-right only | They follow the language |
| The contact page (overview, timeline, assignment, manage rows) was left-to-right only | Rows, labels and values follow the language |
| Camera, QR, NFC, batch review: overlays and banners left-to-right only; long messages ran off both screen edges; the mode label showed the raw internal name in English | Mirrored; messages wrap inside the screen; the label is translated |
| Hard-coded English ("Downloading…"); raw source names in the Sync Center | Translated |

Not changed in this batch — listed in `lib/rtl-audit.test.ts`: event screens,
event picker, pipeline form, the AI insight / copilot / workflow sections, the
date picker, the app-lock overlay and PIN pad, contact edit. They still lay out
rows left-to-right in Arabic.

## 3. Session and sign-in

The API already issues a refresh token at sign-in and rotates it at
`POST /auth/refresh`; the web portal uses it. The mobile app ignored it, so
after the access token's lifetime every request failed with 401 while the app
still looked signed in.

- The app stores the refresh token (secure store) and renews the session once
  when a request is rejected with 401; the request is retried. Concurrent
  rejections share one renewal, because a refresh token is single-use and the
  API revokes the session if an old one is presented again.
- A rejected request is retried only under the session it was sent with. For
  this the shared API client now tells the 401 handler which token was rejected
  and retries with exactly the token the handler returns. The web portal's
  handler ignores the new argument; its behaviour is unchanged.
- Only a definite refusal of the renewal by the API itself (its own 401 / 403
  answer) ends the session. No connection, a timeout, a server error or a
  refusal produced by something in between (a proxy, a public Wi-Fi sign-in
  page) leave the user signed in.
- A 401 that is about a typed password — change password, switch MFA off, new
  backup codes — is not about the session: it neither renews nor ends it, and
  the screen shows "incorrect password".
- When the session has ended the user is taken to sign-in and told why. Captures
  on the device stay and sync after the same account signs in again. A capture
  that was being sent at that moment is still kept for its account.
- The remembered biometric sign-in holds the refresh token too, follows the
  session when it is renewed, points at the new session after a password
  sign-in of the same account, and is forgotten when its session ends. When
  the organization is merely blocked (the server did not revoke the session)
  it is kept. A profile edit no longer rewrites the stored tokens.
- Sign-in says "too many attempts" for a lockout instead of "sign-in failed".
- The session lifetime itself is unchanged and decided by the server (30 days,
  90 with "remember me" at MFA sign-in). Renewal does not extend it.

## 4. AI error messages

One classification (`lib/api-failure.ts`) serves camera capture, batch scanning,
scan review / reprocess / replace / re-score, the Assistant and the sync:

| Server answer | User is told |
| --- | --- |
| `AI_PROVIDER_UNAVAILABLE` (provider and fallback failed), `AI_PLATFORM_LIMIT_REACHED` | AI is temporarily unavailable; manual, QR and NFC capture still work |
| `AI_NOT_CONFIGURED` | Not set up for this environment; contact the administrator |
| `AI_BUDGET_EXCEEDED` | The organization's monthly AI budget is used up |
| `AI_DISABLED` | AI features are off for the organization |
| `AI_RATE_LIMITED`, 429 | Too many at once; wait a moment |
| `SCAN_NO_CARD`, too large, HEIC, 400 | The specific image problem |
| 401 | Session ended; sign in again |
| 403 / `FEATURE_NOT_ENTITLED` | No permission / not in the plan (was shown as "session expired") |
| No answer | No connection |

A provider outage and a reached platform limit deliberately read the same to a
customer. No provider name, model, key, request id or raw provider text reaches
a message: the sentences are fixed, and the API's own sentence is passed on only
for a refused or unreadable image. Batch review now shows the specific reason of
a failed background reading. The Assistant offers Retry only where it can help.

## 5. Tests

| Suite | Result |
| --- | --- |
| Mobile unit suite (`pnpm --filter @workspace/mobile run test`) | 525 passed (35 files); 333 before |
| Mobile typecheck | 0 errors |
| Whole-workspace typecheck | exit 0 |
| Mobile ↔ local API compatibility (`test:api-compat`, opt-in, stub AI, synthetic accounts) | 17 passed |

New suites: `scan-files`, `offline-sync`, `offline-queue-storage`,
`auth-session`, `api-failure`, `i18n/plural-rules`, `layout-direction`,
`rtl-audit`, `review-corrections`. Four existing assertions were changed on
purpose: the new `conflicts` count; 403 no longer reported as "session
expired"; 401 no longer reported as "no permission"; two source-wiring checks
for the new call shapes.

## 5a. Independent review — findings and corrections

One independent review of the complete change found no blocker, five major and
six minor findings. Each correction has a regression test in
`lib/review-corrections.test.ts` (the review's own probes asserted the faulty
behaviour; five of its six now fail, and the sixth is superseded by the URL
rule below).

| # | Finding | Correction |
| --- | --- | --- |
| 1 | A wrong current password (401 on change password, MFA off, backup codes) renewed the session — or, for a session without a refresh token, signed the user out | The API client tells the 401 handler where the request went; these three requests touch neither the session nor the remembered sign-in |
| 2 | "Create separately" / "Add to this contact" was sent again after a lost answer: a second contact or interaction | The decision is dropped when its attempt ends without an answer (item without a scan); the repeat is checked by the server again |
| 3 | A reviewed card kept after a failed save, and a rapid capture kept after its contact request failed, were not checked against their scan | The sync asks the scan first for every item that names one; rapid and batch name the scan in their own request; an item left "being sent" by a closed app counts as "answer lost" |
| 4 | "Probably saved by an earlier attempt — remove this entry" was shown for contacts that had existed all along | That doubt is recorded only where no scan can answer it; the sentence no longer tells the user to remove anything |
| 5 | A capture kept after a slow failed request was stored for whoever was signed in by then | It is stored for the account that made it |
| 6 | With an unreadable index the app adopted every photo as a new scan, uploaded them and deleted the files | No adoption and no sync while the index is unreadable |
| 7 | The sync went on sending when the device could not store its progress | It pauses; photos are deleted only after the removal is stored; finished ids are stored independently |
| 8 | Nothing scheduled the documented retries; "Retry" during a running sync was dropped; N taps for N items after a plan limit | Retry timer with the documented delays; a retry asked during a run starts after it; "Sync now" retries account-wide refusals |
| 9 | A profile edit could discard a renewal answer or delete the stored refresh token; any 403 on renewal ended the session | Separate session counter; the profile edit writes the user only; only the API's own refusal counts |
| 10 | "Remove it and capture the card again" for a refusal that was not about the photo | Own wording for a refused request |
| 11 | Removing an item while it is being sent; double tap on Save queued twice; temporary files of an interrupted write never removed; a stalled request blocked the queue; one account's sync notice shown to the next | Remove is not offered while sending; one save at a time; stale temporary files are cleaned; request time limits; the notice is cleared at an account change |

Not changed, by decision: a lost connection stops the run for all items (no
request could succeed); a refused account-wide item is still marked one item
per run; a photo left behind after more than 400 later captures finished could
be restored as a new scan (needs a failed file deletion as well). Each run
during an AI outage still leaves one failed scan record on the server per
question asked — now one per delay instead of one per trigger.

Reasoned from the code, not reproduced on a device: finding 5's timing and
finding 6's trigger. The timer and the two React providers are covered by
their pure rules and by source checks, not by running the providers.

## 5b. Final hardening (targeted correctness and data-preservation pass)

Each point was first reproduced on the previous head of this branch (or ruled
out), then corrected, then covered by `lib/hardening.test.ts` (49 tests) and,
for the shared API client, `artifacts/web-app/src/lib/api-client-session.test.ts`
(17 tests).

### A. A damaged queue index

Confirmed on the previous head:

| Reproduced | What happened |
| --- | --- |
| Index cut short (a scan the server had already read, a contact, a card edit) | The app started with an empty, writable queue. All three entries were gone from the app; the next save overwrote the index. A copy was kept but nothing told the user |
| A second, different damage | It overwrote the kept copy of the first |
| A valid list containing entries that are not queue items | They were dropped without any copy or report |
| Photos of entries lost with the list | Put back as new scans and uploaded by themselves — without the event, the position or the fact that the card had already been read |

Now:

- **What can be read is read.** A value that is not valid JSON is searched for
  the complete entries it still contains, also after a broken one. Each comes
  back exactly as stored (owner, event, position, progress, the user's
  decision). Nothing is repaired or guessed; an incomplete entry is counted.
- **The original is kept first.** Byte for byte, under a key of its own, read
  back and compared, before a readable index replaces the damaged one. A later
  incident uses the next key (three in all); the same original is never stored
  twice. If it cannot be kept — no space, or all three places hold earlier
  originals — nothing is written at all for that session and the damaged index
  stays where it is.
- **It is said.** An alert at once, and a report in the Sync Center: entries
  read back, entries that could not be read, that the original is kept. The
  report stays until the user removes the kept copy (a confirmed action; the
  only way an original ever leaves the device).
- **Nothing unknown is sent.** A photo from before the damage whose entry was
  lost is listed under "needs attention" and is not sent by an automatic run or
  by "Sync now" — only by the user's own Retry on it. The time of the damage is
  kept for good, so this also holds for an account that signs in weeks later.
  A photo newer than the damage only missed its entry (the app stopped while
  saving) and is an ordinary waiting scan, as before.
- **Entries without a photo.** A recovered scan whose photo is gone is shown as
  "photo no longer on this device" and is not retried by itself; one the server
  had already read needs no photo and resumes at the contact.

Limitation, stated to the user: an entry that cannot be read (a typed contact
or a card edit inside the damaged part) cannot be restored by the app; it
exists only in the kept original.

### B. Hard deadlines

Confirmed: `withTimeout` asked the request to stop and then waited for it. A
request that ignores the signal never returned, and the sync stood still (ten
minutes simulated for a one-second limit).

Now the deadline does not depend on the request: at the limit the request is
asked to stop AND the caller is released with a "no answer" error. A late
answer reaches nobody: the sync attempt it belonged to is closed (it can
neither send its next request nor record progress), and the API client does
not repeat a request whose caller has given up — also when its 401 arrives
late. The session renewal has the same hard limit (30 s); if its answer still
arrives later it is taken into use only for the same session and only while
that session's tokens are unchanged.

Ruled out: duplicate processing after a late answer (the scan check and the
duplicate detection already cover "answer lost"); a late answer acting under
another account (the run is bound to its account, and the client retries only
with a token the handler returns for that request).

### C. The take-over of the earlier queue

Evidence, from the installed storage library's own source: on Android a
multi-key write is one database transaction (both implementations); on iOS and
in the web preview it is not.

Confirmed (where a multi-key write is not atomic): the completion flag could be
stored without the new index; the next start then deleted the old queue, and
its items were nowhere.

Now no step writes several keys together. The order is: new index, read back
and checked → completion note → old queue removed. The old queue goes only when
the stored index (or the list of finished items) accounts for every one of its
items; the note alone never authorises it. Stopped after each single storage
change in turn, the old queue is never gone before the new index holds it, and
the next start completes the take-over without duplicates. The ordinary save
writes the list of finished items before the index, each on its own, so the
index never gets ahead of it.

Ruled out: the reverse interruption (index stored, note missing) — it repeated
safely before and still does.

### D. The shared API client (also used by the web portal)

The same scenarios were run against the client before this PR and now, with a
replica of the portal's handler: single and concurrent 401s, refused refresh,
repeat rejected again, no refresh token, sign-in endpoint, sign-out during a
refresh, another account signing in during a refresh, a stale request, failed
token storage, both kinds of 403.

Confirmed and corrected:

| Found | Correction |
| --- | --- |
| Two requests rejected at once with different tokens started two refreshes at the same moment; the second presented a refresh token that had just been replaced, and the API revoked the session | Handler runs are queued: never two at once |
| A request with its own Authorization header was repeated with the session's token instead of its own | The repeat keeps the caller's header, as before |

Ruled out: every scenario the portal can reach today behaves as before (the
portal sends no request with a header of its own). Remaining differences to the
earlier client, all outside what the portal does: a handler that throws leaves
the caller with the request's 401 instead of the handler's error; two
differently-tokened rejections get two refreshes one after the other instead of
one shared; a cancelled request is not repeated when its 401 arrives late.

## 6. Open — backend dependencies

Reported, not changed:

1. **Idempotency key on `POST /scans` and `POST /contacts`.** Without it two
   cases remain: (a) a scan request cut off after the server stored the scan but
   before the app received its id is repeated and leaves one extra scan record
   without a contact; (b) a queued contact without a scan (manual, QR, NFC) whose
   answer was lost is caught on repeat by the server's duplicate detection and
   shown as "already exists — may be this very capture", but a contact too
   sparse for that detection (a name only) can be created twice. The server's
   detection asks the user from a score of 88; name and company alone score 75.
2. **No grace window on refresh-token rotation.** If the answer to a renewal is
   lost, the next renewal presents the replaced token and the server revokes the
   session; the user signs in again. This is the server's theft protection
   working as designed.
3. **Reprocess / replace / re-score errors are English-only on the server.** The
   app shows its own localized wording instead.
4. **A failed card reading leaves a scan record on the server each time.** The
   error answer names that record; cleaning such records up, or accepting the
   same photo again without a new record, is a server decision.
5. **`401` for a wrong password.** The app recognises the three requests that
   answer 401 for a typed password by their address. A distinct status or error
   code from the API would make that independent of the address.

## 7. Open — needs a physical device

Not verified on a device in this batch. See `DEVICE_TEST_CHECKLIST.md`,
"Phase 2 · Batch 1".
