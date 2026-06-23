import { db, companiesTable, usersTable, scansTable, leadsTable, activityLogsTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import { notDeleted } from "./base.js";

export type ActivityLogRow = typeof activityLogsTable.$inferSelect;

// Platform-owner-only aggregates: these intentionally span ALL companies, so no
// tenant scoping is applied here.
export async function countCompanies(): Promise<number> {
  const [{ totalCompanies }] = await db.select({ totalCompanies: count() }).from(companiesTable);
  return totalCompanies;
}

export async function countActiveCompanies(): Promise<number> {
  const [{ activeCompanies }] = await db.select({ activeCompanies: count() }).from(companiesTable).where(eq(companiesTable.status, "active"));
  return activeCompanies;
}

export async function countUsers(): Promise<number> {
  const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(usersTable);
  return totalUsers;
}

export async function countScans(): Promise<number> {
  const [{ totalScans }] = await db.select({ totalScans: count() }).from(scansTable);
  return totalScans;
}

// leads is a soft-delete table: exclude soft-deleted rows from the count.
export async function countLeads(): Promise<number> {
  const [{ totalLeads }] = await db.select({ totalLeads: count() }).from(leadsTable).where(notDeleted(leadsTable.deletedAt));
  return totalLeads;
}

export async function planDistribution(): Promise<Array<{ status: string; count: number }>> {
  return db.select({ status: companiesTable.plan, count: count() }).from(companiesTable).groupBy(companiesTable.plan);
}

// Most recent activity logs (last N), newest first.
export async function recentActivity(limit: number): Promise<ActivityLogRow[]> {
  return db.select().from(activityLogsTable).orderBy(sql`${activityLogsTable.createdAt} DESC`).limit(limit);
}
