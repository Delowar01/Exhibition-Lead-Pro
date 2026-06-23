# Technical-Debt Register

_Prioritized gaps identified during the Stage 1 architecture review._

Each item lists its **impact** and a **recommended remediation stage**. Items
fixed during Stage 1 are recorded at the bottom for traceability. Severity is the
risk to correctness, security, or maintainability if left unaddressed.

> Scope note: this register tracks engineering/architecture debt. Native
> on-device verification items (camera OCR, NFC, biometrics, notifications, GPS)
> are tracked in the [reports](reports/README.md), not here.

## Critical

_None open._ The Stage 1 hardening closed the one critical server-crash class
(empty-body `PATCH` 500s) and removed the hardcoded JWT-secret fallback by
centralizing `SESSION_SECRET` with fail-fast validation.

## High

| # | Item | Impact | Remediation stage |
|---|---|---|---|
| H1 | **Write routes validate via manual destructuring, not the shared Zod schemas.** | `POST /contacts` with `{}` can create an all-null record (HTTP 201); junk/extra fields are silently ignored. Inconsistent validation surface across modules. | Stage 2 — adopt `@workspace/api-zod` request schemas on all writes; require at least one identifying field on contact creation. |
| H2 | **No service layer — route handlers mix HTTP, business rules, and data access.** | Harder to unit-test business logic in isolation; logic duplication risk as modules grow; larger blast radius for changes. | Stage 2 — extract a per-module service layer beneath the routes. |

## Medium

| # | Item | Impact | Remediation stage |
|---|---|---|---|
| M1 | **Report/pipeline currency totals are derived client-side from a capped list.** | Event/team-member pipeline totals convert per-lead from the first ~200 leads; an entity with more than 200 leads undercounts. The dashboard total is unaffected (server-grouped). | Stage 2 — server-side currency normalization in `reports.ts`. |
| M2 | **Readiness "storage" check means _configured_, not _reachable_.** | `/readyz` reports storage "ok" when the bucket id is present, even if the bucket is unreachable — possible false confidence during a storage outage. | Stage 2 (optional) — upgrade to a real reachability probe; document the current semantics in the meantime (done in the API guide). |
| M3 | **Mixed `.js`/extensionless relative imports in `api-server`.** | Tolerated by the bundler today, but inconsistent and a footgun for future module-resolution changes. | Stage 2 — standardize on one import-extension convention. |

## Low

| # | Item | Impact | Remediation stage |
|---|---|---|---|
| L1 | **vCard parser gaps (line-folding RFC 2426, QUOTED-PRINTABLE).** | Some legacy address-book exports won't fully decode. Low real-world frequency. | Backlog — add parser tests + handling when prioritized. |
| L2 | **Single phone number / Arabic name stored in notes.** | Only the primary `TEL` is kept; extracted Arabic-script name lives in notes, not a structured column. | Backlog — requires a schema migration; out of Stage 1 scope. |
| L3 | **Dashboard first-load polish.** | Dashboard has minimal skeleton/empty treatment vs. richer list screens. No business-logic impact. | Backlog — UX polish. |

## Resolved in Stage 1 (for traceability)

| Item | Resolution |
|---|---|
| Scattered `process.env` reads across modules | Centralized into `artifacts/api-server/src/config.ts` (single source). |
| Hardcoded JWT-secret fallback | Removed; `SESSION_SECRET` is now eagerly required (fail-fast at startup). |
| No global error handling / inconsistent error responses | Added `errorHandler` + `notFoundHandler` emitting the unified `{ error }` shape while preserving framework status codes (413/400). |
| No readiness signal for orchestration | Added `GET /api/readyz` (DB probe + storage config check, 503 on DB down) alongside the unchanged `/api/healthz`. |
| Missing baseline security headers | Added `helmet` (with CSP/CORP/COEP disabled for the cross-origin image API). |
