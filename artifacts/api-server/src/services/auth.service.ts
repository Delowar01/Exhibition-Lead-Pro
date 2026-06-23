import { db } from "@workspace/db";
import {
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
import { hashPassword, comparePassword } from "../lib/auth.js";
import { evaluateCompanyAccess, normalizeRole } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { verifyMfaChallenge } from "../lib/tokens.js";
import { revokeSession, revokeOtherSessions } from "../lib/sessions.js";
import { validatePassword, checkLockout, recordLoginAttempt } from "../lib/security.js";
import {
  generateMfaSecret,
  buildOtpauthUrl,
  otpauthQrDataUrl,
  verifyTotp,
  encryptMfaSecret,
  decryptMfaSecret,
  generateBackupCodes,
  hashBackupCode,
} from "../lib/mfa.js";
import { sha256 } from "../lib/crypto.js";

type UserRow = typeof usersTable.$inferSelect;

async function accessibleCompaniesFor(userId: number, companyId: number | null): Promise<number[]> {
  const rows = await db
    .select({ companyId: userCompanyAccessTable.companyId })
    .from(userCompanyAccessTable)
    .where(eq(userCompanyAccessTable.userId, userId));
  return Array.from(new Set([...(companyId ? [companyId] : []), ...rows.map((r) => r.companyId)]));
}

export async function buildUserResponse(user: UserRow, companyName: string | null) {
  const accessibleCompanies = await accessibleCompaniesFor(user.id, user.companyId);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: normalizeRole(user.role),
    phone: user.phone,
    companyId: user.companyId,
    companyName,
    avatarUrl: user.avatarUrl,
    permissions: user.permissions ?? {},
    contactVisibility: user.contactVisibility,
    companyVisibility: user.companyVisibility,
    accessibleCompanies,
    mfaEnabled: user.mfaEnabled,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export async function markLoggedIn(userId: number): Promise<void> {
  await db.update(usersTable).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, userId));
}

export async function companyNameFor(companyId: number | null): Promise<string | null> {
  if (!companyId) return null;
  const [c] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  return c?.name ?? null;
}

// Returns the matching, unexpired trusted-device row for this user from the
// raw device-cookie value, or null. Used to skip the MFA challenge.
export async function findTrustedDevice(raw: unknown, userId: number) {
  if (!raw || typeof raw !== "string") return null;
  const tokenHash = sha256(raw);
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
  return device ?? null;
}

export async function touchTrustedDevice(id: number) {
  await db.update(trustedDevicesTable).set({ lastUsedAt: new Date() }).where(eq(trustedDevicesTable.id, id));
}

export async function insertTrustedDevice(values: {
  userId: number;
  tokenHash: string;
  label: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
}) {
  await db.insert(trustedDevicesTable).values(values);
}

function checkCompanyAccessOrThrow(company: Pick<Company, "status" | "trialEndsAt"> | undefined): string | null {
  if (!company) return null;
  const access = evaluateCompanyAccess(company);
  return access.blocked ? access.reason : null;
}

export type LoginOutcome =
  | { kind: "locked"; message: string; retryAfterSeconds: number }
  | { kind: "ok"; user: UserRow; mfaNeeded: boolean };

export async function authenticateLogin(params: {
  email?: string;
  password?: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<LoginOutcome> {
  const { email, password, ip, userAgent } = params;
  if (!email || !password) throw new AppError(400, "Email and password required");

  const lockout = await checkLockout(email, ip);
  if (lockout.locked) {
    return {
      kind: "locked",
      message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`,
      retryAfterSeconds: lockout.retryAfterSeconds,
    };
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user || !comparePassword(password, user.passwordHash)) {
    await recordLoginAttempt({ email, ip, userId: user?.id ?? null, success: false, reason: "invalid_credentials", userAgent });
    throw new AppError(401, "Invalid credentials");
  }
  if (!user.isActive) {
    await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "account_disabled", userAgent });
    throw new AppError(401, "Account is disabled");
  }

  if (user.companyId) {
    const [c] = await db
      .select({ status: companiesTable.status, trialEndsAt: companiesTable.trialEndsAt })
      .from(companiesTable)
      .where(eq(companiesTable.id, user.companyId))
      .limit(1);
    const blockedReason = checkCompanyAccessOrThrow(c);
    if (blockedReason) {
      await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "company_blocked", userAgent });
      throw new AppError(403, blockedReason);
    }
  }

  // MFA: required either by the user's own enrollment or a company-wide policy.
  const [company] = user.companyId
    ? await db.select({ mfaRequired: companiesTable.mfaRequired }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1)
    : [undefined];
  const mfaNeeded = user.mfaEnabled || (company?.mfaRequired ?? false);
  return { kind: "ok", user, mfaNeeded };
}

export async function verifyMfaLogin(params: {
  mfaToken?: string;
  code?: unknown;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ user: UserRow; usedBackup: boolean }> {
  const { mfaToken, code, ip, userAgent } = params;
  if (!mfaToken || !code) throw new AppError(400, "mfaToken and code are required");
  const userId = verifyMfaChallenge(mfaToken);
  if (!userId) throw new AppError(401, "MFA session expired. Please sign in again.");
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecret) throw new AppError(401, "MFA is not available for this account.");

  let verified = await verifyTotp(decryptMfaSecret(user.mfaSecret), String(code));
  let usedBackup = false;
  if (!verified) {
    // Fall back to a single-use backup code.
    const hash = hashBackupCode(String(code));
    const [backup] = await db
      .select()
      .from(mfaBackupCodesTable)
      .where(and(eq(mfaBackupCodesTable.userId, user.id), eq(mfaBackupCodesTable.codeHash, hash), isNull(mfaBackupCodesTable.usedAt)))
      .limit(1);
    if (backup) {
      await db.update(mfaBackupCodesTable).set({ usedAt: new Date() }).where(eq(mfaBackupCodesTable.id, backup.id));
      verified = true;
      usedBackup = true;
    }
  }
  if (!verified) {
    await recordLoginAttempt({ email: user.email, ip, userId: user.id, success: false, reason: "mfa_failed", userAgent });
    throw new AppError(401, "Invalid verification code");
  }
  return { user, usedBackup };
}

export async function registerCompany(input: {
  email?: string;
  password?: string;
  name?: string;
  companyName?: string;
  industry?: string;
  country?: string;
}): Promise<{ user: UserRow; company: Company }> {
  const { email, password, name, companyName, industry, country } = input;
  if (!email || !password || !name || !companyName) throw new AppError(400, "email, password, name, companyName required");
  const pw = validatePassword(password);
  if (!pw.valid) throw new AppError(400, pw.errors.join(". "));
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) throw new AppError(400, "Email already registered");

  const [freePlan] = await db.select().from(plansTable).where(eq(plansTable.id, "free")).limit(1);
  const trialDays = freePlan?.trialDays ?? 14;
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

  const [company] = await db
    .insert(companiesTable)
    .values({ name: companyName, industry: industry ?? null, country: country ?? null, plan: "free", status: "trial", trialEndsAt })
    .returning();
  await db.insert(subscriptionsTable).values({
    companyId: company.id,
    plan: "free",
    status: "trial",
    scansUsed: 0,
    scansLimit: 50,
    usersLimit: 1,
    adminsLimit: freePlan?.adminsLimit ?? 1,
    employeesLimit: freePlan?.employeesLimit ?? 0,
    contactsLimit: freePlan?.contactsLimit ?? 50,
    eventsLimit: freePlan?.eventsLimit ?? 1,
    storageLimitMb: freePlan?.storageLimitMb ?? 100,
    apiLimit: freePlan?.apiLimit ?? 0,
    trialEndsAt: trialEndsAt.toISOString().slice(0, 10),
  });

  const passwordHash = hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, name, role: "primary_admin", companyId: company.id, isActive: true, contactVisibility: "all", companyVisibility: "own" })
    .returning();
  await db.update(companiesTable).set({ createdById: user.id }).where(eq(companiesTable.id, company.id));

  await db.insert(activityLogsTable).values({ type: "company_created", description: `New company registered: ${companyName}`, companyId: company.id, companyName, userId: user.id, userName: name });

  return { user, company };
}

export async function getMe(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new AppError(404, "User not found");
  const companyName = await companyNameFor(user.companyId);
  return buildUserResponse(user, companyName);
}

export async function revokeUserSession(userId: number, id: number): Promise<void> {
  if (!Number.isInteger(id)) throw new AppError(400, "Invalid session id");
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).limit(1);
  if (!session || session.userId !== userId) throw new AppError(404, "Session not found");
  await revokeSession(id, "terminated");
}

export async function mfaStatus(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new AppError(404, "User not found");
  let companyRequired = false;
  if (user.companyId) {
    const [c] = await db.select({ mfaRequired: companiesTable.mfaRequired }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1);
    companyRequired = c?.mfaRequired ?? false;
  }
  const remaining = user.mfaEnabled
    ? await db.select({ id: mfaBackupCodesTable.id }).from(mfaBackupCodesTable).where(and(eq(mfaBackupCodesTable.userId, user.id), isNull(mfaBackupCodesTable.usedAt)))
    : [];
  return { enabled: user.mfaEnabled, enrolledAt: user.mfaEnrolledAt, companyRequired, backupCodesRemaining: remaining.length };
}

export async function mfaSetup(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new AppError(404, "User not found");
  if (user.mfaEnabled) throw new AppError(400, "MFA is already enabled");
  const secret = generateMfaSecret();
  await db.update(usersTable).set({ mfaSecret: encryptMfaSecret(secret), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
  const otpauthUrl = buildOtpauthUrl(user.email, secret);
  const qrDataUrl = await otpauthQrDataUrl(otpauthUrl);
  return { secret, otpauthUrl, qrDataUrl };
}

export async function mfaEnable(userId: number, code?: unknown): Promise<{ user: UserRow; backupCodes: string[] }> {
  if (!code) throw new AppError(400, "Verification code is required");
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || !user.mfaSecret) throw new AppError(400, "Start MFA setup first");
  if (user.mfaEnabled) throw new AppError(400, "MFA is already enabled");
  const ok = await verifyTotp(decryptMfaSecret(user.mfaSecret), String(code));
  if (!ok) throw new AppError(400, "Invalid verification code");

  await db.update(usersTable).set({ mfaEnabled: true, mfaEnrolledAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
  await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
  const codes = generateBackupCodes(10);
  await db.insert(mfaBackupCodesTable).values(codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })));
  return { user, backupCodes: codes };
}

export async function mfaDisable(userId: number, password?: string): Promise<UserRow> {
  if (!password) throw new AppError(400, "Password is required");
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new AppError(404, "User not found");
  if (!comparePassword(password, user.passwordHash)) throw new AppError(401, "Incorrect password");
  if (user.companyId) {
    const [c] = await db.select({ mfaRequired: companiesTable.mfaRequired }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1);
    if (c?.mfaRequired) throw new AppError(403, "Your company requires MFA. It cannot be disabled.");
  }
  await db.update(usersTable).set({ mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
  await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
  return user;
}

export async function regenerateBackupCodes(userId: number, password?: string): Promise<{ user: UserRow; backupCodes: string[] }> {
  if (!password) throw new AppError(400, "Password is required");
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new AppError(404, "User not found");
  if (!user.mfaEnabled) throw new AppError(400, "MFA is not enabled");
  if (!comparePassword(password, user.passwordHash)) throw new AppError(401, "Incorrect password");
  await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
  const codes = generateBackupCodes(10);
  await db.insert(mfaBackupCodesTable).values(codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })));
  return { user, backupCodes: codes };
}

export async function changePassword(
  userId: number,
  currentSessionId: number | null,
  currentPassword?: string,
  newPassword?: string,
): Promise<UserRow> {
  if (!currentPassword || !newPassword) throw new AppError(400, "currentPassword and newPassword are required");
  const pw = validatePassword(newPassword);
  if (!pw.valid) throw new AppError(400, pw.errors.join(". "));
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new AppError(404, "User not found");
  if (!comparePassword(currentPassword, user.passwordHash)) throw new AppError(401, "Current password is incorrect");
  await db.update(usersTable).set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
  // Revoke all OTHER sessions on a password change; keep the current one alive.
  await revokeOtherSessions(user.id, currentSessionId ?? -1, "password_changed");
  return user;
}
