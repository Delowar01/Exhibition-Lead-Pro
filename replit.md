# Card Scanner Pro

An enterprise SaaS platform for business card scanning and lead management. Two portals: a Platform Owner portal for managing all tenant companies, and a Company Admin portal for managing contacts, leads, events, and team members.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000 → proxied at /api)
- `pnpm run typecheck` — full typecheck across all packages
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
- **Admin Portal** (`/admin`): scan business cards (OCR simulation), manage contacts, qualify leads through Kanban pipeline, track events, manage team, view reports

## Demo credentials

| Role | Email | Password |
|---|---|---|
| Platform Owner | admin@cardscannerpro.com | Admin123! |
| Company Admin (TechCorp) | admin@techcorp.com | Admin123! |
| Company Admin (Nexus) | admin@nexussys.io | Admin123! |
| Company Admin (Innovatech) | admin@innovatech.es | Admin123! |

Quick demo login buttons are available on the login page.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

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
- **No role escalation**: a caller may never create/promote a user to a role ranked higher than their own (employee<admin<primary_admin<platform_owner). Enforced in POST + PATCH `/users`.
- **Tenant invariant**: `requireAuth` 403s non-platform users with empty `accessibleCompanies`; `POST /users` 400s non-platform roles with null company.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
