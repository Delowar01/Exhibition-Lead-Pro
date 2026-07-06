# Security & Privacy

The tenant-isolation, authorization, and privacy invariants that every route and
query must uphold. Violating any of these is a security bug, not a style nit.

**Related decisions** (in [Architecture Decisions](architecture-decisions.md)):
the `company_id` tenant boundary (cross-tenant reads return 404, not 403), the
`platform_owner → primary_admin → admin → employee` role hierarchy and
permissions matrix, the subscription lifecycle access gates (`evaluateCompanyAccess`),
and the append-only `audit_logs` design.

**Scope privacy** for analytics and workflow rollups (employee sees own only /
team lead sees own team / dept head sees own dept / company overview is
manager-only) is described per-feature in [Product](product.md); the enforcement
mirrors the analytics scope model.

## Tenant isolation & FK integrity

- **Never scope a tenant read by `companyId` alone** — a null `companyId` produces an UNFILTERED cross-tenant query. Use `tenantScope(req.user, table.companyId)` (in `requireAuth.ts`) on every list/report/stats/pipeline query: it returns no filter for `platform_owner` and `inArray(column, accessibleCompanies)` for everyone else.
- **Validate FK refs on writes** with `refAccessible(req.user, table, id)` (in `lib/tenant.ts`) — reject cross-tenant/nonexistent `eventId`/`assignedToId`/`contactId` with 400, or a user can point own-tenant rows at foreign records and leak metadata via enrichment.
- **Caller-scoped vs tenant-scoped FK check**: `refAccessible(caller, …)` is CALLER-scoped (passes for any company the caller can reach — a `platform_owner` passes for ALL). When binding a record to ANOTHER record's tenant (e.g. a user's `managerId`/`departmentId`/`teamId` into the target user's company `cid`), use `refInCompany(table, cid, id)` instead — it requires the FK row's company === `cid`. Single-tenant admin tests can't see the gap; always cover the platform-owner cross-tenant path.
- **No role escalation**: a caller may never create/promote a user to a role ranked higher than their own (employee<admin<primary_admin<platform_owner). Enforced in POST + PATCH `/users`.
- **Tenant invariant**: `requireAuth` 403s non-platform users with empty `accessibleCompanies`; `POST /users` 400s non-platform roles with null company.

## Routing guard safety

- **Router-level guard leak**: sub-routers are mounted path-less on one shared parent (`routes/index.ts`), and each route defines its own full path. A path-less `router.use(mw)` in a sub-router runs for EVERY request flowing through the parent. Terminating guards (`requireRole`, `auditMutations`) MUST be path-scoped to the module base, e.g. `router.use("/contacts", auditMutations("contacts"))` — otherwise they fire on unrelated routes (403s, duplicate audit rows). `requireAuth` is non-terminating so path-less is fine.
