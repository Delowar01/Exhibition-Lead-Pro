# Card Scanner Pro

An enterprise SaaS platform for business card scanning and lead management. Two portals: a Platform Owner portal for managing all tenant companies, and a Company Admin portal for managing contacts, leads, events, and team members.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000 → proxied at /api)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-server run test` — integration + unit tests (vitest, run against the LIVE API at localhost:80 + seeded demo tenants; api-server workflow must be running). **Pre-merge gate** (registered as the `test` validation alongside `typecheck`): a clean run is fully green (unit-lib, audit, api-standardization, auth-security, contacts-ai, health-errors, jobs, phase24/25, repositories-softdelete, services). Run it before merging any Stage-2 change.
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — JWT signing key

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React 19 + Vite + Tailwind CSS + shadcn/ui
- Auth: JWT stored as `csp_token` in localStorage; `setAuthTokenGetter` wires it to all API calls

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/db/src/schema/index.ts` — Drizzle ORM schema (companies, users, events, contacts, leads, scans, subscriptions, activity_logs)
- `lib/api-client-react/src/` — Orval-generated React Query hooks + custom fetch wrapper
- `artifacts/api-server/src/routes/` — Express route handlers (auth, companies, users, contacts, leads, events, scans, subscriptions, platform, reports)
- `artifacts/web-app/src/pages/platform/` — Platform Owner portal pages
- `artifacts/web-app/src/pages/admin/` — Company Admin portal pages
- `artifacts/web-app/src/contexts/AuthContext.tsx` — auth state management

## Architecture decisions

- Contract-first: OpenAPI spec → Orval codegen → React Query hooks + Zod schemas
- Role hierarchy (Phase 0): `platform_owner` → `primary_admin` → `admin` → `employee`. `platform_owner` → `/platform`; everyone else → `/admin`. (Was `company_admin`→`primary_admin`, `team_member`→`employee`.)
- `company_id` IS the tenant boundary — no separate `tenant_id`. All tenant-scoped queries filter by `company_id`; cross-tenant access returns 404 (not 403) to avoid leaking record existence.
- JWT auth (not session cookies) since the API may serve a mobile client in future
- `requireAuth` loads the FRESH user row each request (role, permissions, status) instead of trusting the JWT payload, and enforces the subscription lifecycle (see Subscription lifecycle below)
- Permissions: `platform_owner`/`primary_admin` bypass all permission checks; `admin`/`employee` are gated by an explicit `permissions` matrix (`module -> [actions]`) on writes only (reads stay open but tenant-scoped). Empty `{}` = deny-by-default on writes.
- `setAuthTokenGetter` in `@workspace/api-client-react` injects the Bearer token globally — no per-call headers needed
- Subscription plans live in the `plans` table (keyed by slug: free/starter/professional/business/enterprise) with feature flags + limits; per-company limits live on `subscriptions` (seeded from plan defaults, platform-owner overridable; `null` limit = unlimited). Enforced server-side, not hardcoded.
- Subscription lifecycle (on `companies.status`): `suspended`/`expired`/lapsed `trial` → login blocked (403); `cancelled` → read-only (writes 403, reads OK); `active`/valid `trial` → full access. Logic in `evaluateCompanyAccess`.
- `audit_logs` is append-only (no delete route, no cascade FK). `auditMutations(module)` router middleware records one row per successful non-GET request; `writeAudit` for explicit events (login etc.).

## Product

- **Platform Portal** (`/platform`): view all tenant companies, manage subscriptions, see platform-wide analytics, user management
- **Admin Portal** (`/admin`): scan business cards (real AI OCR), manage contacts, qualify leads through Kanban pipeline, track events, manage team, view reports, AI contact enrichment, duplicate detection + merge (`/admin/duplicates`)
- **Org structure** (Stage 3 Phase 1): Departments (`/admin/departments`, self-ref parent + head), Teams (`/admin/teams`, belongs-to-department + leader + members), expanded employee org profiles (`employeeId`/`jobTitle`/`employmentStatus`/`joiningDate`/`managerId`/`departmentId`/`teamId`), Employee Directory (`/admin/directory`, `GET /users/directory`), and Org Hierarchy (`/admin/org-hierarchy`, `GET /users/hierarchy`). All tenant-scoped + additive. Org-data reads are `view`-gated (like the `users`/`team` module), not open.
- **Executive Dashboards & Analytics** (Stage 3 Phase 2): real-time performance view per org level. Web `/admin/analytics` (scope selector company/department/team/employee + date range); mobile "My Numbers" (`/my-numbers`, own scope + team toggle for leaders). 5 read-only GET endpoints (`/analytics/overview`, `/analytics/department?id=`, `/analytics/team?id=`, `/analytics/employee?id=`, `/analytics/scope-options`) returning a shared `ScopedAnalytics` shape. `reports:view`-gated, tenant-scoped, cross-currency-correct, served via the analytics micro-cache. Scope privacy: employee sees own only; team lead sees own team; dept head sees own dept; company overview is manager-only. No DB changes (aggregations over existing leads/contacts/scans).
- **Enterprise AI Sales Copilot** (Stage 5B): generates reviewable DRAFT sales artifacts from real CRM data — 8 output types (email, whatsapp, call_prep, meeting_prep, proposal, followup, coaching, summary) over 4 entity types (lead, contact, organization, business_card) via an APPLICABLE matrix (`services/ai-copilot.service.ts`). NEVER auto-sends and NEVER auto-writes the CRM — every output is a draft the user must explicitly copy/use. `followup`/`coaching` always produce a grounded DETERMINISTIC core (conf 100), with best-effort AI phrasing layered on top (source flips to `ai` only when the LLM succeeds); the other 6 are LLM-only and SOFT-DEGRADE to HTTP 200 with `content.unavailable` (never 500). Every output carries full provenance (source/provider/model/promptKey/promptVersion) and deterministic rows never masquerade as AI. Endpoints under `/ai/copilot` (`ai_copilot` module: view/generate/use), path-scoped guards mirror `/ai/insights` (tenant-only, read-only-blocked, audited). Web: `SalesCopilotPanel` on Contact/Lead/Company detail + `/admin/ai-copilot` review page + batch in BatchOperations. Mobile: `CopilotSection` on contact/pipeline detail + EN/AR i18n + expo-clipboard copy. Batch (`services/ai-copilot-batch.service.ts`) is an in-process tenant-scoped job queue (202 + poll).
- **AI Engine** (`src/lib/ai.ts`): `extractCardData` (OCR + bilingual), `scoreLead` (score/temperature/reasoning), `enrichContact` (industry/seniority/summary/talking points), plus the Copilot generators (compose email/whatsapp, call/meeting prep, proposal, summary, followup/coaching phrasing). Dedup detection + merge live in `routes/contacts.ts`.

## Demo credentials

| Role | Email | Password |
|---|---|---|
| Platform Owner | admin@cardscannerpro.com | Admin123! |
| Company Admin (TechCorp) | admin@techcorp.com | Admin123! |
| Company Admin (Nexus) | admin@nexussys.io | Admin123! |
| Company Admin (Innovatech) | admin@innovatech.es | Admin123! |

Quick demo login buttons are available on the login page.

## User preferences

- App footer branding reads "Powered by Elite Marcom".
- Email actions on mobile must let the OS pick the mail app (no forced Gmail).
- No fabricated/mocked data — derive insights from real API data, and prefer honest flows (e.g. forgot-password says "contact admin" rather than faking a reset API).
- Native mobile features (NFC, background processing, contacts, notifications, location, etc.) must be validated on an Expo Development Build or native APK/TestFlight build — NOT Expo Go. Native module code must degrade gracefully on web/Expo Go. EAS build profiles live in `artifacts/mobile/eas.json` (`development` dev-client APK, `preview` internal APK, `production`).

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml`
- Run `pnpm --filter @workspace/db run push` after schema changes
- `??` and `||` mixed without parens fails esbuild — always wrap: `(a ?? b) || c`
- API routes must include full base path (`/api/...`) — the reverse proxy does NOT strip it
- **Router-level guard leak**: sub-routers are mounted path-less on one shared parent (`routes/index.ts`), and each route defines its own full path. A path-less `router.use(mw)` in a sub-router runs for EVERY request flowing through the parent. Terminating guards (`requireRole`, `auditMutations`) MUST be path-scoped to the module base, e.g. `router.use("/contacts", auditMutations("contacts"))` — otherwise they fire on unrelated routes (403s, duplicate audit rows). `requireAuth` is non-terminating so path-less is fine.
- `@types/express-serve-static-core` v5 types `req.params[key]` as `string | string[]` — wrap path params: `parseInt(String(req.params.id))`
- Do NOT use `pnpm run dev` at workspace root — workflows handle port + env injection
- **esbuild externalizes some packages** (`build.mjs` `external` globs, e.g. `@google/*`) — a package matching those globs that is only a transitive dep (via a `@workspace/*` lib) must ALSO be a direct dependency of `api-server`, else runtime fails with `ERR_MODULE_NOT_FOUND`
- **Body-parser limit**: `express.json`/`urlencoded` are raised to `15mb` in `app.ts` for base64 card images — a too-small limit surfaces as HTTP 413 on `POST /scans`
- AI (Gemini) calls in `src/lib/ai.ts` are timeout-bounded (`withTimeout`); `/scans` 502s on OCR failure, contact creation degrades to null lead score on AI failure
- **Date-only columns** (e.g. `contacts.followUpDate`, a Drizzle `date`) are plain `YYYY-MM-DD` strings — format them with `parseISO(s)` (NOT `new Date(s)`, which parses as UTC midnight and renders the prior day in negative-offset TZs). For "today" comparisons use `format(new Date(), "yyyy-MM-dd")` and string-compare; both sides are local-date strings.
- **Never scope a tenant read by `companyId` alone** — a null `companyId` produces an UNFILTERED cross-tenant query. Use `tenantScope(req.user, table.companyId)` (in `requireAuth.ts`) on every list/report/stats/pipeline query: it returns no filter for `platform_owner` and `inArray(column, accessibleCompanies)` for everyone else.
- **Validate FK refs on writes** with `refAccessible(req.user, table, id)` (in `lib/tenant.ts`) — reject cross-tenant/nonexistent `eventId`/`assignedToId`/`contactId` with 400, or a user can point own-tenant rows at foreign records and leak metadata via enrichment.
- **Caller-scoped vs tenant-scoped FK check**: `refAccessible(caller, …)` is CALLER-scoped (passes for any company the caller can reach — a `platform_owner` passes for ALL). When binding a record to ANOTHER record's tenant (e.g. a user's `managerId`/`departmentId`/`teamId` into the target user's company `cid`), use `refInCompany(table, cid, id)` instead — it requires the FK row's company === `cid`. Single-tenant admin tests can't see the gap; always cover the platform-owner cross-tenant path.
- **No role escalation**: a caller may never create/promote a user to a role ranked higher than their own (employee<admin<primary_admin<platform_owner). Enforced in POST + PATCH `/users`.
- **Tenant invariant**: `requireAuth` 403s non-platform users with empty `accessibleCompanies`; `POST /users` 400s non-platform roles with null company.
- **Static sub-paths before `/:id`**: routes like `GET /contacts/duplicates` and `POST /contacts/merge` MUST be registered before `GET/PATCH/DELETE /contacts/:id` (Express + wouter match in declaration order) or `:id` swallows them. Same applies to the `/admin/duplicates` web route vs `/admin/contacts/:id`.
- **Contact merge FKs**: contacts are referenced ONLY by `scans.contactId` + `leads.contactId` (both onDelete set null). Merge must reassign both to the primary inside one transaction before deleting dups, or surviving scans/leads get orphaned (null contactId).
- **Test-suite reruns need a server restart**: the per-IP login limiter (`loginRateLimiter`, max 20 FAILED logins / 15-min window) lives in the running server's memory. A single full `test` run stays under the cap and is green, but two back-to-back full runs against the SAME running server accumulate the brute-force/invalid-cred failures past 20 → valid logins start returning 429. Restart the api-server workflow before re-running the full suite (the gate run must hit a freshly-started server).

## Pointers

- See [`docs/`](docs/README.md) for the full architecture review, logical structure map, technical-debt register, and developer/API/deployment guides. Historical QA/release/verification reports live under [`docs/reports/`](docs/reports/README.md).
- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
