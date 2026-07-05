# Stage 4 — Phase A: CRM Data Foundation — Completion Report

**Status:** Complete — ready for review.
**Scope:** Additive only. No breaking API or response changes. All existing functionality preserved.
**Validation:** Full typecheck green across all packages; full regression gate green — **18 files, 306 tests passing** (run against a freshly-restarted api-server, split into two batches per the login-limiter gotcha). Architect code review: **PASS**, no severe correctness/security findings.

## What shipped

The data-layer foundation for enterprise CRM: user-defined custom fields on contacts and
leads, sales territories, a formal merge-history audit trail, and an acquisition `source`
attribute. Everything is tenant-scoped, permission-gated, and contract-first.

### 1. Custom fields (definitions + values)
- New `custom_field_definitions` and `custom_field_values` tables (polymorphic on
  `entityType` = `lead` | `contact`).
- Definition CRUD: `GET/POST /custom-fields/definitions`, `PATCH/DELETE
  /custom-fields/definitions/:id`. Ten field types validated per-type; `fieldKey` unique
  per `(company, entityType)` among live rows (409 on conflict); `fieldKey`/`entityType`
  immutable on update; soft delete cascades to that definition's values in a transaction.
- Value read/write per entity:
  - `GET/PUT /contacts/:id/custom-fields`
  - `GET/PUT /leads/:id/custom-fields`
  - The contacts/leads service tenant-verifies the parent record via `findById` first, then
    delegates to `custom_fields.service` with the resolved `companyId` and a fixed
    `entityType`. Values are validated against their definition and upserted (or cleared on
    null) in one transaction; duplicate `definitionId`s are rejected.

### 2. Territories
- New `territories` table with `assignedToId` (user) and `teamId` owners.
- CRUD: `GET/POST /territories`, `PATCH/DELETE /territories/:id`. Cross-tenant FK binding is
  guarded with `refInCompany` (target-company-scoped), not caller-scoped `refAccessible`.

### 3. Merge history
- New `merge_history` table (append-only audit of contact merges).
- `GET /contacts/merge-history` — tenant-scoped, newest-first, paginated (`page`/`limit`),
  resolves `performedByName` and parses `mergedIds`/`fieldChoices` JSON.
- The history row is written **inside** `mergeTransaction`, atomically with the merge:
  scans/leads are reassigned to the primary, the primary is updated, merged-away duplicates'
  custom-field values are deleted, the history row is inserted (with a pre-merge snapshot of
  primary + duplicates and the applied field choices), then the duplicates are hard-deleted.

### 4. `source` attribute
- Additive `source` column on contacts and leads (acquisition source: event / referral /
  website / import). Threaded through create + update inputs and the insert/update payloads.
- No response-shape change: `formatContact`/`formatLead` spread the row, so `source` is
  surfaced automatically.

## Architecture & convention adherence

- **Contract-first:** OpenAPI spec → Orval codegen → React Query hooks + Zod schemas.
  Delete endpoints return the shared `SuccessResponse`. Codegen re-ran green.
- **Additive statuses:** `"archived"` added to six status/stage enums without removing any
  existing value.
- **Tenant isolation:** all list/read queries use `tenantScope`/`tenantOnly`; no
  `companyId`-only scoping. Entity mutations resolve the parent via tenant-scoped `findById`
  before writing.
- **RBAC & routing:** new sub-routers use `requireAuth` + path-scoped terminating guards
  (`requireTenantUser`, `blockReadOnlyMutations`, `auditMutations`) plus `requirePermission`
  on writes — path-scoped to each module base to avoid the router-level guard leak.
  `PERMISSION_CATALOG` gained `custom_fields` and `territories` modules. Static
  `/contacts/merge-history` is registered before `/contacts/:id`.
- **Cross-tenant FK safety:** `refInCompany` for binding a record to another record's tenant
  (territory owners); `refAccessible` for caller-scoped checks.
- **PATCH empty-set guards** intact on all new definition/territory updates (400, not 500).
- **No fabricated data:** all reads derive from real rows; merge-history snapshots are
  captured from live records at merge time.

## Follow-ups (optional, non-blocking)
- Document `page`/`limit` query params for `/contacts/merge-history` in the OpenAPI spec so
  generated clients expose pagination explicitly.
- Add focused integration tests for the cross-tenant custom-field set/get denial path and
  merge-transaction atomicity (history row + value cleanup + FK reassignment).
