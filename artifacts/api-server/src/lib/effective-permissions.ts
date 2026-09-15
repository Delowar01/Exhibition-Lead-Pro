import { mergePermissions, normalizeRole, type PermissionMatrix } from "./rbac.js";
import * as rbacRepo from "../repositories/rbac.repository.js";

// ── Effective permission resolution (single implementation) ──────────────────
//
// The permission matrix a user actually holds is the UNION of
//   • the legacy per-user JSON column (`users.permissions`), and
//   • the grants of the RBAC roles assigned to the user (`user_roles` × `role_permissions`).
//
// Batch 20 Correction 4: the auth boundary (requireAuth / loadAuthUserById) and
// the auth USER PROJECTION (login, MFA-completed login, register, /auth/me) must
// agree, so both resolve through this one helper instead of independent copies
// that can drift. The legacy column itself is never rewritten — role grants are
// merged at read time only.
//
// platform_owner / primary_admin bypass requirePermission entirely, so their
// projection stays the raw legacy column (no role join) exactly as before.

export function bypassesPermissionMatrix(role: string): boolean {
  const canonical = normalizeRole(role);
  return canonical === "platform_owner" || canonical === "primary_admin";
}

export interface PermissionSubject {
  id: number;
  role: string;
  permissions: PermissionMatrix | null | undefined;
}

export async function resolveEffectivePermissions(user: PermissionSubject): Promise<PermissionMatrix> {
  const legacy: PermissionMatrix = user.permissions ?? {};
  if (bypassesPermissionMatrix(user.role)) return legacy;
  const granted = await rbacRepo.rolePermissionsForUser(user.id);
  return Object.keys(granted).length > 0 ? mergePermissions(legacy, granted) : legacy;
}
