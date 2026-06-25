---
name: Caller-scoped vs tenant-scoped FK validation
description: When validating a foreign key that binds a record to ANOTHER record's tenant, use a target-company-scoped check, not a caller-accessible check.
---

# Caller-scoped vs tenant-scoped FK checks

There are two distinct FK-validation questions on writes, and they are NOT
interchangeable:

1. **Can the caller reach this row?** → `refAccessible(caller, table, id)`
   (caller-scoped: passes if the FK row's company is in the caller's
   `accessibleCompanies`; a `platform_owner` passes for EVERY company).
2. **Does this FK belong to the specific tenant I'm binding it into?** →
   `refInCompany(table, companyId, id)` (target-company-scoped: passes only if the
   FK row's company === the target record's company).

**The rule:** when you assign a foreign key that points one record at another
record's tenant (e.g. setting a user's `managerId` / `departmentId` / `teamId`, where
the target user lives in company `cid`), validate with `refInCompany("...", cid, id)`,
NOT `refAccessible`.

**Why:** `refAccessible` only checks caller reach. A `platform_owner` (or any
multi-company-access caller) can reach every tenant, so a caller-scoped check would
happily let them point company A's user at company B's department/team/manager —
silently corrupting the tenant boundary for org data. The check must be anchored to
the *target record's* company, not the caller's reach. A normal single-company
`primary_admin` sees identical behavior either way (their reach == their company), so
this gap is invisible until a platform-owner / multi-company caller exercises it — and
invisible to tests that only drive a single-tenant admin.

**How to apply:**
- `refInCompany` lives in `artifacts/api-server/src/lib/tenant.ts` alongside
  `refAccessible`. It returns true for a null id, false when the target company is
  null (an unassigned record cannot carry org FKs), and false when the FK row is
  missing / soft-deleted / in a different company.
- Always cover the platform-owner cross-tenant path in tests — seed a foreign-tenant
  row and assert the platform token gets 400. Single-admin tests will pass regardless
  and hide the bug.
