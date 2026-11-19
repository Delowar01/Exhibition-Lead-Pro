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

// Every capture (card scans read by OCR plus contacts saved without OCR); soft-deleted
// rows are excluded.
export async function countCaptures(): Promise<number> {
  const [{ totalCaptures }] = await db.select({ totalCaptures: count() }).from(scansTable).where(LIVE_CAPTURE);
  return totalCaptures;
}

// Card scans: the captures that were read by OCR — the same definition as the dashboard's
// scan trend (subscriptions.repository dailyScanCounts) and the analytics module.
export async function countScans(): Promise<number> {
  const [{ totalScans }] = await db.select({ totalScans: count() }).from(scansTable).where(OCR_CARD_SCAN);
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
