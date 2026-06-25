import { db, departmentsTable, teamsTable, usersTable } from "@workspace/db";
import { eq, ilike, and, count, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted } from "./base.js";

export type DepartmentRow = typeof departmentsTable.$inferSelect;

// Tenant-scoped, soft-delete-excluding list with optional name search + status filter.
export async function list(
  user: AuthUser,
  opts: { search?: string; status?: string; limit: number; offset: number },
): Promise<{ rows: DepartmentRow[]; total: number }> {
  const extra = [];
  if (opts.search) extra.push(ilike(departmentsTable.name, `%${opts.search}%`));
  if (opts.status) extra.push(eq(departmentsTable.status, opts.status));
  const where = activeScope(user, departmentsTable.companyId, departmentsTable.deletedAt, { extra });
  const [{ total }] = await db.select({ total: count() }).from(departmentsTable).where(where);
  const rows = await db
    .select()
    .from(departmentsTable)
    .where(where)
    .limit(opts.limit)
    .offset(opts.offset)
    .orderBy(departmentsTable.name);
  return { rows, total };
}

// Tenant-scoped, soft-delete-excluding single fetch. Returns undefined when the
// row does not exist, is soft-deleted, or is not accessible to the caller.
export async function findById(user: AuthUser, id: number): Promise<DepartmentRow | undefined> {
  const where = activeScope(user, departmentsTable.companyId, departmentsTable.deletedAt, { extra: [eq(departmentsTable.id, id)] });
  const [row] = await db.select().from(departmentsTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof departmentsTable.$inferInsert): Promise<DepartmentRow> {
  const [row] = await db.insert(departmentsTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof departmentsTable.$inferInsert>): Promise<DepartmentRow | undefined> {
  const [row] = await db.update(departmentsTable).set(data).where(eq(departmentsTable.id, id)).returning();
  return row;
}

// Soft-delete. Hand-replicates the FK onDelete behaviour inside one txn so no
// surviving row points at a dead department: teams.departmentId, users.departmentId
// and child departments.parentDepartmentId are nulled, then deletedAt is stamped.
export async function softDelete(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(teamsTable).set({ departmentId: null }).where(eq(teamsTable.departmentId, id));
    await tx.update(usersTable).set({ departmentId: null }).where(eq(usersTable.departmentId, id));
    await tx.update(departmentsTable).set({ parentDepartmentId: null }).where(eq(departmentsTable.parentDepartmentId, id));
    await tx.update(departmentsTable).set({ deletedAt: new Date() }).where(eq(departmentsTable.id, id));
  });
}

// Live headcount + team count for a department (soft-deleted rows excluded).
export async function counts(id: number): Promise<{ employeeCount: number; teamCount: number }> {
  const [emp] = await db
    .select({ c: count() })
    .from(usersTable)
    .where(and(eq(usersTable.departmentId, id), notDeleted(usersTable.deletedAt)));
  const [tm] = await db
    .select({ c: count() })
    .from(teamsTable)
    .where(and(eq(teamsTable.departmentId, id), notDeleted(teamsTable.deletedAt)));
  return { employeeCount: emp.c, teamCount: tm.c };
}

export async function nameById(id: number): Promise<string | null> {
  const [row] = await db.select({ name: departmentsTable.name }).from(departmentsTable).where(eq(departmentsTable.id, id)).limit(1);
  return row?.name ?? null;
}

// Batch name resolution for enrichment (directory, hierarchy). Includes
// soft-deleted rows by id so historical references still resolve a label.
export async function namesByIds(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: departmentsTable.id, name: departmentsTable.name }).from(departmentsTable).where(inArray(departmentsTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
