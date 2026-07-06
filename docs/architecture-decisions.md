# Architecture Decisions (living)

The load-bearing runtime decisions that govern day-to-day development: the
contract-first pipeline, role hierarchy, the `company_id` tenant boundary, auth,
the permissions matrix, and the subscription/plan model. These are the "why it is
this way" notes that must stay consistent across changes.

**See also:** [`architecture.md`](architecture.md) for the Stage-1 current-vs-
recommended architecture review, [Security & Privacy](security-and-privacy.md)
for the enforcement rules that back these decisions, and
[AI Architecture](ai-architecture.md) for the shared AI contract.

## Decisions

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
