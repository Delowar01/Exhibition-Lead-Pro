---
name: Invitation roleIds privilege escalation
description: Why invitation roleIds need both target-company scoping AND a permission-subset check, mirroring the user-roles guard.
---

When a flow attaches custom RBAC `roleIds` to a principal (invitations, user-role
assignment), TWO independent guards are required — accessibility alone is not enough:

1. **Target-company scoping**: the role must belong to the company the new account
   lands in, not merely a company the *actor* can access. A multi-tenant actor
   (platform_owner, or anyone with several accessibleCompanies) can otherwise bind a
   role from company B onto an account created in company A. Use
   `firstRoleNotInCompany(roleIds, targetCompanyId)` (system roles with null
   companyId are exempt).
2. **Permission-subset anti-escalation**: a caller who does NOT bypass permission
   checks (i.e. not platform_owner/primary_admin) may only grant roles whose
   `module:action` grants are a subset of their own effective `user.permissions`.
   Mirror `users.service#setUserRoles` exactly (`permissionsForRoles` vs held set →
   403 on any missing grant). Otherwise an actor with team.create can mint/attach a
   powerful custom role via an invite and escalate past the base-role rank guard.

**Why:** invitation create originally validated `roleIds` with only
`firstInaccessibleRole(user, roleIds)`, which checks actor accessibility — not target
company, not grant-subset. That is a real escalation back door (caught in code review,
not by the existing tests).

**How to apply:** any NEW path that assigns roleIds to a user/invite must replicate
both guards. The base-role rank guard (`roleRank(role) > roleRank(user.role)`) is
separate and does NOT cover custom-role permission grants.
