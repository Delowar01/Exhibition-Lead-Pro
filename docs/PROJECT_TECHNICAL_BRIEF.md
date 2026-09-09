# Project Technical Brief — Lead Capture Pro (Card Scanner Pro)

> Authoritative technical brief for the exported repository. It is written so a
> new developer can understand what the application does, how it is built, what
> is complete, and where every important implementation lives — without access
> to any prior Replit conversation.
>
> The product ships under two names: the codebase and workspace call it **Card
> Scanner Pro**; the product/spec direction calls it **Lead Capture Pro**. They
> are the same system. This document uses "Lead Capture Pro" for the product and
> "Card Scanner Pro" where the code, brand strings, or demo data do.
>
> Companion documents (do not contradict them):
> [architecture.md](architecture.md), [product.md](product.md),
> [ai-architecture.md](ai-architecture.md),
> [security-and-privacy.md](security-and-privacy.md), [api-guide.md](api-guide.md),
> [gotchas.md](gotchas.md), [deployment.md](deployment.md),
> [PORTABLE_ENVIRONMENT_SETUP.md](PORTABLE_ENVIRONMENT_SETUP.md),
> [LOCAL_AND_STAGING_RUNBOOK.md](LOCAL_AND_STAGING_RUNBOOK.md),
> [SECRET_AND_PORTABILITY_AUDIT.md](SECRET_AND_PORTABILITY_AUDIT.md),
> [PROJECT_FILE_MAP.md](PROJECT_FILE_MAP.md). The authoritative environment
> contract is the root [`.env.example`](../.env.example).

---

## A. Product overview

Lead Capture Pro is a **multi-tenant B2B CRM built around AI-assisted business-card
scanning and lead management.** Sales teams capture contacts in the field (camera
OCR, QR, LinkedIn QR, email-signature paste, NFC, or manual entry), the system
extracts and structures the data with AI, and the contact flows into a CRM with
leads, a Kanban pipeline, events, follow-ups, tasks, documents, and analytics.

**Target users**

- **Platform Owner** — the operator of the SaaS. Manages all tenant companies,
  subscriptions/plans, platform-wide analytics, and platform user management from
  the web Platform Owner portal (`/platform`). Sees cross-tenant aggregates only.
- **Tenant users** (company admins and employees) — belong to exactly one company
  (`companyId`). They scan cards, manage contacts/leads/events/team, run reports,
  and use the AI surfaces from the web Company Admin portal (`/admin`) and the
  mobile app. A 4-tier role hierarchy governs them:
  `platform_owner → primary_admin → admin → employee`.

**Multi-tenant SaaS model** — `company_id` is the **sole** tenant boundary (there is
no separate `tenant_id`). Every tenant-scoped read is filtered through
`tenantScope`; cross-tenant access returns **404**, never 403, to avoid leaking row
existence. `platform_owner` is the only cross-tenant role.

**Web application responsibilities** — full administration surface: both portals
(Platform Owner + Company Admin), contact workspace, Kanban lead pipeline, events,
team/org/RBAC/security administration, reports & exports, notification center, and
every AI surface (AI Command Center, Workflow Intelligence, Executive Intelligence,
AI Sales Copilot, AI Assistant, AI Insights review, batch operations).

**Mobile application responsibilities** — a **field-capture and light-CRM client**
for employees: all capture modes, contacts/companies/leads/follow-ups/tasks/
meetings/events, review & duplicates, offline queue, notifications, the AI
Assistant, MFA login, and the user's own digital card. It is deliberately **not** a
full administration client.

**Permanently removed scope** (owner decision, August 2026 — audits must NOT count
these as pending, and they must not be reintroduced):

1. Customer Portal (external-customer login / customer-facing dashboard / customer
   self-service).
2. Custom Domains (tenant-owned domains, DNS verification, host→tenant routing, SSL).
3. Public Developer Platform (public API keys, public developer portal/docs, generic
   customer webhooks).
4. Generic Integration Marketplace (catalogue of generic third-party connectors).
5. **Full administration inside the mobile app** (org admin, users, departments,
   teams, roles/permissions, Security Center, audit logs, subscription/billing,
   platform-owner tenant administration, branding/integrations/API-key screens).
6. **Mobile AI Command Center, mobile Workflow Intelligence, mobile Executive
   Intelligence.** The **mobile AI Assistant is retained and in scope.**

Explicitly retained: normal tenant/user login, all web administration, the web
Platform Owner panel, all web AI surfaces, Gemini + the Enterprise AI Layer,
internal application/backend APIs, billing webhooks, and **every capture mode —
NFC, business card, email signature, QR, LinkedIn QR, manual entry.**

---

## B. Current project status

**Batch 8 is complete and device-verified.** Physical-device testing passed on an
**Honor Magic V5, Android 16**.

**Latest verified baseline totals**

| Suite | Result |
|---|---|
| API (vitest, integration + unit) | **705 / 705** |
| Web e2e (Playwright, chromium) | **43 / 43** |
| Mobile (vitest) | **107 / 107** |
| API / web / mobile typechecks | **clean** |

**Batch history summary** — the product was built in stages and later hardening
batches. Stages 1–5 delivered the server foundation, multi-tenant CRM, org
structure, analytics, and the full AI platform (5.0 foundation, 5A insights, 5B
Sales Copilot, 5C Executive Intelligence, 5E Intelligent Capture, 5F Workflow
Intelligence), followed by the Contact-vs-Interaction model overhaul, the Stage 5.9
enterprise design-system modernization, and the numbered hardening/verification
Batches through Batch 8 (device verification). Per-stage detail lives under
[docs/reports/](reports/README.md); AI-stage roadmaps live in
[STAGE_5_AI_ROADMAP.md](STAGE_5_AI_ROADMAP.md) and
[STAGE_3_ROADMAP.md](STAGE_3_ROADMAP.md).

**Major completed modules** — auth (JWT access+refresh rotation, MFA/TOTP, trusted
devices, RBAC + custom roles), multi-tenant isolation, contacts, leads + Kanban
pipeline, events, org/departments/teams/territories, documents (versioned),
notifications, reports & exports (scheduled), the full Enterprise AI Layer + all AI
surfaces, business-card capture + OCR across all modes, background job queue, and
the Expo mobile client.

**Current limitations** — object storage requires GCS configuration (uploads fail
without it, server still boots); email is a logged no-op without SMTP config; AI
features degrade gracefully without a Gemini credential; readiness "storage" is a
*configured* check, not a live reachability probe; DB schema is synced via
`drizzle-kit push` (no versioned SQL migrations).

**Next approved work area** — export-readiness / portability / documentation polish
(this task). **Batch 9 has not been started.** No new product features are in scope.

**Features that must not be reintroduced** — the six permanent scope removals in
§A, plus: no second AI/OCR/email/draft system, no direct-to-Gemini calls that
bypass the Enterprise AI Layer, and no AI-generated communication that auto-sends.

---

## C. Technology architecture

**Monorepo** — a `pnpm` workspace (Node.js 24, TypeScript 5.9). Packages live under
`artifacts/*` (deployable apps) and `lib/*` (shared libraries); see
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml). Contract-first: a single OpenAPI
spec generates the API client, React Query hooks, and shared Zod validators.

| Concern | Choice |
|---|---|
| API stack | Express 5, esbuild CJS bundle, `pino`/`pino-http` logging, `helmet` + open CORS |
| Web stack | React 19 + Vite + Tailwind + shadcn/ui, `wouter` router, TanStack Query |
| Mobile stack | Expo (React Native) + Expo Router; EN/AR i18n with RTL; NFC/QR/OCR capture |
| Database / ORM | PostgreSQL + Drizzle ORM (shared pool in `@workspace/db`) |
| Schema sync | **`drizzle-kit push`** — NO versioned SQL migrations |
| Validation | Zod (`zod/v4`) + `drizzle-zod`, generated from the OpenAPI spec |
| API codegen | Orval (OpenAPI → React Query hooks + Zod) |
| Authentication | JWT access + refresh with rotation & family revocation; MFA/TOTP; trusted devices; RBAC + custom roles |
| Session management | Server-side `sessions` rows (refresh families); fresh-per-request `requireAuth` loads live role/permissions/status |
| Storage | Google Cloud Storage (Replit sidecar on Replit; standard Google auth + V4 signed URLs elsewhere) |
| Email | SMTP (only built-in transport), queued via the in-process job queue; no-op when unconfigured |
| AI provider | **Gemini `gemini-2.5-flash` ONLY** via the Enterprise AI Layer; deterministic stub provider for dev/test |
| OCR | Gemini vision extraction (thinkingBudget 0) through the same AI Layer |
| Background jobs | In-process job queue (`JOBS_DRIVER=in-process`) — email, notifications, recurring maintenance/exports/alerts |
| Testing | vitest (API + mobile), Playwright (web e2e, Nix chromium) |

**Current deployment environments** — local dev; **staging = this Repl published**
at `https://contact-aggregator--DelowarHossain1.replit.app`; mobile APKs via EAS
`preview`/`production` profiles (both baked with that URL). See §M.

---

## D. Package and folder map

Every workspace package: path, purpose, and key directories/entry points.

### `artifacts/api-server` — Express API (`@workspace/api-server`)
The backend. Entry point `src/index.ts` builds the app in `src/app.ts`. Key dirs:

- `src/routes/` — Express route handlers, one file per resource group, mounted
  under `/api/v1` (see §G). `routes/index.ts` wires them.
- `src/services/` — business logic per module (`*.service.ts`), e.g. `auth`,
  `contacts`, `leads`, `scans`, `ai*`, `capture-*`, `export`, `notifications`.
- `src/repositories/` — data access per module (`*.repository.ts`) over Drizzle;
  `base.ts` holds shared helpers.
- `src/ai/` — the **Enterprise AI Layer** (see §J): `index.ts` barrel, `runner.ts`
  (timeout/retry/JSON), `providers/` (`gemini.ts`, `stub.ts`, `index.ts` registry),
  `prompts.ts` (versioned prompt registry), `pricing.ts`, `dedup.ts`,
  `rate-limit.ts`, `types.ts`.
- `src/middlewares/` — `requireAuth.ts` (auth + `tenantScope`), `errorHandler.ts`,
  `validate.ts`, `rateLimit.ts`, `microCache.ts`.
- `src/lib/` — cross-cutting helpers: `tenant.ts` (`refAccessible`/`refInCompany`),
  `objectStorage.ts` (portable GCS auth), `imageStorage.ts`/`documentStorage.ts`/
  `exportStorage.ts`, `email/`, `jobs/`, `mfa.ts`, `sessions.ts`, `tokens.ts`,
  `crypto.ts`, `push.ts`, `logger.ts`, `permission-backfill.ts`.
- `src/config.ts` — **the single env-access point** (§N).
- `scripts/verify-ocr-live.ts` — opt-in live-Gemini OCR verification (§K).
- `test/` and `src/**/*.test.ts` — vitest suites.

### `artifacts/web-app` — Admin portal (`@workspace/web-app`)
React + Vite admin/platform portal. Entry `src/App.tsx` (router). Key dirs:
`src/pages/platform/` (Platform Owner pages), `src/pages/admin/` (Company Admin
pages), `src/components/layouts/` (`PlatformLayout`, `AdminLayout`),
`src/contexts/AuthContext.tsx` (auth state), `src/components/ui/` (shadcn). E2E in
`e2e/` (`playwright.config.ts`). Consumes `@workspace/api-client-react`.

### `artifacts/mobile` — Expo app (`@workspace/mobile`)
Expo Router field client. Screens in `app/` (see §I). `lib/` holds device
integrations (`nfc.ts`, `push.ts`, `offline-queue.ts`, `auth-storage.ts`,
`secure-prefs.ts`, `card-*`, `i18n/`). API base URL resolves in `app/_layout.tsx`
from `EXPO_PUBLIC_API_URL` (then `EXPO_PUBLIC_DOMAIN`). `eas.json` holds build
profiles. Consumes the generated API client.

### `artifacts/pitch-deck` — marketing slides (`@workspace/pitch-deck`)
Static slide/pitch presentation artifact. Not part of the runtime product.

### `lib/db` — Drizzle schema + pool (`@workspace/db`)
The **only** DB access layer. `src/schema/*.ts` (one table group per file,
re-exported from `src/schema/index.ts`) plus the shared connection pool. Schema is
synced with `pnpm --filter @workspace/db run push` (drizzle-kit push).

### `lib/api-spec` — OpenAPI source of truth (`@workspace/api-spec`)
`openapi.yaml` is the single API contract; `orval.config.ts` drives codegen.
Regenerate with `pnpm --filter @workspace/api-spec run codegen`.

### `lib/api-zod` — generated Zod schemas (`@workspace/api-zod`)
Request/response Zod validators generated from the spec; used on the server.

### `lib/api-client-react` — generated client (`@workspace/api-client-react`)
Orval-generated React Query hooks + a custom fetch wrapper. Exposes
`setAuthTokenGetter` and `setOnUnauthorized` (401 refresh hook). Consumed by web and
mobile.

### `lib/integrations-gemini-ai` — Gemini client (`@workspace/integrations-gemini-ai`)
The vendor SDK wrapper. `src/client.ts` — **lazy singleton** `GoogleGenAI` behind a
Proxy that resolves credentials on first use (the Replit AI-integration proxy pair
`AI_INTEGRATIONS_GEMINI_*` takes precedence, else direct `GEMINI_API_KEY`);
`isGeminiConfigured()` gates AI features so the server boots without a key.
`src/image/`, `src/batch/` hold image/batch call surfaces.

### `scripts` — workspace utilities (`@workspace/scripts`)
`src/seed-demo.ts` seeds demo tenants + the demo login accounts.

**Dependency direction** — `lib/api-spec` → generates → `lib/api-zod` +
`lib/api-client-react`. Apps (`web-app`, `mobile`) → `api-client-react`. `api-server`
→ `lib/db`, `lib/api-zod`, `lib/integrations-gemini-ai`. `lib/db` depends on nothing
in the workspace.

---

## E. Core runtime flows

Unless noted, routes are under `/api/v1` (§G), services in
`artifacts/api-server/src/services/`, repositories in `.../repositories/`.

**Login** — `POST /auth/login` → `auth.service.ts` verifies the password
(`lib/crypto.ts`), enforces the per-account lockout + `loginRateLimiter`, resolves
the tenant's entitlement from the CANONICAL `subscriptions` row
(`lib/company-access.ts` → `loadTenantAccess`; the same reader gates every request
in `requireAuth` and every refresh in `lib/sessions.ts` — Batch 20), then creates a **session
row/refresh family** (`lib/sessions.ts`) and returns a JWT access token +
refresh token. `writeAudit` records the login.

**MFA login** — if `users.mfaEnabled`, login returns a short-lived MFA challenge
token (`config.auth.mfaChallengeTtl = 10m`) instead of a session. The client
submits the TOTP code (verified in `lib/mfa.ts` against the AES-256-GCM-encrypted
`users.mfaSecret`, or a `mfa_backup_codes` row). "Remember this device" mints a
`trusted_devices` entry (`trustedDeviceTtlDays`) so future logins skip the challenge.

**Session refresh (rotation + family revocation)** — `POST /auth/refresh` rotates
the refresh token: the presented token is validated against its `sessions` family,
a **new** refresh token is issued, and reuse of a retired token revokes the whole
family (theft detection). Web wires this via `setOnUnauthorized` in
`web-app/src/App.tsx` (on 401 it calls `/api/auth/refresh` and re-stores
`csp_token`/`csp_refresh_token`); mobile stores tokens in `lib/auth-storage.ts`.

**Logout** — `POST /auth/logout` revokes the current session/family server-side, so
the still-valid-by-TTL access token is immediately rejected on the next request
(`requireAuth` re-checks the session).

**Invitation** — an admin calls `POST /invitations` → `invitations.service.ts`
creates an `invitations` row storing only the SHA-256 `tokenHash`, `roleIds`, and an
expiry (`invitationTtlDays`), and **queues** an invite email (job queue). The
invitee opens `/accept-invite/:token` (web `AcceptInvite.tsx`) → `POST
/invitations/accept` creates the user with the assigned custom roles. `emailStatus`
(`queued|sent|failed|skipped`) is tracked honestly — "queued" is never shown as
"delivered".

**Password reset** — `POST /auth/forgot-password` (rate-limited per IP+email) mints
a `verification_tokens` reset token and queues an email with a link to the web
`/reset-password` page (link base = `config.email.appBaseUrl`); `POST
/auth/reset-password` consumes it. When email is unconfigured the flow degrades
honestly.

**Tenant resolution** — `requireAuth` loads the **fresh** user row every request
(role, permissions, status, `companyId`) rather than trusting the JWT payload, then
exposes `tenantScope(req.user, table.companyId)`: no filter for `platform_owner`,
`inArray(column, accessibleCompanies)` for everyone else. Never scope a read by
`companyId` alone.

**Permission enforcement** — `platform_owner`/`primary_admin` bypass permission
checks; `admin`/`employee` are gated by the `users.permissions` matrix
(`module → [actions]`) on **writes** only (reads stay open but tenant-scoped). Empty
`{}` = deny-by-default. FK references on writes are validated with `refAccessible`
(`lib/tenant.ts`). No role escalation on POST/PATCH `/users`.

**Contact creation** — `POST /contacts` → `contacts.service.ts` → `contacts.repository.ts`
inserts a `contacts` row scoped to `companyId`; optional AI enrichment/scoring runs
through the AI Layer and writes `leadScore`/`industry`/`enrichmentSummary` etc.

**Lead lifecycle** — leads move through tenant-configurable `pipeline_stages`
(Kanban); `leads.service.ts` records `lead_activities`/`lead_notes`; `contacts.status`
tracks the CRM funnel (`new → contacted → qualified → … → won/lost/archived`) with
`contact_status_history`.

**Business-card capture → OCR → save** — the client captures an image (camera crop
on mobile) or structured data (QR/vCard/NFC/manual). `scans.service.ts` records a
`scans` row (`captureSource`, `extractionMethod`, `status=pending`). For image
capture the base64 image is sent to `POST /scans` (15 MB body limit); the server
calls **Gemini OCR** through the AI Layer (`card_extraction` prompt, current
version 4, `thinkingBudget 0`) via `lib/integrations-gemini-ai/src/image/`,
persisting `extractedData`, `fieldConfidences`, `confidence`, `aiModel`,
`promptVersion`, `processingTimeMs`. Every capture is a **permanent interaction**
attached to a contact (Contact-vs-Interaction model; see
[interaction-model.md](interaction-model.md)) — weighted dedupe can raise a
human-in-the-loop 409 flow.

**Batch scan** — multi-card capture: `capture-batch.service.ts` /
`ai-batch.service.ts` process several scans, each producing its own interaction
row; the mobile `batch-review.tsx` screen (web `BatchOperations`) reviews them
before save.

**Scan review** — the extracted fields (+ per-field confidences) are shown for human
correction (mobile `scan-review.tsx`, web `Scan.tsx`) before the contact is saved —
AI never writes the source CRM unattended.

**AI Copilot / AI Assistant** — `ai-copilot.service.ts` drafts emails/WhatsApp/call &
meeting prep/proposals from real CRM data; `ai-assistant.service.ts` answers
questions grounded in the tenant's data. Both **recommend/draft only — never
auto-execute or auto-send**, and degrade to deterministic grounded output when
Gemini is unavailable.

**AI usage metering / budget admission / rate limiting** — every AI call goes
through `ai.service.ts`: a **reservation** (`ai_usage_reservations`) is taken against
the tenant month budget before the provider call; the call is admitted only if
budget + AI rate limits (`config.ai.rateLimits`: per-user/per-tenant/heavy-per-user
one-minute windows) allow it; a duplicate-request guard (`dedup.ts`) may reuse a
recent identical result; the outcome is written once to the append-only
`ai_invocations` ledger (tokens, micro-USD cost at the stamped `pricingVersion`,
status, latency, prompt version) and the reservation is finalized. See §J.

**Notifications** — `notifications.service.ts` writes `notifications` rows (category
e.g. `ai`), honoring `notification_preferences`; delivery + push run off the job
queue. Web `Notifications` + notification bell; mobile `notifications.tsx` + bell.

**File / image access** — `objectStorage.ts` brokers GCS: on Replit the workspace
sidecar issues short-lived tokens/signed URLs; elsewhere standard Google auth
(service account with `signBlob`) produces V4 signed URLs. Card images and documents
are private objects served via signed URLs; `objectAcl.ts` enforces access. Override
detection with `OBJECT_STORAGE_AUTH`.

**Email delivery** — `lib/email/` builds branded templates and sends over SMTP.
Delivery is queued (`JOBS_ASYNC_EMAIL=true`) through the job queue; unconfigured SMTP
degrades to a logged no-op. Links use `config.email.appBaseUrl` (a localhost warning
is logged when unset in production).

**Background jobs** — the in-process queue (`lib/jobs/`, `JOBS_DRIVER=in-process`)
runs email/notification delivery plus recurring sweeps configured in `config.jobs`:
follow-up reminders, maintenance/retention (sessions, read notifications), scheduled
exports (`export.service.ts` → `export_schedules`/`export_runs`), and Stage 5F
workflow risk-alert digests.

**Push** — `push.ts` + `routes/push.ts` register Expo device tokens (`device_tokens`)
and deliver push notifications (optional `EXPO_ACCESS_TOKEN`).

---

## F. Data model

The schema lives in **`lib/db/src/schema/*.ts`**, re-exported from
`lib/db/src/schema/index.ts`, and is synced with `drizzle-kit push` (no versioned
SQL migrations). All read/write access goes through `@workspace/db`. Highlights:

**Multi-tenancy** — nearly every business table carries a `companyId` FK to
`companies` (`onDelete: cascade`) as the tenant boundary; reads are filtered by
`tenantScope`. `ai_invocations.companyId` is nullable (system/non-tenant calls are
invisible to tenant reads and surface only in platform-owner aggregates).

**Soft-delete** — `contacts`, `documents`/`document_versions`, `scans`, users, and
other core tables carry a nullable `deletedAt` marker; rows with a value are excluded
from reads by default (restore = clear the marker). Login/auth user-load excludes
soft-deleted users.

| Table (file) | Purpose / notes |
|---|---|
| `companies` (`companies.ts`) | Tenant root. `plan` / `status` / `trial_ends_at` are **write-only compatibility mirrors** since Batch 20 — access is never decided from them. |
| `users` (`users.ts`) | Auth + profile. `role` (4-tier), `permissions` matrix, visibility scopes, MFA fields (`mfaSecret` encrypted), soft-delete, org profile (`managerId`, `departmentId`, `teamId`). |
| `sessions` (`sessions.ts`) | Refresh-token families; rotation + revocation; `expiresAt`, `revokedAt`. |
| `login_attempts` (`login_attempts.ts`) | Brute-force lockout tracking. |
| `mfa_backup_codes`, `trusted_devices` | MFA recovery codes; remembered devices. |
| `roles`, `role_permissions`, `user_roles` | Custom RBAC roles per tenant. |
| `security_policies`, `security_events` | Security Center policy + event log. |
| `invitations` (`invitations.ts`) | Tokenized invites (SHA-256 `tokenHash`, `roleIds`, `emailStatus` lifecycle). |
| `verification_tokens` (`verification_tokens.ts`) | Password-reset + email-verify tokens. |
| `contacts` (`contacts.ts`) | Core CRM contact; AI-enriched fields, GPS, `duplicateOfId`, `status`, soft-delete; indexed by company/organization/event/assignee. |
| `scans` (`scans.ts`) | **Interaction ledger** — one row per capture; `captureSource`/`extractionMethod`, per-field confidences, provenance (`aiModel`, `promptVersion`), GPS/notes; soft-delete. |
| `business_cards` | User's own shareable digital card. |
| `leads`, `pipeline_stages`, `lead_activities`, `lead_notes` | Lead pipeline + activity/notes. |
| `contact_status_history` | Contact funnel transitions. |
| `merge_history` | Duplicate merge audit. |
| `events`, `meetings`, `tasks`, `follow_ups` | Events/interactions & task management. |
| `organizations`, `departments`, `teams`, `territories`, `assignment_cursors` | Org structure + round-robin assignment. |
| `documents`, `document_versions` | Versioned documents (immutable versions, unique per-doc version number). |
| `notifications`, `notification_preferences`, `device_tokens` | Notification center + push. |
| `custom_fields`, `tags`, `saved_searches`, `recent_searches` | Extensibility + search. |
| `export_schedules`, `export_runs` | Scheduled/one-off exports. |
| `subscriptions`, `plans`, `plan_prices`, `billing_checkout_sessions`, `billing_provider_events`, `subscription_usage_reservations` | Canonical subscription per company (Batch 20: status, billing source, trial/period, limit overrides, provider ids), stable plan catalog, server-verified provider price mappings, Checkout sessions, idempotent webhook ledger, scan usage reservations — see `docs/B20_SUBSCRIPTION_LIFECYCLE.md`. |
| `audit_logs` (`audit_logs.ts`) | **Append-only** audit trail (no delete route, no cascade). |
| `activity_logs` | Platform activity feed. |
| `ai_invocations` (`ai_invocations.ts`) | **Append-only AI usage ledger** — tokens, micro-USD cost, `pricingVersion`, prompt version, status, latency; `requestId` unique for idempotent writes. |
| `ai_usage_reservations` (`ai_invocations.ts`) | Short-lived budget reservations backing atomic budget admission; expire via `expiresAt`. |
| `ai_settings` | Per-tenant AI configuration (provider, budget, toggles). |
| `ai_insights`, `ai_copilot_outputs`, `ai_workflow_recommendations`, `ai_conversations` | AI feature outputs / assistant history. |
| `executive_intelligence` (`executive_intelligence.ts`) | Executive summaries/forecasts. |

**Key indexes/constraints** — `contacts` indexed on `companyId`,
`(companyId, duplicateOfId)`, organization/event/assignee; `document_versions` has a
unique `(documentId, versionNumber)` guaranteeing collision-free version numbers under
concurrency; `ai_invocations.requestId` and `ai_usage_reservations.requestId` are
unique for idempotent ledger writes; `ai_invocations` carries company/created/feature/
status indexes for aggregation.

---

## G. API surface map

The API is contract-first: `lib/api-spec/openapi.yaml` is the source of truth →
Orval generates the client/hooks/Zod. Route handlers are in
`artifacts/api-server/src/routes/` (one file per group), wired in `routes/index.ts`
and **mounted at `/api/v1`**. Each group follows the same shape: `route → service →
repository`, guarded by `requireAuth` + the permission matrix (writes), and
tenant-scoped via `tenantScope`. This is a map — see the OpenAPI spec for the full
contract, and [PROJECT_FILE_MAP.md](PROJECT_FILE_MAP.md) for per-feature file paths.

| Base route (`/api/v1/…`) | Route file | Purpose | Primary consumer |
|---|---|---|---|
| `/auth` | `auth.ts` | Login, MFA, refresh rotation, logout, forgot/reset password, verify email | Web + mobile |
| `/invitations` | `invitations.ts` | Invite / accept / cancel; email lifecycle | Web (admin) |
| `/users` | `users.ts` | User CRUD, no-escalation, roles | Web (admin) |
| `/rbac`, `/roles` | `rbac.ts` | Custom roles + permissions | Web (admin) |
| `/security` | `security.ts` | Security Center policies/events | Web (admin) |
| `/profile` | `profile.ts` | Current-user profile, MFA enroll, sessions | Web + mobile |
| `/companies` | `companies.ts` | CRM organizations (tenant-scoped) | Web + mobile |
| `/organizations`, `/org` | `organizations.ts`, `org.ts` | Org structure / hierarchy | Web (admin) |
| `/departments`, `/teams`, `/territories` | `departments.ts`, `teams.ts`, `territories.ts` | Org units + assignment | Web (admin) |
| `/contacts` | `contacts.ts` | Contact CRUD, dedupe/merge, enrichment | Web + mobile |
| `/leads`, `/pipeline` | `leads.ts`, `pipeline.ts` | Leads + Kanban pipeline/stages | Web + mobile |
| `/scans` | `scans.ts` | Card capture, OCR, interactions | Web + mobile |
| `/cards` | `cards.ts` | Digital business card + public share | Web + mobile |
| `/events`, `/meetings`, `/tasks`, `/follow_ups` | resp. files | Events/meetings/tasks/follow-ups | Web + mobile |
| `/tags`, `/custom_fields`, `/search` | resp. files | Tagging, custom fields, search | Web + mobile |
| `/documents` | `documents.ts` | Versioned documents (signed-URL access) | Web + mobile |
| `/notifications`, `/push` | `notifications.ts`, `push.ts` | Notification center + Expo push | Web + mobile |
| `/reports`, `/analytics`, `/exports` | resp. files | Reports, analytics, exports | Web (admin) |
| `/imports` | `imports.ts` | Bulk import | Web (admin) |
| `/ai` | `ai.ts` | All AI features (insights, copilot, assistant, capture intel, settings, usage) | Web + mobile (Assistant) |
| `/executive` | `executive.ts` | Executive Intelligence summaries/forecasts | Web (admin) |
| `/platform` | `platform.ts` | Platform Owner cross-tenant admin/analytics | Web (platform) |
| `/subscriptions` | `subscriptions.ts` | Tenant canonical subscription, usage, verified plan prices, Checkout / Billing Portal (`subscriptions:view` / `manage`; platform owner fenced out; `POST /subscriptions/upgrade` retired → 410) | Web (admin) |
| `/platform/subscriptions`, `/platform/billing` | `platform-billing.ts` | Platform-owner manual lifecycle (plan, trial, activate, past due, cancel, expire, suspend, reactivate, limits, convert-to-manual, sync) + provider status / price mappings | Web (platform) |
| `/billing/stripe/webhook` | `billing-webhook.ts` | Signed, idempotent Stripe webhook (raw body; mounted before the JSON parser) | Stripe |
| `/healthz`, `/readyz` | `health.ts` | Liveness / readiness | Infra |

---

## H. Web application map

`artifacts/web-app`. **Main router** — `src/App.tsx` using `wouter`; auth/public
pages are eager, portal pages are lazy-loaded via `React.lazy` + `Suspense`.
`ProtectedRoute` enforces role (`platform_owner` → `/platform`, everyone else →
`/admin`). The API client is wired at module load:
`setAuthTokenGetter(() => localStorage.getItem("csp_token"))`, and
`setOnUnauthorized` implements the 401 → `/api/auth/refresh` rotation.

- **Authentication shell / public pages** — `Login`, `ForgotPassword`,
  `ResetPassword`, `VerifyEmail`, `AcceptInvite`, `PublicCard` (`/c/:token`). Demo
  login buttons are **dev-gated** (`import.meta.env.DEV`).
- **Tenant admin shell** — `components/layouts/AdminLayout.tsx` wrapping all
  `/admin/*` pages (`src/pages/admin/`).
- **Platform Owner pages** — `components/layouts/PlatformLayout.tsx` +
  `src/pages/platform/`: `Dashboard`, `Companies`, `Users`, `Subscriptions`,
  `Analytics`, `Activity`, `AiIntelligence`, `Settings`.
- **Contact Workspace** — `admin/Contacts`, `ContactNew`, `ContactDetail`
  (+ `:tab`), `Duplicates`.
- **AI pages** — `AiCommandCenter` (`/admin/ai-command`), `Workflow`
  (`/admin/workflow`), `ExecutiveIntelligence` (`/admin/executive`), `SalesCopilot`
  (`/admin/ai-copilot`), `AiInsightsReview` (`/admin/ai-insights`),
  `BatchOperations` (`/admin/ai-batch`), `AiSettings` (`/admin/ai`).
- **Reports** — `admin/Reports`, `admin/Analytics`.
- **Notification Center** — `admin/Notifications` + the header bell.
- **Other admin** — leads/pipeline/tags/events/team/departments/teams/companies/
  directory/org-hierarchy/roles/organization/security/profile/subscription/settings/
  sessions/scan/documents/design-system.
- **Generated hooks** — all data access uses `@workspace/api-client-react` (Orval
  React Query hooks + fetch wrapper). TanStack Query config in `App.tsx`.

---

## I. Mobile application map

`artifacts/mobile` (Expo + Expo Router). Screens live in `app/`.

- **Expo Router structure** — root `app/_layout.tsx` (providers, API base-URL
  resolution, i18n/RTL); tab group `app/(tabs)/` with `_layout.tsx`.
- **Bottom navigation** — `(tabs)/_layout.tsx`: **Home** (`index`), **Scan**
  (`capture`), **Contacts** (`contacts`), **Follow-ups** (`followups`), **More**
  (`more`). iOS 26 uses native liquid-glass tabs (lazily required so Android never
  loads iOS-only native modules); other platforms use a classic tab bar.
- **More menu** — `(tabs)/more.tsx`: CRM group (contacts, companies, leads,
  follow-ups, meetings, tasks, events, duplicates), AI group (**AI Assistant only**),
  workspace (notifications, my card, my numbers, sync), settings (+ dev perf in dev).
- **Notification bell** — header bell → `notifications.tsx`.
- **Contact Workspace** — `contact/[id].tsx`, `contact/edit/[id].tsx`, plus
  `companies.tsx`/`company/[id].tsx`, `leads.tsx`, `duplicates.tsx`.
- **Sticky contact actions** — quick call/email/WhatsApp actions on the contact
  screen; email uses an OS mail-app chooser (no forced Gmail).
- **Capture modes** — `(tabs)/capture.tsx` hub → `capture-camera.tsx` (image OCR),
  `capture-qr.tsx` (QR / LinkedIn QR), `capture-nfc.tsx` (**NFC**),
  `capture-manual.tsx` (manual entry); email-signature paste is supported. Camera
  crop logic runs on-device before upload (produces `qualityScore`/`qualityMeta`).
- **Scan review** — `scan-review.tsx` (single) and `batch-review.tsx` (batch)
  present extracted fields + confidences for human confirmation before save.
- **Notifications / MFA login** — `notifications.tsx`; `login.tsx` +
  `forgot-password.tsx` (MFA challenge supported). Demo logins are dev-gated
  (`__DEV__`).
- **AI / others** — `assistant.tsx` (AI Assistant, retained), `card.tsx`/
  `my-numbers.tsx` (digital card), `sync.tsx` (offline queue), events/meetings/
  tasks/pipeline screens, `settings.tsx`.
- **API / environment configuration** — `app/_layout.tsx` resolves the API base URL
  from `EXPO_PUBLIC_API_URL` first, then `EXPO_PUBLIC_DOMAIN` (https:// prepended);
  it warns if neither is set. Build-time values live in `eas.json` (§M).
- **Permanently excluded mobile features** — full administration, mobile AI Command
  Center, mobile Workflow Intelligence, mobile Executive Intelligence (§A #5/#6).
  These removals must stay removed. **NFC and the AI Assistant stay.**

---

## J. AI and OCR architecture

**Gemini 2.5 Flash only.** `config.ai.model = "gemini-2.5-flash"` is the sole model;
OCR runs with `thinkingBudget: 0` for speed. There is exactly **one** AI system, one
OCR system, one email system, and one draft system — do not add a second of any.

**Enterprise AI Layer** — `artifacts/api-server/src/ai/`. Feature code never touches
the vendor SDK directly; it goes through this layer (barrel `ai/index.ts`).
`ai.service.ts` orchestrates every call: settings/budget enforcement, reservation,
rate limiting, dedup, provider call via `runner.ts`, and ledger recording.

- **Provider adapter** — `ai/providers/`: `gemini.ts` (real), `stub.ts`
  (deterministic), registered in `providers/index.ts`. The registry is a one-line
  add point; the stub is registered **only when `NODE_ENV !== production`** (and
  `AI_ENABLE_STUB !== "false"`) — never in production. The Gemini adapter calls
  `@workspace/integrations-gemini-ai` (lazy client — see §D).
- **Prompt files** — `ai/prompts.ts` holds a **versioned prompt registry**
  (`PROMPTS[feature] = { key, version }`); e.g. `card_extraction` is at **version 4**.
  Bumping a version keeps historical ledger attribution stable.
- **AI invocation metering** — every call writes one append-only `ai_invocations`
  row (feature, provider, model, prompt version, tokens, latency, status, confidence,
  `requestId` for idempotency). Non-provider outcomes are recorded too
  (`cache_hit`, `dedup_reused`, `budget_denied`, `rate_limited`).
- **Pricing versioning** — `config.ai.pricing` prices `gemini-2.5-flash` in
  micro-USD per 1k tokens for **cost visibility only (never billing)**;
  `pricingVersion` (`v1-2025-06-defaults`) is stamped on each ledger row so
  historical totals never change when prices are updated.
- **Budgets and reservations** — before each provider call a reservation
  (`ai_usage_reservations`, `config.ai.budget.reserveTokens`) counts toward the
  tenant month budget until finalize; abandoned reservations expire
  (`reservationTtlMs`) so a crash can never block a tenant permanently.
- **Rate limiting** — `config.ai.rateLimits`: fixed one-minute windows, per-user,
  per-tenant, and heavier per-user ceiling for heavy features (proposal/executive/
  meeting/call prep). System/platform calls fall into a shared keyed bucket — no
  caller bypasses protection.
- **Duplicate protection / caching** — `ai/dedup.ts` reuses a recent identical
  result (tenant+user+feature+prompt-hash) within a short TTL
  (`config.ai.dedup.resultTtlMs`); assistant conversations are **never** reused.
- **OCR validation & grounding rules** — deterministic validation runs on extracted
  fields (`lib/capture-validation.ts` / `capture-intelligence.service.ts`), and every
  AI surface follows the shared safety contract: recommend/draft from **real CRM data
  only**, **never auto-execute or write the source CRM**, deterministic grounded cores
  soft-degrade to best-effort AI phrasing (never a 500), and provenance is honest
  (deterministic rows never masquerade as AI). Full detail:
  [ai-architecture.md](ai-architecture.md).
- **Image privacy / restrictions** — card images are **private** GCS objects served
  only via short-lived signed URLs, tenant-scoped. AI calls carry only field values
  and safe entity linkage (type + numeric id), never raw content in ledger rows.
- **Live OCR verification** — `artifacts/api-server/scripts/verify-ocr-live.ts` is an
  **opt-in** script that calls live Gemini against OCR fixtures; normal test runs use
  the stub and never call live Gemini (§K).

---

## K. Testing and verification

**Test commands**

| Command | What it runs |
|---|---|
| `pnpm run typecheck` | Full typecheck across all packages (libs + `artifacts/**` + `scripts`) |
| `pnpm --filter @workspace/api-server run test` | API vitest (integration + unit) |
| `pnpm --filter @workspace/web-app run test:e2e` | Web e2e (Playwright `playwright test`) against a running server |
| `pnpm --filter @workspace/mobile run test` | Mobile vitest (`vitest run`) |

- **Required server restart before integration tests** — the API suite runs against
  the **live** API (the api-server workflow must be running and seeded with demo
  tenants); restart/seed before a full run. Detail in
  [LOCAL_AND_STAGING_RUNBOOK.md](LOCAL_AND_STAGING_RUNBOOK.md).
- **Current totals (Batch 20)** — API **1153** tests (1116 passed / 9 failed /
  28 skipped without object storage — the failures are the documented
  storage-gated subset), Playwright **142/142**, mobile **114/114**, all
  typechecks clean.
- **Playwright setup** — `artifacts/web-app/playwright.config.ts` resolves a Nix-store
  chromium via `executablePath` (newest `-playwright-browsers-chromium` build);
  override with `PW_CHROMIUM_PATH`; target with `E2E_BASE_URL` (default
  `http://localhost:80`). Spec files in `e2e/` (`a-…` … `x-billing.spec.ts`).
- **Stub-provider behavior** — the deterministic stub provider (`ai/providers/stub.ts`)
  is registered only outside production; a tenant opts in via `PATCH /ai/settings`.
  It exercises usage accounting, budgets, rate limits, and dedup **without** live
  Gemini calls — this is how normal tests avoid live Gemini.
- **Live Gemini verification** — run `verify-ocr-live.ts` deliberately when you need
  to confirm real OCR; it is never part of the standard suite. Do not call live
  Gemini unnecessarily.
- **Mobile unit-test limitations** — vitest covers logic/units; native features
  (NFC, camera, push, contacts) must be validated on an Expo dev build or a native
  APK/TestFlight build — **not Expo Go**.
- **Physical-device checklist** — the last full device pass was **Honor Magic V5,
  Android 16** (all capture modes incl. NFC). Never claim provider or device
  verification unless it was actually performed.

---

## L. Local setup (summary)

Full step-by-step instructions — first startup, DB setup, per-package start,
typechecks, all test suites, OCR live verification, connecting mobile to staging,
common errors, and safe shutdown/restart — are in
**[LOCAL_AND_STAGING_RUNBOOK.md](LOCAL_AND_STAGING_RUNBOOK.md)**. The authoritative
environment contract (every variable, required vs optional, per-package, with fake
placeholders) is the root **[`.env.example`](../.env.example)**; the exact
post-export replacement map is
[PORTABLE_ENVIRONMENT_SETUP.md](PORTABLE_ENVIRONMENT_SETUP.md).

Quick reference (real project commands):

```bash
# Prereqs: Node.js 24, pnpm 10.26.x (packageManager pin), PostgreSQL.
pnpm install                                            # install workspace deps
cp .env.example .env                                    # then fill DATABASE_URL + SESSION_SECRET (required)
pnpm --filter @workspace/db run push                    # sync schema (drizzle-kit push; NO SQL migrations)
pnpm --filter @workspace/scripts run seed-demo          # seed demo tenants + demo logins
pnpm --filter @workspace/api-server run dev             # start API (port 5000 → proxied at /api)
pnpm --filter @workspace/web-app run dev                # start web (Vite dev server)
pnpm --filter @workspace/mobile run dev                 # start mobile (Expo)
pnpm run typecheck                                       # all typechecks
pnpm --filter @workspace/api-server run test             # API suite (server must be running + seeded)
pnpm --filter @workspace/web-app run test:e2e            # web Playwright e2e (server must be running)
pnpm --filter @workspace/mobile run test                 # mobile vitest
pnpm run build                                           # typecheck + build all packages
```

Only `DATABASE_URL` and `SESSION_SECRET` are strictly required to boot the API;
everything else degrades gracefully.

---

## M. Staging and production topology

- **Hosting / staging** — staging is **this Repl, published** at
  `https://contact-aggregator--DelowarHossain1.replit.app` (Replit Publish). The
  same host serves the API (`/api`) and the built web app.
- **Mobile → staging** — that staging URL is **baked into `artifacts/mobile/eas.json`**
  as `EXPO_PUBLIC_API_URL` for both the `preview` and `production` EAS profiles, so
  APKs built from those profiles talk to staging out of the box. Mobile APKs ship via
  the **EAS `preview`** profile (internal-distribution APK). For local mobile dev
  against staging, set `EXPO_PUBLIC_API_URL` to the staging URL (or
  `EXPO_PUBLIC_DOMAIN`).
- **Production topology** — the app is portable: the API needs standard env vars
  (`DATABASE_URL`, `SESSION_SECRET`, optional Gemini/SMTP/GCS/push) supplied via a
  local `.env`, shell, CI secret store, or a hosting provider's secret store — **no
  Replit Secrets dependency and no Replit-only runtime behavior are required.**
  Provider-specific-but-optional pieces: the Replit object-storage sidecar and the
  Replit AI-integration proxy pair (both auto-detected and replaceable by standard
  Google/Gemini credentials). See
  [PORTABLE_ENVIRONMENT_SETUP.md](PORTABLE_ENVIRONMENT_SETUP.md) and
  [deployment.md](deployment.md).
- **Manual deployment tasks** — publishing the Repl / running an EAS build are manual
  and were **not** performed as part of export-readiness (no APK build, no deploy).

---

## N. Future-development guardrails

Hard rules for anyone extending this project:

- **Work one approved batch at a time.** Do not begin Batch 9 or any new business
  feature until it is explicitly approved. Do not add unnecessary features or
  abstractions.
- **`gemini-2.5-flash` only.** No other model, and **no direct Gemini calls** — every
  AI call must go through the Enterprise AI Layer (`src/ai/`). Never bypass metering,
  budget admission, rate limiting, or dedup.
- **No second system of anything** — no second AI provider system, no second email
  system, no second OCR system, no second draft/generation system. Extend the single
  existing seam instead.
- **Keep NFC.** NFC (and every other capture mode) is retained; do not remove it.
- **Mobile scope removals stay removed** — no full mobile administration, no mobile AI
  Command Center, no mobile Workflow Intelligence, no mobile Executive Intelligence,
  no Contact AI on mobile. The mobile AI Assistant is the only mobile AI surface and
  stays. Also honor the other permanent removals in §A (Customer Portal, Custom
  Domains, Public Developer Platform, Generic Integration Marketplace).
- **Schema changes via `drizzle-kit push`** — edit `lib/db/src/schema/*.ts` and run
  `pnpm --filter @workspace/db run push`. There are no versioned SQL migrations; do
  not introduce a parallel migration system.
- **Single env access point** — all `process.env` reads for the API go through
  `artifacts/api-server/src/config.ts`. Do not scatter `process.env` reads across the
  codebase; add new config there. (Gemini credential resolution is centralized in
  `config.ai.gemini` and the lazy client.)
- **Tenant-scoping invariants** — never scope a tenant read by `companyId` alone;
  always use `tenantScope`. Validate FK references on writes with `refAccessible` /
  `refInCompany`. Cross-tenant access returns **404**, not 403.
- **RBAC invariants** — `platform_owner`/`primary_admin` bypass write-permission
  checks; `admin`/`employee` are gated by the `permissions` matrix on writes
  (deny-by-default when empty). Never allow role escalation.
- **AI safety** — recommend/draft only; **never auto-execute or auto-send**
  AI-generated communication; keep provenance honest.
- **Test integrity** — never use production customer data in tests; never claim
  provider or device verification unless it was actually performed.
