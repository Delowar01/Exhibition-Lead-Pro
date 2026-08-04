import { type Company } from "@workspace/db";
import { hashPassword, comparePassword } from "../lib/auth.js";
import { evaluateCompanyAccess, normalizeRole } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { signMfaChallenge, verifyMfaChallenge } from "../lib/tokens.js";
import { revokeSession, revokeOtherSessions } from "../lib/sessions.js";
import { validatePassword, checkLockout, recordLoginAttempt } from "../lib/security.js";
import * as securityService from "./security.service.js";
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
import { sha256, randomToken } from "../lib/crypto.js";
import { config } from "../config.js";
import * as authRepo from "../repositories/auth.repository.js";
import * as tokenRepo from "../repositories/verification_tokens.repository.js";
import { sendPasswordResetEmail, sendEmailVerificationEmail } from "../lib/email/index.js";

type UserRow = authRepo.UserRow;

async function accessibleCompaniesFor(userId: number, companyId: number | null): Promise<number[]> {
  const rows = await authRepo.findAccessibleCompanyIds(userId);
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
  await authRepo.updateUser(userId, { lastLoginAt: new Date(), updatedAt: new Date() });
}

export async function companyNameFor(companyId: number | null): Promise<string | null> {
  if (!companyId) return null;
  const c = await authRepo.findCompanyName(companyId);
  return c?.name ?? null;
}

// Returns the matching, unexpired trusted-device row for this user from the
// raw device-cookie value, or null. Used to skip the MFA challenge.
export async function findTrustedDevice(raw: unknown, userId: number) {
  if (!raw || typeof raw !== "string") return null;
  const tokenHash = sha256(raw);
  const device = await authRepo.findTrustedDeviceByHash(userId, tokenHash);
  return device ?? null;
}

export async function touchTrustedDevice(id: number) {
  await authRepo.touchTrustedDevice(id);
}

export async function insertTrustedDevice(values: {
  userId: number;
  tokenHash: string;
  label: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
}) {
  await authRepo.insertTrustedDevice(values);
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
  country?: string | null;
}): Promise<LoginOutcome> {
  const { email, password, ip, userAgent, country = null } = params;
  if (!email || !password) throw new AppError(400, "Email and password required");

  const lockout = await checkLockout(email, ip);
  if (lockout.locked) {
    return {
      kind: "locked",
      message: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`,
      retryAfterSeconds: lockout.retryAfterSeconds,
    };
  }

  const user = await authRepo.findUserByEmail(email);
  if (!user || !comparePassword(password, user.passwordHash)) {
    await recordLoginAttempt({ email, ip, userId: user?.id ?? null, success: false, reason: "invalid_credentials", userAgent });
    throw new AppError(401, "Invalid credentials");
  }
  if (!user.isActive) {
    await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "account_disabled", userAgent });
    throw new AppError(401, "Account is disabled");
  }

  if (user.companyId) {
    const c = await authRepo.findCompanyAccessInfo(user.companyId);
    const blockedReason = checkCompanyAccessOrThrow(c);
    if (blockedReason) {
      await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "company_blocked", userAgent });
      throw new AppError(403, blockedReason);
    }

    // Security Center policy enforcement (domain / IP / country). Runs only after
    // the password is verified, so it never leaks account existence. Empty policy
    // lists impose no restriction → no-op for companies without a configured policy.
    const policyBlock = await securityService.evaluateLoginPolicy({ companyId: user.companyId, email, ip, country });
    if (policyBlock) {
      await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "policy_blocked", userAgent });
      await securityService.recordLoginBlock({ companyId: user.companyId, userId: user.id, email, ip, reason: policyBlock });
      throw new AppError(403, policyBlock);
    }
  }

  // MFA: required either by the user's own enrollment or a company-wide policy.
  const company = user.companyId ? await authRepo.findCompanyMfaRequired(user.companyId) : undefined;
  const mfaNeeded = user.mfaEnabled || (company?.mfaRequired ?? false);
  return { kind: "ok", user, mfaNeeded };
}

// Mints a password-verified MFA challenge: a short-lived JWT whose `jti` is backed
// by a single-use verification_tokens row. verifyMfaLogin consumes the row on the
// first successful verification, so a captured challenge cannot be replayed to
// mint a second session. TTL mirrors config.auth.mfaChallengeTtl ("10m").
const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export async function issueMfaChallenge(userId: number): Promise<string> {
  const jti = randomToken(24);
  await tokenRepo.insertToken({
    userId,
    type: "mfa_challenge",
    tokenHash: sha256(jti),
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
  });
  return signMfaChallenge(userId, jti);
}

export async function verifyMfaLogin(params: {
  mfaToken?: string;
  code?: unknown;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ user: UserRow; usedBackup: boolean }> {
  const { mfaToken, code, ip, userAgent } = params;
  if (!mfaToken || !code) throw new AppError(400, "mfaToken and code are required");
  const challenge = verifyMfaChallenge(mfaToken);
  if (!challenge) throw new AppError(401, "MFA session expired. Please sign in again.");
  const userId = challenge.uid;
  const user = await authRepo.findUserById(userId);
  if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecret) throw new AppError(401, "MFA is not available for this account.");

  let verified = await verifyTotp(decryptMfaSecret(user.mfaSecret), String(code));
  let usedBackup = false;
  if (!verified) {
    // Fall back to a single-use backup code.
    const hash = hashBackupCode(String(code));
    const backup = await authRepo.findActiveBackupCode(user.id, hash);
    if (backup) {
      await authRepo.markBackupCodeUsed(backup.id);
      verified = true;
      usedBackup = true;
    }
  }
  if (!verified) {
    await recordLoginAttempt({ email: user.email, ip, userId: user.id, success: false, reason: "mfa_failed", userAgent });
    throw new AppError(401, "Invalid verification code");
  }

  // Single-use consumption AFTER the code check (a wrong code must not burn the
  // challenge — the user may retry with the same mfaToken). The conditional UPDATE
  // in consumeToken is atomic, so a replayed challenge — even with a fresh valid
  // TOTP — fails here and cannot mint a second session.
  const live = await tokenRepo.findLiveToken(sha256(challenge.jti), "mfa_challenge");
  if (!live || live.userId !== user.id || !(await tokenRepo.consumeToken(live.id))) {
    await recordLoginAttempt({ email: user.email, ip, userId: user.id, success: false, reason: "mfa_challenge_replayed", userAgent });
    throw new AppError(401, "MFA session expired. Please sign in again.");
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
  const existing = await authRepo.findUserIdByEmail(email);
  if (existing) throw new AppError(400, "Email already registered");

  const freePlan = await authRepo.findPlanById("free");
  const trialDays = freePlan?.trialDays ?? 14;
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

  const company = await authRepo.insertCompany({ name: companyName, industry: industry ?? null, country: country ?? null, plan: "free", status: "trial", trialEndsAt });
  await authRepo.insertSubscription({
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
  const user = await authRepo.insertUser({ email, passwordHash, name, role: "primary_admin", companyId: company.id, isActive: true, contactVisibility: "all", companyVisibility: "own" });
  await authRepo.updateCompany(company.id, { createdById: user.id });

  await authRepo.insertActivityLog({ type: "company_created", description: `New company registered: ${companyName}`, companyId: company.id, companyName, userId: user.id, userName: name });

  return { user, company };
}

export async function getMe(userId: number) {
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  const companyName = await companyNameFor(user.companyId);
  return buildUserResponse(user, companyName);
}

export async function revokeUserSession(userId: number, id: number): Promise<void> {
  if (!Number.isInteger(id)) throw new AppError(400, "Invalid session id");
  const session = await authRepo.findSessionById(id);
  if (!session || session.userId !== userId) throw new AppError(404, "Session not found");
  await revokeSession(id, "terminated");
}

export async function mfaStatus(userId: number) {
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  let companyRequired = false;
  if (user.companyId) {
    const c = await authRepo.findCompanyMfaRequired(user.companyId);
    companyRequired = c?.mfaRequired ?? false;
  }
  const remaining = user.mfaEnabled ? await authRepo.findUnusedBackupCodes(user.id) : [];
  return { enabled: user.mfaEnabled, enrolledAt: user.mfaEnrolledAt, companyRequired, backupCodesRemaining: remaining.length };
}

export async function mfaSetup(userId: number) {
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (user.mfaEnabled) throw new AppError(400, "MFA is already enabled");
  const secret = generateMfaSecret();
  await authRepo.updateUser(user.id, { mfaSecret: encryptMfaSecret(secret), updatedAt: new Date() });
  const otpauthUrl = buildOtpauthUrl(user.email, secret);
  const qrDataUrl = await otpauthQrDataUrl(otpauthUrl);
  return { secret, otpauthUrl, qrDataUrl };
}

export async function mfaEnable(userId: number, code?: unknown): Promise<{ user: UserRow; backupCodes: string[] }> {
  if (!code) throw new AppError(400, "Verification code is required");
  const user = await authRepo.findUserById(userId);
  if (!user || !user.mfaSecret) throw new AppError(400, "Start MFA setup first");
  if (user.mfaEnabled) throw new AppError(400, "MFA is already enabled");
  const ok = await verifyTotp(decryptMfaSecret(user.mfaSecret), String(code));
  if (!ok) throw new AppError(400, "Invalid verification code");

  await authRepo.updateUser(user.id, { mfaEnabled: true, mfaEnrolledAt: new Date(), updatedAt: new Date() });
  await authRepo.deleteBackupCodes(user.id);
  const codes = generateBackupCodes(10);
  await authRepo.insertBackupCodes(codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })));
  return { user, backupCodes: codes };
}

export async function mfaDisable(userId: number, password?: string): Promise<UserRow> {
  if (!password) throw new AppError(400, "Password is required");
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (!comparePassword(password, user.passwordHash)) throw new AppError(401, "Incorrect password");
  if (user.companyId) {
    const c = await authRepo.findCompanyMfaRequired(user.companyId);
    if (c?.mfaRequired) throw new AppError(403, "Your company requires MFA. It cannot be disabled.");
  }
  await authRepo.updateUser(user.id, { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null, updatedAt: new Date() });
  await authRepo.deleteBackupCodes(user.id);
  return user;
}

export async function regenerateBackupCodes(userId: number, password?: string): Promise<{ user: UserRow; backupCodes: string[] }> {
  if (!password) throw new AppError(400, "Password is required");
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (!user.mfaEnabled) throw new AppError(400, "MFA is not enabled");
  if (!comparePassword(password, user.passwordHash)) throw new AppError(401, "Incorrect password");
  await authRepo.deleteBackupCodes(user.id);
  const codes = generateBackupCodes(10);
  await authRepo.insertBackupCodes(codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })));
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
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (!comparePassword(currentPassword, user.passwordHash)) throw new AppError(401, "Current password is incorrect");
  await authRepo.updateUser(user.id, { passwordHash: hashPassword(newPassword), updatedAt: new Date() });
  // Revoke all OTHER sessions on a password change; keep the current one alive.
  await revokeOtherSessions(user.id, currentSessionId ?? -1, "password_changed");
  return user;
}

// ── Email-dependent flows (Phase 2.5) ────────────────────────────────────────
// Tokens are high-entropy random values; only their SHA-256 is stored. The raw
// token is mailed to the user and used to build the link. All flows degrade
// gracefully when email is unconfigured (the token is still issued + logged).

function buildLink(path: string, token: string): string {
  const base = config.email.appBaseUrl.replace(/\/$/, "");
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

// POST /auth/forgot-password — always resolves the same way regardless of whether
// the email exists, to avoid account enumeration. When the user exists, a single
// live reset token is issued (prior ones invalidated) and a reset email is sent.
export async function requestPasswordReset(email?: string): Promise<void> {
  if (!email || typeof email !== "string") return;
  const user = await authRepo.findUserByEmail(email.trim().toLowerCase());
  if (!user || !user.isActive) return;
  await tokenRepo.invalidateOutstanding(user.id, "password_reset");
  const raw = randomToken(32);
  const expiresAt = new Date(Date.now() + config.tokens.passwordResetTtlMinutes * 60 * 1000);
  await tokenRepo.insertToken({ userId: user.id, type: "password_reset", tokenHash: sha256(raw), expiresAt });
  await sendPasswordResetEmail({ to: user.email, name: user.name, link: buildLink("/reset-password", raw) });
}

// POST /auth/reset-password — consumes a live reset token, sets the new password,
// and revokes ALL sessions (no session to preserve here). The token is consumed
// ATOMICALLY (conditional UPDATE) before the password is written, so a token can
// never be redeemed twice — even by two concurrent requests. Returns the user so
// the route can write an audit entry.
export async function resetPassword(token?: string, newPassword?: string) {
  if (!token || !newPassword) throw new AppError(400, "token and newPassword are required");
  const pw = validatePassword(newPassword);
  if (!pw.valid) throw new AppError(400, pw.errors.join(". "));
  const row = await tokenRepo.findLiveToken(sha256(token), "password_reset");
  if (!row) throw new AppError(400, "This reset link is invalid or has expired. Please request a new one.");
  const consumed = await tokenRepo.consumeToken(row.id);
  if (!consumed) throw new AppError(400, "This reset link is invalid or has expired. Please request a new one.");
  await authRepo.updateUser(row.userId, { passwordHash: hashPassword(newPassword), updatedAt: new Date() });
  // Belt-and-braces: kill any other outstanding reset tokens for this user too.
  await tokenRepo.invalidateOutstanding(row.userId, "password_reset");
  await revokeOtherSessions(row.userId, -1, "password_reset");
  return authRepo.findUserById(row.userId);
}

// POST /auth/resend-verification (authed) — issues a fresh verification token and
// emails it. No-op (idempotent success) when already verified.
export async function sendVerification(userId: number): Promise<{ alreadyVerified: boolean }> {
  const user = await authRepo.findUserById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  await tokenRepo.invalidateOutstanding(user.id, "email_verify");
  const raw = randomToken(32);
  const expiresAt = new Date(Date.now() + config.tokens.emailVerifyTtlHours * 60 * 60 * 1000);
  await tokenRepo.insertToken({ userId: user.id, type: "email_verify", tokenHash: sha256(raw), expiresAt });
  await sendEmailVerificationEmail({ to: user.email, name: user.name, link: buildLink("/verify-email", raw) });
  return { alreadyVerified: false };
}

// POST /auth/verify-email — consumes a live verification token and stamps the user
// as verified. Single-use; idempotent for an already-used-but-verified user.
export async function verifyEmail(token?: string): Promise<void> {
  if (!token) throw new AppError(400, "token is required");
  const row = await tokenRepo.findLiveToken(sha256(token), "email_verify");
  if (!row) throw new AppError(400, "This verification link is invalid or has expired. Please request a new one.");
  await authRepo.updateUser(row.userId, { emailVerifiedAt: new Date(), updatedAt: new Date() });
  await tokenRepo.markUsed(row.id);
}
