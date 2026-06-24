---
name: RBAC grant subset guard
description: Why assigning custom roles to users needs a permission-subset check beyond base-role rank
---

When a user can assign custom roles to other users (or themselves), gating that
endpoint on a capability permission alone (e.g. `team.edit`) is NOT enough.

**Rule:** a non-bypass caller may only assign roles whose granted permissions are
a SUBSET of the caller's own effective permissions. Reject (403) any grant of a
(module, action) the caller does not themselves hold. platform_owner and
primary_admin bypass (they hold everything within their tenant).

**Why:** RBAC role grants are ADDITIVE on top of the legacy per-user permissions
JSON and are merged into req.user.permissions at the auth boundary. Without the
subset check, anyone with role-assignment capability could mint/assign a custom
role carrying high permissions (roles.edit, security.edit, ...) to themselves and
escalate past the base-role rank guard (ROLE_RANK) — the rank guard only covers
the base `role` column, not custom-role permission grants.

**How to apply:** enforce in the setUserRoles service path (compute union of the
target roles' permissions, compare against caller's held matrix). Tenant-
accessibility of role IDs is a separate, insufficient check.
