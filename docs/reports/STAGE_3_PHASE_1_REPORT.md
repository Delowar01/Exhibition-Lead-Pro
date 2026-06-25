# Stage 3 — Phase 1: Organizational Foundation — Completion Report

**Status:** Complete — ready for review.
**Scope:** Additive only. No breaking API/DB changes. All existing functionality preserved.
**Validation:** Full typecheck green across all packages; full test gate green — **16 files, 250 tests passing** (incl. 22 new `org-foundation` tests).

## What shipped

Foundational organizational structure for the Company Admin portal, designed to be the
base layer for later enterprise modules (performance dashboards, targets, approvals,
ownership/assignment, analytics).

### 1. Departments
- New `departments` table (self-referencing parent for sub-departments, optional head).
- Full CRUD + archive/restore (soft-delete). Tenant-scoped reads, cross-tenant access
  returns 404. Enriched responses (head name, parent name).
- Admin page: `/admin/departments`.

### 2. Teams
- New `teams` table (belongs to a department, optional team leader/manager).
- Full CRUD + archive/restore + member assignment (with live member count).
- Admin page: `/admin/teams` with a manage-members dialog.

### 3. Employee org profiles
- `users` extended (additive, non-breaking) with: `employeeId`, `jobTitle`,
  `employmentStatus` (default `active`), `joiningDate`, `managerId` (reporting manager,
  self-ref), `departmentId`, `teamId`.
- Editable from the existing team-member edit flow via an "Org Profile" dialog.
- Per-company partial-unique on `employeeId` (where not null).

### 4. Employee Directory
- `GET /users/directory` — tenant-scoped, filter (department/team/manager/status/role),
  sort, paginate; enriched with department/team/manager names.
- Admin page: `/admin/directory`.

### 5. Org Hierarchy
- `GET /users/hierarchy` — reporting-manager tree (roots + nested reports).
- Admin page: `/admin/org-hierarchy`.

## Architecture & convention adherence

- **Contract-first:** OpenAPI spec → Orval codegen → React Query hooks + Zod schemas.
- **Tenant isolation:** `tenantScope` on every list/read; cross-tenant access → 404.
- **FK validation on writes:** parent department, department, leader, manager, and
  team members are all validated. Org-profile FKs (`managerId`/`departmentId`/`teamId`)
  are validated against the **target user's company** (see fix below), not merely
  caller reach.
- **Guards:** path-scoped terminating guards (`requireTenantUser`,
  `blockReadOnlyMutations`, `auditMutations`, `requirePermission`) on the shared parent
  router; static sub-paths (`/users/directory`, `/users/hierarchy`) registered before
  `/users/:id`.
- **Permissions:** new `departments` and `teams` permission modules added to the
  catalog. Org-data reads are gated by `view` (consistent with the existing `users`/
  `team` module — org/people data is not openly readable), writes by
  create/edit/delete. No role/privilege escalation.
- **PATCH empty-set guard:** returns 400 (not a 500) on an empty body.
- **Date-only:** `joiningDate` stored/served as a plain `YYYY-MM-DD` string.

## Code review outcome

An architect review flagged one critical issue, now **fixed and tested**:

- **Cross-tenant org-FK assignment (broken access control):** org-profile FK validation
  used a caller-scoped check (`refAccessible`), which lets a `platform_owner` (or any
  multi-company-access caller) bind a user in company A to a manager/department/team in
  company B. Fixed by adding a target-company-scoped helper `refInCompany(table, cid,
  id)` and using it for `managerId`/`departmentId`/`teamId`. New regression test drives
  the platform-owner cross-tenant path and asserts 400.

The `employmentStatus` NOT-NULL-with-default note was reviewed and retained: the plan
explicitly specified `default 'active'`, and a NOT NULL DEFAULT column is non-breaking
(existing rows backfill via the default).

## Verification summary

| Check | Result |
|---|---|
| `pnpm run typecheck` (all packages) | green |
| `pnpm --filter @workspace/api-server run test` | 16 files / 250 tests passing |
| New `org-foundation` suite | 22 tests passing |
| Curl smoke (T003): dept/team CRUD, cross-tenant 404, FK 400, archive/restore, member assign, directory, hierarchy | all pass |

## New / changed surface

- DB: `lib/db/src/schema/{departments,teams,users}.ts`
- Spec: `lib/api-spec/openapi.yaml` (+ regenerated client/zod)
- API: `routes/{departments,teams}.ts`, `services/{departments,teams}.service.ts`,
  `repositories/{departments,teams}.repository.ts`; extended `routes/users.ts` +
  `services/users.service.ts`; `lib/tenant.ts` (`refInCompany`).
- Web: `pages/admin/{Departments,Teams,Directory,OrgHierarchy}.tsx`; extended
  `Team.tsx`; routes in `App.tsx`; nav in `AdminLayout.tsx`.
- Tests: `test/org-foundation.test.ts`.
