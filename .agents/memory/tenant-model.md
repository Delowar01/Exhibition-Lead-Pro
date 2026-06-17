---
name: Tenant & permission model
description: Multi-tenancy boundary, read scoping, FK validation, role escalation, and lifecycle rules
---

**Tenant boundary:** `company_id` is the tenant key — there is no separate `tenant_id`.
Non-platform users may only touch their accessible companies (own company + explicit
`user_company_access` rows, exposed as `req.user.accessibleCompanies`); `platform_owner` sees all.

**Auth invariant:** every non-`platform_owner` user MUST resolve to ≥1 accessible company.
`requireAuth` 403s any non-platform account with empty `accessibleCompanies`, and `POST /users`
400s creation of a non-platform role with null company. A company-less non-platform account would
otherwise read unscoped data.

**Read scoping:** never scope a tenant read by `companyId` alone — a null `companyId` produces an
UNFILTERED (cross-tenant) query. Use the shared `tenantScope(user, column)` helper (returns
`undefined`/no-filter for platform_owner, else `inArray(column, accessibleCompanies)`) on EVERY
list/report/stats/pipeline query.
**Why:** repeated leaks came from `companyId ? eq(...) : undefined` patterns where null fell through.

**Single-record access:** cross-tenant access to a single resource returns **404, not 403**
(`canAccessCompany`), so existence in another tenant isn't leaked.

**FK injection:** validate every related id on writes with `refAccessible(user, table, id)` — reject
cross-tenant/nonexistent `eventId`/`assignedToId`/`contactId` (etc.) with 400. Without this a user
can write an own-tenant row pointing at foreign records and leak their metadata via enrichment.

**Permissions:** `platform_owner`/`primary_admin` bypass checks; `admin`/`employee` gated by an
explicit permissions matrix on **writes only** (reads stay open but tenant-scoped); empty = deny.

**Role escalation:** a caller may never create or promote a user to a role ranked higher than their
own (rank: employee<admin<primary_admin<platform_owner). Enforce in both POST and PATCH `/users`.

**Lifecycle** (on company status): suspended/expired/lapsed-trial block login; cancelled = read-only;
active/valid-trial = full access (`evaluateCompanyAccess`).
