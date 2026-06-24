import { db, securityPoliciesTable, securityEventsTable, loginAttemptsTable, usersTable } from "@workspace/db";
import { eq, desc, inArray, and, gte, sql, type SQL } from "drizzle-orm";
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

export interface SecurityAlertsResult {
  failedLogins: number;
  lockouts: number;
  policyBlocks: number;
  distinctFailedIps: number;
}

// Aggregates suspicious activity within a time window. `companyIds === undefined` means
// no company scoping (platform_owner, all tenants). A non-undefined list scopes both the
// login_attempts (via the users that belong to those companies — attempts for unknown
// emails carry no user_id and are therefore not attributable to a tenant) and the
// policy-block security events. `lockouts` approximates the number of distinct emails that
// reached the failure threshold in the window.
export async function getSecurityAlerts(opts: {
  companyIds?: number[];
  since: Date;
  threshold: number;
}): Promise<SecurityAlertsResult> {
  const { companyIds, since, threshold } = opts;

  const failedConds: SQL[] = [eq(loginAttemptsTable.success, false), gte(loginAttemptsTable.createdAt, since)];
  if (companyIds) {
    if (companyIds.length === 0) {
      failedConds.push(sql`false`);
    } else {
      const userRows = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(inArray(usersTable.companyId, companyIds));
      const ids = userRows.map((u) => u.id);
      failedConds.push(ids.length > 0 ? inArray(loginAttemptsTable.userId, ids) : sql`false`);
    }
  }
  const failedWhere = and(...failedConds);

  const [aggRow] = await db
    .select({
      failedLogins: sql<number>`count(*)::int`,
      distinctFailedIps: sql<number>`count(distinct ${loginAttemptsTable.ipAddress})::int`,
    })
    .from(loginAttemptsTable)
    .where(failedWhere);

  const grouped = await db
    .select({ email: loginAttemptsTable.email, c: sql<number>`count(*)::int` })
    .from(loginAttemptsTable)
    .where(failedWhere)
    .groupBy(loginAttemptsTable.email);
  const lockouts = grouped.filter((g) => g.c >= threshold).length;

  const blockConds: SQL[] = [eq(securityEventsTable.type, "login_policy_blocked"), gte(securityEventsTable.createdAt, since)];
  if (companyIds) {
    blockConds.push(companyIds.length > 0 ? inArray(securityEventsTable.companyId, companyIds) : sql`false`);
  }
  const [blockRow] = await db
    .select({ policyBlocks: sql<number>`count(*)::int` })
    .from(securityEventsTable)
    .where(and(...blockConds));

  return {
    failedLogins: aggRow?.failedLogins ?? 0,
    distinctFailedIps: aggRow?.distinctFailedIps ?? 0,
    lockouts,
    policyBlocks: blockRow?.policyBlocks ?? 0,
  };
}
