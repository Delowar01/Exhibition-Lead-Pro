import { db, companiesTable, usersTable, scansTable, leadsTable, activityLogsTable } from "@workspace/db";
import { eq, count, sql } from "drizzle-orm";
import { notDeleted } from "./base.js";
import { TENANT_USER, LIVE_CAPTURE, OCR_CARD_SCAN } from "./platform-definitions.js";

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

// Company users that exist today: deleted accounts and platform operators are not users.
export async function countUsers(): Promise<number> {
  const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(usersTable).where(TENANT_USER);
  return totalUsers;
}

// Every capture, and the card scans among them (the captures sent for OCR) — the same
// definitions as the dashboard's scan trend and the analytics module. One statement, so
// the two figures describe the same moment and scans can never exceed captures.
export async function captureTotals(): Promise<{ captures: number; scans: number }> {
  const [row] = await db
    .select({
      captures: sql<number>`count(*) filter (where ${LIVE_CAPTURE})`,
      scans: sql<number>`count(*) filter (where ${OCR_CARD_SCAN})`,
    })
    .from(scansTable);
  return { captures: Number(row?.captures ?? 0), scans: Number(row?.scans ?? 0) };
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
