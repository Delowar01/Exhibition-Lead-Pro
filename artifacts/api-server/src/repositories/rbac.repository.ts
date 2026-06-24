import { db, rolesTable, rolePermissionsTable, userRolesTable } from "@workspace/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import type { PermissionMatrix } from "../lib/rbac.js";
import { exec, type Executor } from "./base.js";

export type RoleRow = typeof rolesTable.$inferSelect;
export type RolePermissionRow = typeof rolePermissionsTable.$inferSelect;

// Roles visible to a caller: system templates (companyId IS NULL) plus the caller's
// own tenant roles. platform_owner sees every role.
export async function listRoles(user: AuthUser): Promise<RoleRow[]> {
  if (user.role === "platform_owner") {
    return db.select().from(rolesTable).orderBy(rolesTable.name);
  }
  return db
    .select()
    .from(rolesTable)
    .where(or(isNull(rolesTable.companyId), inArray(rolesTable.companyId, user.accessibleCompanies)))
    .orderBy(rolesTable.name);
}

// A single role the caller may access (own tenant or a system template).
export async function findRole(user: AuthUser, id: number): Promise<RoleRow | undefined> {
  const [row] = await db.select().from(rolesTable).where(eq(rolesTable.id, id)).limit(1);
  if (!row) return undefined;
  if (user.role === "platform_owner") return row;
  if (row.companyId === null) return row; // system template — readable by all
  if (!user.accessibleCompanies.includes(row.companyId)) return undefined;
  return row;
}

export async function permissionsForRole(roleId: number): Promise<RolePermissionRow[]> {
  return db.select().from(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, roleId));
}

// Union of permissions granted by a set of roles, as a {module: actions[]} matrix.
// Used to verify a caller is not granting authority they do not themselves hold.
export async function permissionsForRoles(roleIds: number[]): Promise<PermissionMatrix> {
  if (roleIds.length === 0) return {};
  const rows = await db
    .select({ module: rolePermissionsTable.module, action: rolePermissionsTable.action })
    .from(rolePermissionsTable)
    .where(inArray(rolePermissionsTable.roleId, roleIds));
  const matrix: PermissionMatrix = {};
  for (const r of rows) {
    const set = new Set(matrix[r.module] ?? []);
    set.add(r.action);
    matrix[r.module] = Array.from(set);
  }
  return matrix;
}

export async function insertRole(values: typeof rolesTable.$inferInsert, tx?: Executor): Promise<RoleRow> {
  const [row] = await exec(tx).insert(rolesTable).values(values).returning();
  return row;
}

export async function updateRole(id: number, data: Partial<typeof rolesTable.$inferInsert>, tx?: Executor): Promise<RoleRow | undefined> {
  const [row] = await exec(tx).update(rolesTable).set(data).where(eq(rolesTable.id, id)).returning();
  return row;
}

export async function deleteRole(id: number, tx?: Executor): Promise<void> {
  await exec(tx).delete(rolesTable).where(eq(rolesTable.id, id));
}

// Replaces the full grant set for a role in one transaction (clear + insert).
export async function replaceRolePermissions(roleId: number, grants: Array<{ module: string; action: string }>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, roleId));
    if (grants.length > 0) {
      await tx.insert(rolePermissionsTable).values(grants.map((g) => ({ roleId, module: g.module, action: g.action })));
    }
  });
}

// --- user_roles assignment ---

export async function rolesForUser(userId: number): Promise<RoleRow[]> {
  return db
    .select({ role: rolesTable })
    .from(userRolesTable)
    .innerJoin(rolesTable, eq(userRolesTable.roleId, rolesTable.id))
    .where(eq(userRolesTable.userId, userId))
    .then((rows) => rows.map((r) => r.role));
}

export async function setUserRoles(userId: number, roleIds: number[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(userRolesTable).where(eq(userRolesTable.userId, userId));
    if (roleIds.length > 0) {
      await tx.insert(userRolesTable).values(roleIds.map((roleId) => ({ userId, roleId })));
    }
  });
}

// Effective permission matrix derived from a user's assigned roles. The auth
// boundary unions this with the legacy users.permissions JSON. A single joined
// query keeps the per-request cost to one round-trip.
export async function rolePermissionsForUser(userId: number): Promise<PermissionMatrix> {
  const rows = await db
    .select({ module: rolePermissionsTable.module, action: rolePermissionsTable.action })
    .from(userRolesTable)
    .innerJoin(rolePermissionsTable, eq(userRolesTable.roleId, rolePermissionsTable.roleId))
    .where(eq(userRolesTable.userId, userId));
  const matrix: PermissionMatrix = {};
  for (const r of rows) {
    const set = new Set(matrix[r.module] ?? []);
    set.add(r.action);
    matrix[r.module] = Array.from(set);
  }
  return matrix;
}

// Verifies a list of role ids are all assignable by the caller (own tenant or system
// template). Returns the first inaccessible id, or null when all are valid.
export async function firstInaccessibleRole(user: AuthUser, roleIds: number[]): Promise<number | null> {
  if (roleIds.length === 0) return null;
  const rows = await db.select().from(rolesTable).where(inArray(rolesTable.id, roleIds));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of roleIds) {
    const r = found.get(id);
    if (!r) return id;
    if (user.role === "platform_owner") continue;
    if (r.companyId === null) continue;
    if (!user.accessibleCompanies.includes(r.companyId)) return id;
  }
  return null;
}
