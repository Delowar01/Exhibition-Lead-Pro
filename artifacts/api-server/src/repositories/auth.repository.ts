import {
  db,
  usersTable,
  companiesTable,
  subscriptionsTable,
  activityLogsTable,
  plansTable,
  userCompanyAccessTable,
  sessionsTable,
  trustedDevicesTable,
  mfaBackupCodesTable,
  type Company,
} from "@workspace/db";
import { and, eq, isNull, gt } from "drizzle-orm";
import { exec, type Executor } from "./base.js";

export type UserRow = typeof usersTable.$inferSelect;
export type TrustedDeviceRow = typeof trustedDevicesTable.$inferSelect;
export type SessionRow = typeof sessionsTable.$inferSelect;
export type PlanRow = typeof plansTable.$inferSelect;
export type BackupCodeRow = typeof mfaBackupCodesTable.$inferSelect;

// ---- users ----

export async function findUserById(id: number): Promise<UserRow | undefined> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  return user;
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  return user;
}

export async function findUserIdByEmail(email: string): Promise<{ id: number } | undefined> {
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  return existing;
}

export async function insertUser(values: typeof usersTable.$inferInsert, tx?: Executor): Promise<UserRow> {
  const [user] = await exec(tx).insert(usersTable).values(values).returning();
  return user;
}

export async function updateUser(id: number, data: Partial<typeof usersTable.$inferInsert>): Promise<void> {
  await db.update(usersTable).set(data).where(eq(usersTable.id, id));
}

// ---- companies ----

export async function findCompanyName(companyId: number): Promise<{ name: string } | undefined> {
  const [c] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  return c;
}

export async function findCompanyAccessInfo(companyId: number): Promise<Pick<Company, "status" | "trialEndsAt"> | undefined> {
  const [c] = await db
    .select({ status: companiesTable.status, trialEndsAt: companiesTable.trialEndsAt })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  return c;
}

export async function findCompanyMfaRequired(companyId: number): Promise<{ mfaRequired: boolean } | undefined> {
  const [c] = await db
    .select({ mfaRequired: companiesTable.mfaRequired })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  return c;
}

export async function insertCompany(values: typeof companiesTable.$inferInsert, tx?: Executor): Promise<Company> {
  const [company] = await exec(tx).insert(companiesTable).values(values).returning();
  return company;
}

export async function updateCompany(id: number, data: Partial<typeof companiesTable.$inferInsert>, tx?: Executor): Promise<void> {
  await exec(tx).update(companiesTable).set(data).where(eq(companiesTable.id, id));
}

// ---- trusted_devices ----

export async function findTrustedDeviceByHash(userId: number, tokenHash: string): Promise<TrustedDeviceRow | undefined> {
  const [device] = await db
    .select()
    .from(trustedDevicesTable)
    .where(
      and(
        eq(trustedDevicesTable.userId, userId),
        eq(trustedDevicesTable.tokenHash, tokenHash),
        gt(trustedDevicesTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return device;
}

export async function touchTrustedDevice(id: number): Promise<void> {
  await db.update(trustedDevicesTable).set({ lastUsedAt: new Date() }).where(eq(trustedDevicesTable.id, id));
}

export async function insertTrustedDevice(values: typeof trustedDevicesTable.$inferInsert): Promise<void> {
  await db.insert(trustedDevicesTable).values(values);
}

// ---- sessions ----

export async function findSessionById(id: number): Promise<SessionRow | undefined> {
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).limit(1);
  return session;
}

// ---- mfa_backup_codes ----

export async function findActiveBackupCode(userId: number, codeHash: string): Promise<BackupCodeRow | undefined> {
  const [backup] = await db
    .select()
    .from(mfaBackupCodesTable)
    .where(and(eq(mfaBackupCodesTable.userId, userId), eq(mfaBackupCodesTable.codeHash, codeHash), isNull(mfaBackupCodesTable.usedAt)))
    .limit(1);
  return backup;
}

export async function markBackupCodeUsed(id: number): Promise<void> {
  await db.update(mfaBackupCodesTable).set({ usedAt: new Date() }).where(eq(mfaBackupCodesTable.id, id));
}

export async function findUnusedBackupCodes(userId: number): Promise<{ id: number }[]> {
  return db
    .select({ id: mfaBackupCodesTable.id })
    .from(mfaBackupCodesTable)
    .where(and(eq(mfaBackupCodesTable.userId, userId), isNull(mfaBackupCodesTable.usedAt)));
}

export async function deleteBackupCodes(userId: number): Promise<void> {
  await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, userId));
}

export async function insertBackupCodes(values: (typeof mfaBackupCodesTable.$inferInsert)[]): Promise<void> {
  await db.insert(mfaBackupCodesTable).values(values);
}

// ---- plans ----

export async function findPlanById(id: string): Promise<PlanRow | undefined> {
  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, id)).limit(1);
  return plan;
}

// ---- subscriptions ----

export async function insertSubscription(values: typeof subscriptionsTable.$inferInsert): Promise<void> {
  await db.insert(subscriptionsTable).values(values);
}

// ---- activity_logs ----

export async function insertActivityLog(values: typeof activityLogsTable.$inferInsert, tx?: Executor): Promise<void> {
  await exec(tx).insert(activityLogsTable).values(values);
}

// ---- user_company_access ----

export async function findAccessibleCompanyIds(userId: number): Promise<{ companyId: number }[]> {
  return db
    .select({ companyId: userCompanyAccessTable.companyId })
    .from(userCompanyAccessTable)
    .where(eq(userCompanyAccessTable.userId, userId));
}
