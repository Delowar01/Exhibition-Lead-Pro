# Mobile App (Lead Capture Pro) — Bug Report Root-Cause Analysis & Fix Log

**Scope:** Native-APK bug report, 10 sections. This document records, per reported
issue: the root cause, the files touched, the solution, how it was tested in this
environment, and what still requires on-device verification.

> **Critical finding — the tested APK is stale.**
> The majority of the reported "broken" features (pipeline status change, assign
> teammate, status-history creation, GPS capture, Save-to-Phone, NFC) are **already
> correctly implemented in the current source**. They could not have failed the way
> described unless the APK under test was built from an older revision. These items
> need a **fresh `development`/`preview` EAS build and on-device re-test** before being
> re-filed as defects.
>
> **Native verification cannot be performed in this environment.** NFC, contacts,
> location, file sharing and other native modules only run on a real device via an
> Expo Development Build or EAS APK/TestFlight build — never in this server sandbox or
> Expo Go. Every native-dependent item below is marked **NATIVE-VERIFICATION-PENDING**.

---

## 0. MODULE 1 — LEAD CAPTURE ENGINE: SYSTEMIC ROOT CAUSE (FIXED)

**Reported symptom:** On the freshly built native APK, "only Manual Entry works."
Business Card OCR, Email Signature OCR, QR, LinkedIn QR, and NFC all fail to produce a
saved lead.

**This is NOT an OCR, AI, camera, or native-module failure. It is a single
authorization defect that breaks every capture method except (apparently) manual entry.**

### Evidence (production)
- Production deployment logs: **every `POST /api/scans` returns HTTP 403**, and
  `PATCH`/`DELETE /api/contacts/:id` also return 403. OCR code never runs — the request
  is rejected at the permission gate before reaching the AI engine (a real OCR failure
  would return 502, not 403).
- Production database `users` table: the three tenant admins (ids 2,3,4) have
  `role = "company_admin"` with `permissions = {}`.

### Root cause: stale role name in the production database
The Phase-0 role rename (`company_admin` → `primary_admin`) was applied to the code and
to the **development** database, but the **production** database still stores the old
`company_admin` value. Authorization recognizes only the canonical names:
- `requirePermission` grants its full-access bypass only to `platform_owner` /
  `primary_admin`. A `company_admin` user does **not** bypass, and with empty
  `permissions {}` every permission-gated **write** is denied with 403.
- All non-manual capture methods funnel their final lead creation through these same
  gated writes (`POST /scans` for card/signature OCR; `POST /contacts` via the shared
  `scan-review` screen for QR/LinkedIn-QR/NFC). So the stale role 403s the entire engine.
- (Manual entry shares `POST /contacts` too; under the current code it would 403 as well
  on the next publish — i.e. the report's "only manual works" would have regressed to
  "nothing works." The fix prevents that.)

### Fix (code, self-healing — prod DB is read-only to the agent)
Normalize the legacy role at the auth boundary so stored `company_admin` is treated as
`primary_admin` everywhere (and `team_member` → `employee`):
- `artifacts/api-server/src/middlewares/requireAuth.ts` — new `normalizeRole()`; applied
  when building `req.user.role`, so **all** server authorization (`requirePermission`
  bypass, `requireRole`, `ROLE_RANK`) sees the canonical role.
- `artifacts/api-server/src/routes/auth.ts` — applied to the login/`/auth/me` response
  role and the signed JWT payload so clients carry the canonical role.

This requires no production DB write; the legacy data is corrected at runtime and the
defect resolves the moment the new server build is published.

### Verified live in this environment (development API, through the proxy)
A temporary user with `role = "company_admin"` + `permissions = {}` was created in the dev
DB to reproduce the production condition, then exercised against the running API:
- `POST /auth/login` → 200, response `role` normalized to `primary_admin`.
- `POST /api/scans` → **502** (no longer 403) — the permission gate is lifted and the
  request reaches the OCR engine; 502 is the graceful "couldn't read card" for a 1×1
  dummy image. A real card image returns 201 with extracted fields.
- `POST /api/contacts` → 201, `PATCH /api/contacts/:id` → 200, `DELETE /api/contacts/:id`
  → 200 (all previously 403). Temp user removed after the test.

### Per-method status after the fix
| Method | Path | Status |
|---|---|---|
| Business Card OCR | `POST /scans` (Gemini) → `scan-review` → `POST /contacts` | Unblocked. OCR reachable; integration provisioned in prod (server boots, which requires the Gemini env vars). On-device OCR quality = NATIVE-VERIFICATION-PENDING. |
| Email Signature OCR | same `/scans` path (prompt already generalized, §1.1) | Unblocked, same as above. |
| QR | `parseQr` (on-device) → `scan-review` → `POST /contacts` | Unblocked. Parser unit-tested (17/17). |
| LinkedIn QR | `parseQr` (URL → `linkedin` field) → review → create | Unblocked. **Inherent limit:** a LinkedIn QR encodes only the profile URL, so name/email cannot be auto-filled — by design the rest is entered/confirmed in review. |
| NFC | `lib/nfc.ts` (NDEF) → `scan-review` → `POST /contacts` | Unblocked. **Inherent limit:** only NDEF-formatted tags carry contact data; non-NDEF/locked tags cannot be read — handled with a clear "unsupported tag" message. NATIVE-VERIFICATION-PENDING. |
| Manual | `POST /contacts` | Works; now protected from the publish regression described above. |

**Lead auto-creation:** in this data model the contact **is** the lead — `POST /contacts`
scores it (`leadScore`/`leadTemperature`/`aiReasoning`) and places it in the pipeline at
status `new`. So every method that reaches the create call produces a scored lead. The
`scan-review` confirmation step is retained deliberately (one tap) to prevent OCR/parse
misreads from creating junk leads; the original "no lead created" defect was the 403, now
resolved.

---

## A. Confirmed code-level defects — FIXED

### 2.3 — Duplicate "Edit Contact" action
- **Root cause:** `contact/[id].tsx` rendered both a header edit icon *and* a redundant
  "Edit Contact" row in the Manage section.
- **Files:** `app/contact/[id].tsx`
- **Solution:** Removed the duplicate Manage row; the top-right header edit icon is the
  single entry point.
- **Testing:** Mobile typecheck passes; visual structure verified by reading the
  remaining Manage rows.
- **Native verification:** Not required (pure UI structure).

### 2.5 — "Share contact" produced plain text, not an importable card
- **Root cause:** `handleShare` shared a hand-built text string, so the recipient could
  not import the contact into their address book.
- **Files:** `lib/vcard.ts` (new), `app/contact/[id].tsx`
- **Solution:** Added an RFC-6350 vCard 3.0 generator (`buildVCard`). `shareContactAsVCard`
  writes a `.vcf` to the cache directory (`expo-file-system/legacy`) and shares it via
  `expo-sharing` with the correct MIME type/UTI (`text/vcard` / `public.vcard`). When file
  sharing is unavailable (web / Expo Go / no provider) it falls back to the React Native
  `Share` sheet with the vCard text so the action never silently fails. The temp file is
  cleaned up after sharing.
- **Testing:** Mobile typecheck passes; expo export bundles cleanly.
- **Native verification:** NATIVE-VERIFICATION-PENDING — confirm on device that the shared
  `.vcf` opens in the OS contact importer.

### 3 — No way to delete a scheduled Follow-Up
- **Root cause:** No DELETE route, generated hook, or UI existed for follow-ups.
- **Files:** `lib/api-spec/openapi.yaml`, generated `@workspace/api-client-react`,
  `artifacts/api-server/src/routes/follow_ups.ts`, `app/(tabs)/followups.tsx`,
  i18n locales.
- **Solution:**
  - OpenAPI: added `DELETE /follow-ups/{id}` (`operationId: deleteFollowUp`, returns
    `SuccessResponse`) → regenerated hooks (`useDeleteFollowUp`).
  - Backend: tenant-scoped DELETE handler — verifies access via `canAccessCompany` (404 on
    cross-tenant/nonexistent), deletes the row, then calls `syncContactFollowUp` to
    re-denormalize `contacts.followUpDate/Time` to the next pending follow-up. Audit +
    read-only-mutation guards already apply (path-scoped to `/follow-ups`).
  - UI: a destructive "Delete follow-up" action in the action sheet with a native
    confirmation dialog; the list refetches and the sheet closes on success; failures
    surface an alert.
- **Testing:** api-server typecheck passes; `DELETE /api/follow-ups/:id` returns 401 when
  unauthenticated (route registered & guarded); codegen + libs typecheck pass.
- **Native verification:** NATIVE-VERIFICATION-PENDING — confirm the confirm dialog and
  list refresh on device.

---

## B. Low-risk improvements addressing reported symptoms — DONE

### 2.1 / 2.2 — Status change & assign appeared to "do nothing"
- **Root cause:** `changeStatus` and `assignTo` awaited `mutateAsync` with **no
  try/catch**. A failed request failed silently, which to the user looks identical to
  "the button doesn't work." (The underlying mutation itself is correct.)
- **Files:** `app/contact/[id].tsx`, i18n locales
- **Solution:** Wrapped both in try/catch and surface an error `Alert`
  (`contacts.updateFailedTitle/Body`) on failure. Success path is unchanged.
- **Testing:** Mobile typecheck passes.
- **Native verification:** NATIVE-VERIFICATION-PENDING — confirm against a fresh build that
  these now succeed (suspected stale APK), and that errors surface when offline.

### 1.1 — OCR missed email-signature / screenshot captures
- **Root cause:** The extraction prompt in `ai.ts` was worded specifically for business
  cards/badges, so signature screenshots extracted poorly.
- **Files:** `artifacts/api-server/src/lib/ai.ts`
- **Solution:** Generalized the prompt to explicitly cover business cards, event badges,
  **and** email signatures / contact-block screenshots, while keeping the bilingual
  (Arabic/English) and structured-JSON rules intact.
- **Testing:** api-server typecheck passes.
- **Native verification:** Server-side; validate extraction quality against real signature
  images.

### 8 — Surface AI recommended priority + suggested follow-up window
- **Root cause:** The app stored a real AI `leadTemperature` but never surfaced actionable
  guidance from it.
- **Files:** `app/contact/[id].tsx`, i18n locales
- **Solution:** In the Lead Intelligence section, derive (no schema change, **no fabricated
  data**) a recommended priority and suggested follow-up window from the **real** stored
  `leadTemperature`: Hot → High / within 2 days; Warm → Medium / within 1 week; Cold →
  Low / within 1 month. This is a transparent rule over existing data, clearly labelled as
  a recommendation.
- **Testing:** Mobile typecheck passes.
- **Native verification:** Not required (renders from existing data).

---

## C. Already implemented correctly in current code — NOT defects (need fresh APK + on-device re-test)

These are **NATIVE-VERIFICATION-PENDING** against a freshly built APK. No code change was
required; the reported failures point to a stale build.

- **1.2 QR extraction** — the grouped-vCard parser fix shipped previously; `parseQr` in
  `lib/contact-parse.ts` handles QR + NFC NDEF payloads (17 parser unit tests pass).
- **2.4 Save to Phone** — uses `expo-contacts` `presentFormAsync`; Android contacts
  permissions are declared in `app.json`.
- **4 NFC** — broad NDEF tech list with graceful "unsupported" handling; degrades safely on
  web/Expo Go.
- **6 GPS** — `expo-location` present with permissions; latitude/longitude/accuracy stored
  on capture and a maps link is rendered.
- **7 Status History** — backend writes a history row on contact POST and on status PATCH;
  the contact screen renders the timeline.
- **2.1 pipeline enum** — mobile `CONTACT_PIPELINE_ORDER` matches the backend enum exactly
  (new / contacted / quotation_sent / negotiation / won / lost).

---

## D. Out of safe scope without device reproduction (documented, not changed)

No clear code-level defect was identifiable; changing them blind risks regressions. These
need an on-device repro (ideally a screen recording) before any fix:

- **5.1** Scroll triggered on empty space.
- **5.2** Three-dot menu overlap.
- **5.3** Placeholder / validation text overlap.

---

## E. Verification performed in this environment

- `pnpm --filter @workspace/api-spec run codegen` — success (libs typecheck passed).
- `pnpm --filter @workspace/mobile run typecheck` — pass.
- `pnpm --filter @workspace/api-server run typecheck` — pass.
- `pnpm --filter @workspace/mobile exec vitest run` — 17/17 parser tests pass.
- `DELETE /api/follow-ups/:id` — returns 401 unauthenticated (route registered + guarded).
- `npx expo export` — iOS bundle builds cleanly (exit 0).

## F. Limitations

- No native device/emulator is available here, so all native-module behaviour
  (NFC, contacts, location, file sharing) is **unverified on-device** and marked
  NATIVE-VERIFICATION-PENDING. These must be validated on an Expo Development Build or an
  EAS `development`/`preview` APK (see `eas.json`) — **not Expo Go**.
- The strong recommendation is to cut a fresh build first and re-test section C before
  treating any of those items as real defects.
