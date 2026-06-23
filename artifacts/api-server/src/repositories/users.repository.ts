import { db, usersTable, companiesTable } from "@workspace/db";
import { eq, ilike, count } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { tenantOnly } from "./base.js";

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
export async function list(
  user: AuthUser,
  opts: { search?: string; role?: string; companyId?: string; limit: number; offset: number },
): Promise<{ rows: UserRow[]; total: number }> {
  const extra = [];
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
// is not accessible to the caller (both map to a 404 in the service).
export async function findById(user: AuthUser, id: number): Promise<UserRow | undefined> {
  const where = tenantOnly(user, usersTable.companyId, eq(usersTable.id, id));
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

export async function remove(id: number): Promise<void> {
  await db.delete(usersTable).where(eq(usersTable.id, id));
}
