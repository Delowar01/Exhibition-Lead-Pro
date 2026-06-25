# Stage 3 — Phase 2: Executive Dashboards & Analytics — Completion Report

**Status:** Complete — ready for review.
**Scope:** Additive only. No DB changes, no breaking API changes. All existing functionality preserved (existing Dashboard untouched).
**Validation:** Full typecheck green across all packages; full test gate green — **17 files, 269 tests passing** (incl. the new `analytics` suite).

## What shipped

A real-time performance view for every organizational level — company → department →
team → employee — built entirely on **existing** data (leads, contacts, scans, events,
activity) plus the Phase 1 org structure. No new tables; read-only aggregations.

### 1. Analytics API (5 new GET endpoints)
All tenant + org scoped, view-gated via `reports:view`, served through the analytics
micro-cache (30s):
- `GET /analytics/overview` — company-wide (whole accessible tenant).
- `GET /analytics/department?id=` — department-scoped (incl. descendant departments).
- `GET /analytics/team?id=` — team-scoped.
- `GET /analytics/employee?id=` — single-employee scoped.
- `GET /analytics/scope-options` — the departments/teams/employees the caller may drill
  into (powers the filter dropdowns).

The four scoped endpoints return one shared `ScopedAnalytics` shape: KPIs, period-over-
period deltas, gap-filled daily trend, pipeline funnel, source mix, top performers,
recent activity, and headcount. Date range via `?dateFrom=&dateTo=` (`YYYY-MM-DD`),
defaulting to the last 30 days.

### 2. Web Executive Dashboard (`/admin/analytics`)
New `pages/admin/Analytics.tsx`: scope selector (Company/Department/Team/Employee) +
date-range filter, KPI cards with delta pills, trend area chart, funnel, source mix, top
performers, and an activity feed. Uses generated React Query hooks. New route + nav item;
the existing Dashboard is untouched.

### 3. Mobile "My Numbers"
New `app/my-numbers.tsx`: condensed personal performance screen reusing
`/analytics/employee` (me) with a team toggle for team leaders. KPI grid with delta pills,
funnel, top performers, recent activity. EN + AR i18n parity; degrades gracefully.

## Architecture & convention adherence

- **Contract-first:** OpenAPI spec → Orval codegen → React Query hooks + Zod schemas.
  Scoped endpoints use an `id` **query** param (not a path param) to keep one shared
  response schema and avoid codegen path/query-name collisions.
- **Tenant isolation:** every aggregation uses `tenantScope(...)`; no `companyId`-only
  scoping (which would produce an unfiltered cross-tenant query on a null company).
- **Scope authorization** (in `analytics.service.ts`, on top of the `reports:view` gate):
  - `primary_admin`/`admin` → any scope within the tenant.
  - `employee` → own employee scope; own team **iff** `team.leaderId === self`; own
    department **iff** `dept.headId === self`; company overview → **403**.
  - `platform_owner` → blocked from tenant business analytics by `requireTenantUser`.
  - Cross-tenant department/team/employee lookups → **404** (tenant-scoped lookups).
- **Cross-currency correctness:** lead values are grouped by currency in SQL, then each
  bucket is converted via `convertCurrency(bucket, cur, "USD")` **before** summing — raw
  mixed-currency values are never summed.
- **Cache:** reuses the analytics micro-cache (30s); key includes `userId` (no cross-user
  leak) and the global `writeEpoch` busts it on any successful write.
- **Guards & routing:** `requireAuth` + path-scoped `requireTenantUser` +
  `requirePermission("reports","view")` + `microCache`; static `/overview` and
  `/scope-options` registered before the parametrized scoped routes; guards path-scoped to
  the `/analytics` base to avoid the router-level guard leak.
- **Honest deltas:** `pipelineValue` is a point-in-time snapshot with no historical
  baseline, so its delta is `null` (not fabricated).

## Code review outcome

An architect review confirmed the API surface, guarding, scope authorization, tenant
isolation, cross-currency math, and cache reuse are correct, and flagged one issue, now
**fixed and tested**:

- **`topPerformers[].leads` mislabeled (analytics correctness):** the per-user "leads"
  metric was populated from a **contact** count (`contactCountsByUser`) rather than a
  lead count, making the metric semantically wrong and able to mis-rank performers. Fixed
  by adding a true `leadCountsByUser` repository query (leads grouped by `assignedToId`
  over the window, tenant-scoped, not-deleted) and wiring it into the assembly. The
  `analytics` test now seeds distinct lead vs contact counts and asserts
  `topPerformers[].leads`/`.won` and the leads-desc ranking.

## Verification summary

| Check | Result |
|---|---|
| `pnpm run typecheck` (all packages) | green |
| `pnpm --filter @workspace/api-server run test` | 17 files / 269 tests passing |
| New `analytics` suite | passing (permission gate, manager aggregation, cross-currency total, employee scope authorization, team-lead/dept-head access, cross-tenant 404, validation, cache invalidation, top-performer lead counts) |
| Curl smoke (T002): overview, each scope, scope-options, isolation | all pass |

## New / changed surface

- Spec: `lib/api-spec/openapi.yaml` — `ScopedAnalytics` + `AnalyticsScopeOptions` schemas
  + the 5 endpoints (+ regenerated client/zod).
- API: `routes/analytics.ts`, `services/analytics.service.ts`,
  `repositories/analytics.repository.ts`; mounted in `routes/index.ts`.
- Web: `pages/admin/Analytics.tsx`; route in `App.tsx`; nav in `AdminLayout.tsx`.
- Mobile: `app/my-numbers.tsx`; `Stack.Screen` in `app/_layout.tsx`; nav entry in
  `app/(tabs)/more.tsx`; EN/AR keys in `lib/i18n/locales/{en,ar}.json`.
- Tests: `test/analytics.test.ts`.
