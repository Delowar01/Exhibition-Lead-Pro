import { db, securityPoliciesTable, securityEventsTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";

export type SecurityPolicyRow = typeof securityPoliciesTable.$inferSelect;
export type SecurityEventRow = typeof securityEventsTable.$inferSelect;

export async function getPolicy(companyId: number): Promise<SecurityPolicyRow | undefined> {
  const [row] = await db.select().from(securityPoliciesTable).where(eq(securityPoliciesTable.companyId, companyId)).limit(1);
  return row;
}

// Inserts or updates the single per-company policy row (unique on company_id).
export async function upsertPolicy(
  companyId: number,
  patch: Partial<typeof securityPoliciesTable.$inferInsert>,
): Promise<SecurityPolicyRow> {
  const existing = await getPolicy(companyId);
  if (existing) {
    const [row] = await db
      .update(securityPoliciesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(securityPoliciesTable.companyId, companyId))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(securityPoliciesTable)
    .values({ ...patch, companyId })
    .returning();
  return row;
}

export async function insertEvent(values: typeof securityEventsTable.$inferInsert): Promise<void> {
  await db.insert(securityEventsTable).values(values);
}

// Security events visible to a caller, newest first. platform_owner sees all;
// everyone else is scoped to their accessible companies.
export async function listEvents(user: AuthUser, limit: number): Promise<SecurityEventRow[]> {
  if (user.role === "platform_owner") {
    return db.select().from(securityEventsTable).orderBy(desc(securityEventsTable.createdAt)).limit(limit);
  }
  if (user.accessibleCompanies.length === 0) return [];
  return db
    .select()
    .from(securityEventsTable)
    .where(inArray(securityEventsTable.companyId, user.accessibleCompanies))
    .orderBy(desc(securityEventsTable.createdAt))
    .limit(limit);
}
