import { db, usersTable, companiesTable, loginAttemptsTable, trustedDevicesTable } from "@workspace/db";
import { eq, ilike, count, desc, and, ne, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { tenantOnly, notDeleted } from "./base.js";

export type UserRow = typeof usersTable.$inferSelect;

// Resolves a company name for user enrichment. Users live in their own
// (non-soft-delete) table; companies likewise has no deletedAt column, so no
// soft-delete exclusion applies here.
export async function companyName(id: number): Promise<string | null | undefined> {
  const [row] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, id));
  return row?.name;
}

// Tenant-scoped list with optional name/role filters. Tenant scoping is
// centralized here: platform_owner sees every company and may additionally
// narrow by an explicit companyId; everyone else is hard-scoped to their
// accessible companies (tenantScope handles that via tenantOnly).
// Soft-deleted users are excluded from the management surface.
export async function list(
  user: AuthUser,
  opts: { search?: string; role?: string; companyId?: string; limit: number; offset: number },
): Promise<{ rows: UserRow[]; total: number }> {
  const extra = [notDeleted(usersTable.deletedAt)];
  if (opts.search) extra.push(ilike(usersTable.name, `%${opts.search}%`));
  if (opts.role) extra.push(eq(usersTable.role, opts.role));
  if (user.role === "platform_owner") {
    if (opts.companyId && !isNaN(parseInt(opts.companyId))) extra.push(eq(usersTable.companyId, parseInt(opts.companyId)));
  }
  const where = tenantOnly(user, usersTable.companyId, ...extra);

  const [{ total }] = await db.select({ total: count() }).from(usersTable).where(where);
  const rows = await db.select().from(usersTable).where(where).limit(opts.limit).offset(opts.offset).orderBy(usersTable.createdAt);
  return { rows, total };
}

// Tenant-scoped single fetch. Returns undefined when the row does not exist or
// is not accessible to the caller (both map to a 404 in the service). Excludes
// soft-deleted users.
export async function findById(user: AuthUser, id: number): Promise<UserRow | undefined> {
  const where = tenantOnly(user, usersTable.companyId, eq(usersTable.id, id), notDeleted(usersTable.deletedAt));
  const [row] = await db.select().from(usersTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof usersTable.$inferInsert): Promise<UserRow> {
  const [row] = await db.insert(usersTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof usersTable.$inferInsert>): Promise<UserRow | undefined> {
  const [row] = await db.update(usersTable).set(data).where(eq(usersTable.id, id)).returning();
  return row;
}

// Soft-delete (Phase 2.4): stamp deletedAt and deactivate so the account is
// excluded from auth user-load, login, and the management surface — without a
// destructive cascade. Returns the updated row.
export async function softDelete(id: number): Promise<UserRow | undefined> {
  const [row] = await db
    .update(usersTable)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning();
  return row;
}

export interface LoginHistoryRow {
  id: number;
  ipAddress: string | null;
  userAgent: string | null;
  success: boolean;
  reason: string | null;
  createdAt: Date;
}

// Per-user login attempts (success + failure), newest first.
export async function loginHistory(userId: number, limit: number): Promise<LoginHistoryRow[]> {
  return db
    .select({
      id: loginAttemptsTable.id,
      ipAddress: loginAttemptsTable.ipAddress,
      userAgent: loginAttemptsTable.userAgent,
      success: loginAttemptsTable.success,
      reason: loginAttemptsTable.reason,
      createdAt: loginAttemptsTable.createdAt,
    })
    .from(loginAttemptsTable)
    .where(eq(loginAttemptsTable.userId, userId))
    .orderBy(desc(loginAttemptsTable.createdAt))
    .limit(limit);
}

// Single user display name (for enrichment of manager/head/leader refs).
export async function nameById(id: number): Promise<string | null> {
  const [row] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  return row?.name ?? null;
}

// Batch name resolution for enrichment.
export async function userNamesByIds(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// Given a candidate set of user ids, returns only those that are ACTIVE,
// non-deleted members of the given company. Backs @mention validation so a
// mention can never resolve to a user outside the note's tenant.
export async function activeIdsInCompany(companyId: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, companyId), eq(usersTable.isActive, true), notDeleted(usersTable.deletedAt), inArray(usersTable.id, ids)));
  return rows.map((r) => r.id);
}

export async function companyNamesByIds(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// True when another (non-deleted) user in the same company already uses this
// employeeId. Backs the per-company employeeId uniqueness check before writes.
export async function employeeIdExists(companyId: number | null, employeeId: string, excludeId?: number): Promise<boolean> {
  if (companyId == null) return false;
  const conds = [eq(usersTable.companyId, companyId), eq(usersTable.employeeId, employeeId), notDeleted(usersTable.deletedAt)];
  if (excludeId != null) conds.push(ne(usersTable.id, excludeId));
  const [row] = await db.select({ id: usersTable.id }).from(usersTable).where(and(...conds)).limit(1);
  return !!row;
}

const DIRECTORY_SORTS: Record<string, PgColumn> = {
  name: usersTable.name,
  joiningDate: usersTable.joiningDate,
  createdAt: usersTable.createdAt,
  employmentStatus: usersTable.employmentStatus,
};

// Tenant-scoped employee directory with org filters + sorting. Excludes
// soft-deleted users. Unknown sort keys fall back to name.
export async function directory(
  user: AuthUser,
  opts: {
    search?: string;
    departmentId?: number;
    teamId?: number;
    managerId?: number;
    employmentStatus?: string;
    role?: string;
    sort?: string;
    order?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: UserRow[]; total: number }> {
  const extra: Array<SQL | undefined> = [notDeleted(usersTable.deletedAt)];
  if (opts.search) extra.push(ilike(usersTable.name, `%${opts.search}%`));
  if (opts.departmentId) extra.push(eq(usersTable.departmentId, opts.departmentId));
  if (opts.teamId) extra.push(eq(usersTable.teamId, opts.teamId));
  if (opts.managerId) extra.push(eq(usersTable.managerId, opts.managerId));
  if (opts.employmentStatus) extra.push(eq(usersTable.employmentStatus, opts.employmentStatus));
  if (opts.role) extra.push(eq(usersTable.role, opts.role));
  const where = tenantOnly(user, usersTable.companyId, ...extra);

  const [{ total }] = await db.select({ total: count() }).from(usersTable).where(where);
  const sortCol = DIRECTORY_SORTS[opts.sort ?? "name"] ?? usersTable.name;
  const orderBy = opts.order === "desc" ? desc(sortCol) : sortCol;
  const rows = await db.select().from(usersTable).where(where).limit(opts.limit).offset(opts.offset).orderBy(orderBy);
  return { rows, total };
}

// All tenant-scoped active users, for building the reporting-manager tree.
export async function allForHierarchy(user: AuthUser): Promise<UserRow[]> {
  const where = tenantOnly(user, usersTable.companyId, notDeleted(usersTable.deletedAt));
  return db.select().from(usersTable).where(where).orderBy(usersTable.name);
}

export async function trustedDevices(userId: number) {
  return db
    .select({
      id: trustedDevicesTable.id,
      label: trustedDevicesTable.label,
      userAgent: trustedDevicesTable.userAgent,
      ipAddress: trustedDevicesTable.ipAddress,
      lastUsedAt: trustedDevicesTable.lastUsedAt,
      expiresAt: trustedDevicesTable.expiresAt,
      createdAt: trustedDevicesTable.createdAt,
    })
    .from(trustedDevicesTable)
    .where(eq(trustedDevicesTable.userId, userId))
    .orderBy(desc(trustedDevicesTable.lastUsedAt));
}
