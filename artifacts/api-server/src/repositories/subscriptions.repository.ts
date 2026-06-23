import { db, subscriptionsTable, companiesTable, plansTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

export type SubscriptionRow = typeof subscriptionsTable.$inferSelect;
export type PlanRow = typeof plansTable.$inferSelect;

// subscriptions/plans/companies are not soft-delete tables, so no deletedAt
// exclusion applies to any query in this repository.

export async function findSubscriptionByCompanyId(companyId: number): Promise<SubscriptionRow | undefined> {
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
  return sub;
}

export async function findPlanById(id: string): Promise<PlanRow | undefined> {
  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, id)).limit(1);
  return plan;
}

export async function insertSubscription(values: typeof subscriptionsTable.$inferInsert): Promise<SubscriptionRow> {
  const [row] = await db.insert(subscriptionsTable).values(values).returning();
  return row;
}

export async function listActivePlans(): Promise<PlanRow[]> {
  return db.select().from(plansTable).where(eq(plansTable.isActive, true)).orderBy(asc(plansTable.sortOrder));
}

export async function updateSubscriptionByCompanyId(
  companyId: number,
  data: Partial<typeof subscriptionsTable.$inferInsert>,
): Promise<SubscriptionRow | undefined> {
  const [row] = await db.update(subscriptionsTable).set(data).where(eq(subscriptionsTable.companyId, companyId)).returning();
  return row;
}

export async function updateCompanyById(id: number, data: Partial<typeof companiesTable.$inferInsert>): Promise<void> {
  await db.update(companiesTable).set(data).where(eq(companiesTable.id, id));
}
