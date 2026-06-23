import { Router } from "express";
import type { Response } from "express";
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
import { requireAuth, evaluateCompanyAccess, normalizeRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { writeAudit } from "../lib/audit.js";
import { config } from "../config.js";
import {
  signMfaChallenge,
  verifyMfaChallenge,
} from "../lib/tokens.js";
import { createSession, rotateSession, revokeSession, revokeOtherSessions, listActiveSessions } from "../lib/sessions.js";
import {
  validatePassword,
  checkLockout,
  recordLoginAttempt,
  getClientIp,
  parseDevice,
} from "../lib/security.js";
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

const router = Router();

const REFRESH_COOKIE = "csp_refresh";
const CSRF_COOKIE = "csp_csrf";
const DEVICE_COOKIE = "csp_device";

function refreshCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: "lax" as const,
    path: "/api/auth",
    expires: expiresAt,
  };
}

function deviceCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: "lax" as const,
    path: "/api/auth",
    expires: expiresAt,
  };
}

// Sets the refresh token (httpOnly) plus a readable double-submit CSRF token, so
// the cookie-based refresh path can be protected against CSRF.
function setAuthCookies(res: Response, refreshToken: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(expiresAt));
  res.cookie(CSRF_COOKIE, randomToken(16), {
    httpOnly: false,
    secure: config.security.cookieSecure,
    sameSite: "lax",
    path: "/api/auth",
    expires: expiresAt,
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.clearCookie(CSRF_COOKIE, { path: "/api/auth" });
}

async function accessibleCompaniesFor(userId: number, companyId: number | null): Promise<number[]> {
  const rows = await db
    .select({ companyId: userCompanyAccessTable.companyId })
    .from(userCompanyAccessTable)
    .where(eq(userCompanyAccessTable.userId, userId));
  return Array.from(new Set([...(companyId ? [companyId] : []), ...rows.map((r) => r.companyId)]));
}

type UserRow = typeof usersTable.$inferSelect;

async function buildUserResponse(user: UserRow, companyName: string | null) {
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

async function companyNameFor(companyId: number | null): Promise<string | null> {
  if (!companyId) return null;
  const [c] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  return c?.name ?? null;
}

// Returns the matching, unexpired trusted-device row for this user from the
// device cookie, or null. Used to skip the MFA challenge on remembered devices.
async function findTrustedDevice(req: AuthRequest, userId: number) {
  const raw = req.cookies?.[DEVICE_COOKIE];
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

// Issues a fresh session and writes auth cookies. Shared by the password-only
// and the MFA-completed login branches.
async function completeLogin(req: AuthRequest, res: Response, user: UserRow, rememberMe: boolean, status = 200) {
  await db.update(usersTable).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
  const { accessToken, refreshToken, expiresAt } = await createSession(
    { id: user.id, email: user.email, role: normalizeRole(user.role), companyId: user.companyId },
    req,
    rememberMe,
  );
  setAuthCookies(res, refreshToken, expiresAt);
  await recordLoginAttempt({ email: user.email, ip: getClientIp(req), userId: user.id, success: true, userAgent: req.headers["user-agent"] ?? null });
  await writeAudit(req, { action: "user.login", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
  const companyName = await companyNameFor(user.companyId);
  res.status(status).json({ token: accessToken, refreshToken, user: await buildUserResponse(user, companyName) });
}

function checkCompanyAccessOrThrow(company: Pick<Company, "status" | "trialEndsAt"> | undefined): string | null {
  if (!company) return null;
  const access = evaluateCompanyAccess(company);
  return access.blocked ? access.reason : null;
}

// POST /auth/login
router.post("/auth/login", async (req: AuthRequest, res) => {
  try {
    const { email, password, rememberMe } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: "Email and password required" });
      return;
    }
    const ip = getClientIp(req);
    const lockout = await checkLockout(email, ip);
    if (lockout.locked) {
      res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lockout.retryAfterSeconds / 60)} minute(s).`, retryAfter: lockout.retryAfterSeconds });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !comparePassword(password, user.passwordHash)) {
      await recordLoginAttempt({ email, ip, userId: user?.id ?? null, success: false, reason: "invalid_credentials", userAgent: req.headers["user-agent"] ?? null });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (!user.isActive) {
      await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "account_disabled", userAgent: req.headers["user-agent"] ?? null });
      res.status(401).json({ error: "Account is disabled" });
      return;
    }

    if (user.companyId) {
      const [c] = await db
        .select({ status: companiesTable.status, trialEndsAt: companiesTable.trialEndsAt })
        .from(companiesTable)
        .where(eq(companiesTable.id, user.companyId))
        .limit(1);
      const blockedReason = checkCompanyAccessOrThrow(c);
      if (blockedReason) {
        await recordLoginAttempt({ email, ip, userId: user.id, success: false, reason: "company_blocked", userAgent: req.headers["user-agent"] ?? null });
        res.status(403).json({ error: blockedReason });
        return;
      }
    }

    // MFA: required either by the user's own enrollment or a company-wide policy.
    const [company] = user.companyId
      ? await db.select({ mfaRequired: companiesTable.mfaRequired }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1)
      : [undefined];
    const mfaNeeded = user.mfaEnabled || (company?.mfaRequired ?? false);
    const trusted = mfaNeeded ? await findTrustedDevice(req, user.id) : null;

    if (mfaNeeded && !trusted) {
      // Password verified; defer success logging until the second factor is
      // satisfied. No operational token is issued here.
      const mfaToken = signMfaChallenge(user.id);
      if (user.mfaEnabled) {
        // Enrolled user: challenge for a TOTP / backup code.
        res.json({ mfaRequired: true, mfaToken });
      } else {
        // Company policy mandates MFA but this user has not enrolled. Block the
        // session and require enrollment first (closes the policy bypass).
        res.json({ mfaRequired: true, mfaEnrollmentRequired: true, mfaToken });
      }
      return;
    }

    if (trusted) {
      await db.update(trustedDevicesTable).set({ lastUsedAt: new Date() }).where(eq(trustedDevicesTable.id, trusted.id));
    }
    await completeLogin(req, res, user, Boolean(rememberMe));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/mfa/verify-login — second factor after a password-verified challenge.
router.post("/auth/mfa/verify-login", async (req: AuthRequest, res) => {
  try {
    const { mfaToken, code, rememberMe, rememberDevice } = req.body ?? {};
    if (!mfaToken || !code) {
      res.status(400).json({ error: "mfaToken and code are required" });
      return;
    }
    const userId = verifyMfaChallenge(mfaToken);
    if (!userId) {
      res.status(401).json({ error: "MFA session expired. Please sign in again." });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecret) {
      res.status(401).json({ error: "MFA is not available for this account." });
      return;
    }

    const ip = getClientIp(req);
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
      await recordLoginAttempt({ email: user.email, ip, userId: user.id, success: false, reason: "mfa_failed", userAgent: req.headers["user-agent"] ?? null });
      res.status(401).json({ error: "Invalid verification code" });
      return;
    }

    if (rememberDevice) {
      const deviceToken = randomToken(32);
      const device = parseDevice(req);
      const expiresAt = new Date(Date.now() + config.auth.trustedDeviceTtlDays * 24 * 60 * 60 * 1000);
      await db.insert(trustedDevicesTable).values({
        userId: user.id,
        tokenHash: sha256(deviceToken),
        label: device.browser,
        userAgent: device.userAgent,
        ipAddress: ip,
        expiresAt,
      });
      res.cookie(DEVICE_COOKIE, deviceToken, deviceCookieOptions(expiresAt));
    }

    if (usedBackup) {
      await writeAudit(req, { action: "user.mfa_backup_used", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
    }
    await completeLogin(req, res, user, Boolean(rememberMe));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/refresh — rotate the refresh token. Accepts the token from the body
// (SPA/mobile) or, as a fallback, the httpOnly cookie (which then requires a
// double-submit CSRF token to match).
router.post("/auth/refresh", async (req: AuthRequest, res) => {
  try {
    let refreshToken: string | undefined = req.body?.refreshToken;
    if (!refreshToken) {
      const cookieToken = req.cookies?.[REFRESH_COOKIE];
      if (cookieToken) {
        const csrfHeader = req.headers["x-csrf-token"];
        const csrfCookie = req.cookies?.[CSRF_COOKIE];
        if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
          res.status(403).json({ error: "CSRF validation failed" });
          return;
        }
        refreshToken = cookieToken;
      }
    }
    if (!refreshToken) {
      res.status(401).json({ error: "Refresh token required" });
      return;
    }

    const result = await rotateSession(refreshToken, req);
    if (!result.ok) {
      clearAuthCookies(res);
      res.status(result.status).json({ error: result.error });
      return;
    }
    setAuthCookies(res, result.tokens.refreshToken, result.tokens.expiresAt);
    res.json({ token: result.tokens.accessToken, refreshToken: result.tokens.refreshToken });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/register
router.post("/auth/register", async (req: AuthRequest, res) => {
  try {
    const { email, password, name, companyName, industry, country } = req.body ?? {};
    if (!email || !password || !name || !companyName) {
      res.status(400).json({ error: "email, password, name, companyName required" });
      return;
    }
    const pw = validatePassword(password);
    if (!pw.valid) {
      res.status(400).json({ error: pw.errors.join(". ") });
      return;
    }
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }

    const [freePlan] = await db.select().from(plansTable).where(eq(plansTable.id, "free")).limit(1);
    const trialDays = freePlan?.trialDays ?? 14;
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    const [company] = await db
      .insert(companiesTable)
      .values({ name: companyName, industry: industry ?? null, country: country ?? null, plan: "free", status: "trial", trialEndsAt })
      .returning();
    await db.insert(subscriptionsTable).values({
      companyId: company.id, plan: "free", status: "trial",
      scansUsed: 0, scansLimit: 50, usersLimit: 1,
      adminsLimit: freePlan?.adminsLimit ?? 1, employeesLimit: freePlan?.employeesLimit ?? 0,
      contactsLimit: freePlan?.contactsLimit ?? 50, eventsLimit: freePlan?.eventsLimit ?? 1,
      storageLimitMb: freePlan?.storageLimitMb ?? 100, apiLimit: freePlan?.apiLimit ?? 0,
      trialEndsAt: trialEndsAt.toISOString().slice(0, 10),
    });

    const passwordHash = hashPassword(password);
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, name, role: "primary_admin", companyId: company.id, isActive: true, contactVisibility: "all", companyVisibility: "own" })
      .returning();
    await db.update(companiesTable).set({ createdById: user.id }).where(eq(companiesTable.id, company.id));

    await db.insert(activityLogsTable).values({ type: "company_created", description: `New company registered: ${companyName}`, companyId: company.id, companyName, userId: user.id, userName: name });
    await writeAudit(req, { action: "company.register", userId: user.id, userName: user.email, companyId: company.id, entityType: "company", entityId: company.id, metadata: { companyName } });

    const { accessToken, refreshToken, expiresAt } = await createSession(
      { id: user.id, email: user.email, role: normalizeRole(user.role), companyId: user.companyId },
      req,
      false,
    );
    setAuthCookies(res, refreshToken, expiresAt);
    res.status(201).json({ token: accessToken, refreshToken, user: await buildUserResponse(user, company.name) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const companyName = await companyNameFor(user.companyId);
    res.json(await buildUserResponse(user, companyName));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/logout — revokes the current session and clears cookies.
router.post("/auth/logout", requireAuth, async (req: AuthRequest, res) => {
  try {
    if (req.user?.sessionId) {
      await revokeSession(req.user.sessionId, "logout");
    }
    clearAuthCookies(res);
    await writeAudit(req, { action: "user.logout", userId: req.user!.id, userName: req.user!.email, companyId: req.user!.companyId, entityType: "user", entityId: req.user!.id });
    res.json({ success: true, message: "Logged out" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/sessions — list the caller's active sessions.
router.get("/auth/sessions", requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessions = await listActiveSessions(req.user!.id, req.user!.sessionId ?? null);
    res.json({ sessions });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /auth/sessions — revoke all other sessions (keep the current one).
router.delete("/auth/sessions", requireAuth, async (req: AuthRequest, res) => {
  try {
    const count = await revokeOtherSessions(req.user!.id, req.user!.sessionId ?? -1, "terminate_others");
    await writeAudit(req, { action: "user.sessions_terminate_others", userId: req.user!.id, userName: req.user!.email, companyId: req.user!.companyId, entityType: "user", entityId: req.user!.id, metadata: { count } });
    res.json({ success: true, terminated: count });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /auth/sessions/:id — revoke one of the caller's sessions.
router.delete("/auth/sessions/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid session id" }); return; }
    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).limit(1);
    if (!session || session.userId !== req.user!.id) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await revokeSession(id, "terminated");
    if (id === req.user!.sessionId) clearAuthCookies(res);
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/mfa/status
router.get("/auth/mfa/status", requireAuth, async (req: AuthRequest, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    let companyRequired = false;
    if (user.companyId) {
      const [c] = await db.select({ mfaRequired: companiesTable.mfaRequired }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1);
      companyRequired = c?.mfaRequired ?? false;
    }
    const remaining = user.mfaEnabled
      ? await db.select({ id: mfaBackupCodesTable.id }).from(mfaBackupCodesTable).where(and(eq(mfaBackupCodesTable.userId, user.id), isNull(mfaBackupCodesTable.usedAt)))
      : [];
    res.json({ enabled: user.mfaEnabled, enrolledAt: user.mfaEnrolledAt, companyRequired, backupCodesRemaining: remaining.length });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/mfa/setup — generate a secret + QR. Stored encrypted but not yet
// enabled; the user must confirm a code via /auth/mfa/enable.
router.post("/auth/mfa/setup", requireAuth, async (req: AuthRequest, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (user.mfaEnabled) { res.status(400).json({ error: "MFA is already enabled" }); return; }
    const secret = generateMfaSecret();
    await db.update(usersTable).set({ mfaSecret: encryptMfaSecret(secret), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    const otpauthUrl = buildOtpauthUrl(user.email, secret);
    const qrDataUrl = await otpauthQrDataUrl(otpauthUrl);
    res.json({ secret, otpauthUrl, qrDataUrl });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/mfa/enable — confirm a TOTP code, enable MFA, issue backup codes.
router.post("/auth/mfa/enable", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { code } = req.body ?? {};
    if (!code) { res.status(400).json({ error: "Verification code is required" }); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user || !user.mfaSecret) { res.status(400).json({ error: "Start MFA setup first" }); return; }
    if (user.mfaEnabled) { res.status(400).json({ error: "MFA is already enabled" }); return; }
    const ok = await verifyTotp(decryptMfaSecret(user.mfaSecret), String(code));
    if (!ok) { res.status(400).json({ error: "Invalid verification code" }); return; }

    await db.update(usersTable).set({ mfaEnabled: true, mfaEnrolledAt: new Date(), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
    const codes = generateBackupCodes(10);
    await db.insert(mfaBackupCodesTable).values(codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })));
    await writeAudit(req, { action: "user.mfa_enabled", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
    res.json({ success: true, backupCodes: codes });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/mfa/disable — requires the account password.
router.post("/auth/mfa/disable", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { password } = req.body ?? {};
    if (!password) { res.status(400).json({ error: "Password is required" }); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (!comparePassword(password, user.passwordHash)) { res.status(401).json({ error: "Incorrect password" }); return; }
    if (user.companyId) {
      const [c] = await db.select({ mfaRequired: companiesTable.mfaRequired }).from(companiesTable).where(eq(companiesTable.id, user.companyId)).limit(1);
      if (c?.mfaRequired) { res.status(403).json({ error: "Your company requires MFA. It cannot be disabled." }); return; }
    }
    await db.update(usersTable).set({ mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
    await writeAudit(req, { action: "user.mfa_disabled", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/mfa/backup-codes — regenerate the backup-code set (requires password).
router.post("/auth/mfa/backup-codes", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { password } = req.body ?? {};
    if (!password) { res.status(400).json({ error: "Password is required" }); return; }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (!user.mfaEnabled) { res.status(400).json({ error: "MFA is not enabled" }); return; }
    if (!comparePassword(password, user.passwordHash)) { res.status(401).json({ error: "Incorrect password" }); return; }
    await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
    const codes = generateBackupCodes(10);
    await db.insert(mfaBackupCodesTable).values(codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })));
    await writeAudit(req, { action: "user.mfa_backup_regenerated", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
    res.json({ success: true, backupCodes: codes });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/change-password
router.post("/auth/change-password", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "currentPassword and newPassword are required" });
      return;
    }
    const pw = validatePassword(newPassword);
    if (!pw.valid) {
      res.status(400).json({ error: pw.errors.join(". ") });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!comparePassword(currentPassword, user.passwordHash)) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }
    await db
      .update(usersTable)
      .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
    // Revoke all OTHER sessions on a password change; keep the current one alive.
    await revokeOtherSessions(user.id, req.user!.sessionId ?? -1, "password_changed");
    await writeAudit(req, {
      action: "user.change_password",
      userId: user.id,
      userName: user.email,
      companyId: user.companyId,
      entityType: "user",
      entityId: user.id,
    });
    res.json({ success: true, message: "Password updated" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
