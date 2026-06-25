import { db, teamsTable, usersTable } from "@workspace/db";
import { eq, ilike, and, count, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, notDeleted, tenantOnly } from "./base.js";
import type { UserRow } from "./users.repository.js";

export type TeamRow = typeof teamsTable.$inferSelect;

// Tenant-scoped, soft-delete-excluding list with optional name search, status
// and department filters.
export async function list(
  user: AuthUser,
  opts: { search?: string; status?: string; departmentId?: number; limit: number; offset: number },
): Promise<{ rows: TeamRow[]; total: number }> {
  const extra = [];
  if (opts.search) extra.push(ilike(teamsTable.name, `%${opts.search}%`));
  if (opts.status) extra.push(eq(teamsTable.status, opts.status));
  if (opts.departmentId) extra.push(eq(teamsTable.departmentId, opts.departmentId));
  const where = activeScope(user, teamsTable.companyId, teamsTable.deletedAt, { extra });
  const [{ total }] = await db.select({ total: count() }).from(teamsTable).where(where);
  const rows = await db
    .select()
    .from(teamsTable)
    .where(where)
    .limit(opts.limit)
    .offset(opts.offset)
    .orderBy(teamsTable.name);
  return { rows, total };
}

export async function findById(user: AuthUser, id: number): Promise<TeamRow | undefined> {
  const where = activeScope(user, teamsTable.companyId, teamsTable.deletedAt, { extra: [eq(teamsTable.id, id)] });
  const [row] = await db.select().from(teamsTable).where(where).limit(1);
  return row;
}

export async function insert(values: typeof teamsTable.$inferInsert): Promise<TeamRow> {
  const [row] = await db.insert(teamsTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof teamsTable.$inferInsert>): Promise<TeamRow | undefined> {
  const [row] = await db.update(teamsTable).set(data).where(eq(teamsTable.id, id)).returning();
  return row;
}

// Soft-delete. Nulls users.teamId for every member inside the txn (mirrors the
// FK set-null behaviour) before stamping deletedAt, so no user points at a dead team.
export async function softDelete(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ teamId: null }).where(eq(usersTable.teamId, id));
    await tx.update(teamsTable).set({ deletedAt: new Date() }).where(eq(teamsTable.id, id));
  });
}

export async function memberCount(id: number): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(usersTable)
    .where(and(eq(usersTable.teamId, id), notDeleted(usersTable.deletedAt)));
  return row.c;
}

// Tenant-scoped member list (active users on this team).
export async function members(user: AuthUser, teamId: number): Promise<UserRow[]> {
  const where = tenantOnly(user, usersTable.companyId, eq(usersTable.teamId, teamId), notDeleted(usersTable.deletedAt));
  return db.select().from(usersTable).where(where).orderBy(usersTable.name);
}

// Assigns a set of users to a team (used by POST /teams/:id/members). Callers
// MUST validate tenant accessibility of every id before calling.
export async function assignMembers(teamId: number, userIds: number[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const rows = await db
    .update(usersTable)
    .set({ teamId, updatedAt: new Date() })
    .where(inArray(usersTable.id, userIds))
    .returning({ id: usersTable.id });
  return rows.length;
}

export async function nameById(id: number): Promise<string | null> {
  const [row] = await db.select({ name: teamsTable.name }).from(teamsTable).where(eq(teamsTable.id, id)).limit(1);
  return row?.name ?? null;
}

export async function namesByIds(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: teamsTable.id, name: teamsTable.name }).from(teamsTable).where(inArray(teamsTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
