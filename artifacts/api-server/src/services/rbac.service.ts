import type { AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { PERMISSION_CATALOG, findInvalidPermission } from "../lib/rbac.js";
import * as rbacRepo from "../repositories/rbac.repository.js";

function formatRole(role: rbacRepo.RoleRow, grants: Array<{ module: string; action: string }>) {
  return {
    id: role.id,
    companyId: role.companyId,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    isDefault: role.isDefault,
    permissions: grants,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export function getCatalog() {
  return {
    modules: Object.entries(PERMISSION_CATALOG).map(([module, { label, actions }]) => ({ module, label, actions })),
  };
}

export async function listRoles(user: AuthUser) {
  const roles = await rbacRepo.listRoles(user);
  const withGrants = await Promise.all(
    roles.map(async (r) => {
      const perms = await rbacRepo.permissionsForRole(r.id);
      return formatRole(r, perms.map((p) => ({ module: p.module, action: p.action })));
    }),
  );
  return { roles: withGrants };
}

export async function getRole(user: AuthUser, id: number) {
  const role = await rbacRepo.findRole(user, id);
  if (!role) throw new AppError(404, "Role not found");
  const perms = await rbacRepo.permissionsForRole(role.id);
  return formatRole(role, perms.map((p) => ({ module: p.module, action: p.action })));
}

export interface RoleInput {
  name?: string;
  description?: string | null;
  isDefault?: boolean;
  permissions?: Array<{ module: string; action: string }>;
}

function validateGrants(permissions: Array<{ module: string; action: string }> | undefined) {
  const grants = permissions ?? [];
  const bad = findInvalidPermission(grants);
  if (bad) throw new AppError(400, `Unknown permission: ${bad.module}.${bad.action}`);
  return grants;
}

export async function createRole(user: AuthUser, input: RoleInput) {
  if (user.role !== "platform_owner" && user.role !== "primary_admin") {
    // admins/employees need explicit roles.create permission (enforced at route),
    // but only tenant owners/platform may own roles. Tenant binding:
  }
  const name = input.name?.trim();
  if (!name) throw new AppError(400, "name is required");
  const grants = validateGrants(input.permissions);
  // Custom roles are always tenant-owned. platform_owner without a company creates a
  // system template (companyId null); everyone else binds to their own company.
  const companyId = user.role === "platform_owner" ? user.companyId ?? null : user.companyId;
  if (user.role !== "platform_owner" && companyId == null) {
    throw new AppError(400, "Your account has no company to own this role");
  }
  const role = await rbacRepo.insertRole({
    companyId,
    name,
    description: input.description ?? null,
    isSystem: false,
    isDefault: input.isDefault ?? false,
  });
  await rbacRepo.replaceRolePermissions(role.id, grants);
  return getRole(user, role.id);
}

export async function updateRole(user: AuthUser, id: number, input: RoleInput) {
  const role = await rbacRepo.findRole(user, id);
  if (!role) throw new AppError(404, "Role not found");
  if (role.isSystem) throw new AppError(403, "System roles cannot be modified");
  if (role.companyId === null) throw new AppError(403, "Template roles cannot be modified");
  const patch: Partial<typeof role> = { updatedAt: new Date() };
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (typeof input.isDefault === "boolean") patch.isDefault = input.isDefault;
  await rbacRepo.updateRole(id, patch);
  if (input.permissions !== undefined) {
    const grants = validateGrants(input.permissions);
    await rbacRepo.replaceRolePermissions(id, grants);
  }
  return getRole(user, id);
}

export async function deleteRole(user: AuthUser, id: number) {
  const role = await rbacRepo.findRole(user, id);
  if (!role) throw new AppError(404, "Role not found");
  if (role.isSystem || role.companyId === null) throw new AppError(403, "System roles cannot be deleted");
  await rbacRepo.deleteRole(id);
  return { success: true, message: "Role deleted" };
}
