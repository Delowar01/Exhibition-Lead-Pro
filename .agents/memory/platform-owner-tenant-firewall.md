---
name: Platform-owner tenant data firewall
description: Why platform_owner must be blocked from customer CRM endpoints at the API layer, and how the guard must be placed.
---

# Platform-owner tenant data firewall (Enterprise Privacy Model)

The platform operator role (`platform_owner`, "Elite Marcom") manages the platform but must NOT
have routine access to customer business data (contacts, leads, events, scans, reports, follow-ups,
meetings, tasks). UI hiding is insufficient — enforce at the API layer with a dedicated terminating
guard (`requireTenantUser`: 401 if no user, 403 if role === "platform_owner").

**Why:** `platform_owner` previously slipped through customer-data reads because the two existing
gates fail open for it — `tenantScope` returns `undefined` (no filter → cross-tenant) for
platform_owner, and `requirePermission` early-returns/bypasses for platform_owner. So neither the
tenant filter nor the permission matrix blocks it. A separate explicit firewall is required.

**How to apply:**
- The guard is TERMINATING. Sub-routers are mounted path-less on one shared parent
  (`routes/index.ts`), so a path-less `router.use(requireTenantUser)` 403s EVERY request app-wide
  (incl. platform routes). ALWAYS path-scope it: `router.use("/contacts", requireTenantUser)`.
- Place it right after `router.use(requireAuth)` and BEFORE `blockReadOnlyMutations` /
  `auditMutations` / `requirePermission` so platform_owner is rejected before reaching the
  fail-open gates and before audit rows are written.
- Self-service / public routers (e.g. `cards.ts`: `/cards/me`, public card view) are NOT
  customer-business-data CRUD — leave them untouched.
- Scope discipline: blocking the role (this firewall) is separate from per-role RBAC on reports
  (`requirePermission("reports", ...)`). Adding report RBAC would regress `employee` read access,
  so it belongs to a later governance stage, not the firewall change.
