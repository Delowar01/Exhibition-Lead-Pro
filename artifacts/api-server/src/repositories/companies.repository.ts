import { db, companiesTable, usersTable, contactsTable, scansTable, activityLogsTable, subscriptionsTable } from "@workspace/db";
import { eq, ilike, and, count, desc, inArray, sql } from "drizzle-orm";
import { notDeleted, exec, type Executor } from "./base.js";
import { TENANT_USER, LIVE_CAPTURE } from "./platform-definitions.js";

export type CompanyRow = typeof companiesTable.$inferSelect;

// Per-company aggregate counts surfaced alongside each company record, by the platform's
// definitions: users that exist today (no deleted account), contacts that exist today, and
// captures that exist today (scanCount — every capture, with or without OCR). The
// per-company figures therefore add up to the dashboard's "Total Users" and "Total
// Captures".
export async function counts(id: number): Promise<{ userCount: number; contactCount: number; scanCount: number }> {
  const [userCount] = await db.select({ count: count() }).from(usersTable).where(and(eq(usersTable.companyId, id), TENANT_USER));
  const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(and(eq(contactsTable.companyId, id), notDeleted(contactsTable.deletedAt)));
  const [scanCount] = await db.select({ count: count() }).from(scansTable).where(and(eq(scansTable.companyId, id), LIVE_CAPTURE));
  return { userCount: userCount.count, contactCount: contactCount.count, scanCount: scanCount.count };
}

// Batch 20: `status` / `plan` filters resolve against the canonical
// subscriptions row (never the legacy mirror columns on companies). The legacy
// spelling "trial" is accepted as an alias of the canonical "trialing".
export async function list(opts: { search?: string; status?: string; plan?: string; limit: number; offset: number }): Promise<{ rows: CompanyRow[]; total: number }> {
  const conditions = [];
  if (opts.search) conditions.push(ilike(companiesTable.name, `%${opts.search}%`));
  if (opts.status || opts.plan) {
    const subConditions = [eq(subscriptionsTable.companyId, companiesTable.id)];
    if (opts.status) {
      const wanted = opts.status === "trial" ? ["trialing", "trial"] : [opts.status];
      subConditions.push(inArray(subscriptionsTable.status, wanted));
    }
    if (opts.plan) subConditions.push(eq(subscriptionsTable.plan, opts.plan));
    conditions.push(sql`exists (${db.select({ one: sql`1` }).from(subscriptionsTable).where(and(...subConditions))})`);
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(companiesTable).where(whereClause);
  // Newest first: the platform's company lists (the Companies page and the dashboard's "Recent
  // Companies") lead with the latest tenants. The id breaks ties, so paging never repeats or
  // skips a company created in the same instant as another.
  const rows = await db.select().from(companiesTable).where(whereClause).limit(opts.limit).offset(opts.offset).orderBy(desc(companiesTable.createdAt), desc(companiesTable.id));
  return { rows, total };
}

export async function findById(id: number): Promise<CompanyRow | undefined> {
  const [row] = await db.select().from(companiesTable).where(eq(companiesTable.id, id)).limit(1);
  return row;
}

export async function insert(values: typeof companiesTable.$inferInsert, tx?: Executor): Promise<CompanyRow> {
  const [row] = await exec(tx).insert(companiesTable).values(values).returning();
  return row;
}

export async function update(id: number, data: Partial<typeof companiesTable.$inferInsert>): Promise<CompanyRow | undefined> {
  const [row] = await db.update(companiesTable).set(data).where(eq(companiesTable.id, id)).returning();
  return row;
}

// Companies are the tenant boundary itself; deleting one is a platform-level
// lifecycle action whose ON DELETE CASCADE wipes the whole tenant. Soft-delete is
// deliberately NOT applied here (see Phase 2.3 notes) — this stays a hard delete.
export async function remove(id: number, tx?: Executor): Promise<void> {
  await exec(tx).delete(companiesTable).where(eq(companiesTable.id, id));
}

export async function insertActivityLog(values: typeof activityLogsTable.$inferInsert, tx?: Executor): Promise<void> {
  await exec(tx).insert(activityLogsTable).values(values);
}
