import { Router } from "express";
import type { Response } from "express";
import { requireAuth, normalizeRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { writeAudit } from "../lib/audit.js";
import { config } from "../config.js";
import { createSession, rotateSession, revokeSession, revokeOtherSessions, listActiveSessions } from "../lib/sessions.js";
import { getClientIp, getCountry, parseDevice, recordLoginAttempt } from "../lib/security.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import * as auth from "../services/auth.service.js";
import { validateBody } from "../middlewares/validate.js";
import {
  LoginBody,
  MfaVerifyLoginBody,
  RegisterBody,
  MfaEnableBody,
  MfaDisableBody,
  ForgotPasswordBody,
  ResetPasswordBody,
  VerifyEmailBody,
  ChangePasswordBody,
} from "@workspace/api-zod";

const router = Router();

const REFRESH_COOKIE = "csp_refresh";
const CSRF_COOKIE = "csp_csrf";
const DEVICE_COOKIE = "csp_device";

function refreshCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: "lax" as const,
    path: "/api",
    expires: expiresAt,
  };
}

function deviceCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: "lax" as const,
    path: "/api",
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
    path: "/api",
    expires: expiresAt,
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/api" });
  res.clearCookie(CSRF_COOKIE, { path: "/api" });
}

type UserRow = Parameters<typeof auth.buildUserResponse>[0];

// Issues a fresh session and writes auth cookies. Shared by the password-only
// and the MFA-completed login branches.
async function completeLogin(req: AuthRequest, res: Response, user: UserRow, rememberMe: boolean, status = 200) {
  await auth.markLoggedIn(user.id);
  const { accessToken, refreshToken, expiresAt } = await createSession(
    { id: user.id, email: user.email, role: normalizeRole(user.role), companyId: user.companyId },
    req,
    rememberMe,
  );
  setAuthCookies(res, refreshToken, expiresAt);
  await recordLoginAttempt({ email: user.email, ip: getClientIp(req), userId: user.id, success: true, userAgent: req.headers["user-agent"] ?? null });
  await writeAudit(req, { action: "user.login", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
  const companyName = await auth.companyNameFor(user.companyId);
  res.status(status).json({ token: accessToken, refreshToken, user: await auth.buildUserResponse(user, companyName) });
}

// POST /auth/login
router.post("/auth/login", validateBody(LoginBody), async (req: AuthRequest, res) => {
  const { email, password, rememberMe } = req.body ?? {};
  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] ?? null;

  const outcome = await auth.authenticateLogin({ email, password, ip, userAgent, country: getCountry(req) });
  if (outcome.kind === "locked") {
    res.status(429).json({ error: outcome.message, retryAfter: outcome.retryAfterSeconds });
    return;
  }
  const { user, mfaNeeded } = outcome;

  const trusted = mfaNeeded ? await auth.findTrustedDevice(req.cookies?.[DEVICE_COOKIE], user.id) : null;

  if (mfaNeeded && !trusted) {
    // Password verified; defer success logging until the second factor is
    // satisfied. No operational token is issued here.
    const mfaToken = await auth.issueMfaChallenge(user.id);
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
    await auth.touchTrustedDevice(trusted.id);
  }
  await completeLogin(req, res, user, Boolean(rememberMe));
});

// POST /auth/mfa/verify-login — second factor after a password-verified challenge.
router.post("/auth/mfa/verify-login", validateBody(MfaVerifyLoginBody), async (req: AuthRequest, res) => {
  const { mfaToken, code, rememberMe, rememberDevice } = req.body ?? {};
  const ip = getClientIp(req);
  const { user, usedBackup } = await auth.verifyMfaLogin({ mfaToken, code, ip, userAgent: req.headers["user-agent"] ?? null });

  if (rememberDevice) {
    const deviceToken = randomToken(32);
    const device = parseDevice(req);
    const expiresAt = new Date(Date.now() + config.auth.trustedDeviceTtlDays * 24 * 60 * 60 * 1000);
    await auth.insertTrustedDevice({
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
});

// POST /auth/refresh — rotate the refresh token. Accepts the token from the body
// (SPA/mobile) or, as a fallback, the httpOnly cookie (which then requires a
// double-submit CSRF token to match).
router.post("/auth/refresh", async (req: AuthRequest, res) => {
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
});

// POST /auth/register
router.post("/auth/register", validateBody(RegisterBody), async (req: AuthRequest, res) => {
  const { user, company } = await auth.registerCompany(req.body ?? {});
  await writeAudit(req, { action: "company.register", userId: user.id, userName: user.email, companyId: company.id, entityType: "company", entityId: company.id, metadata: { companyName: company.name } });
  const { accessToken, refreshToken, expiresAt } = await createSession(
    { id: user.id, email: user.email, role: normalizeRole(user.role), companyId: user.companyId },
    req,
    false,
  );
  setAuthCookies(res, refreshToken, expiresAt);
  res.status(201).json({ token: accessToken, refreshToken, user: await auth.buildUserResponse(user, company.name) });
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req: AuthRequest, res) => {
  res.json(await auth.getMe(req.user!.id));
});

// POST /auth/logout — revokes the current session and clears cookies.
router.post("/auth/logout", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.sessionId) {
    await revokeSession(req.user.sessionId, "logout");
  }
  clearAuthCookies(res);
  await writeAudit(req, { action: "user.logout", userId: req.user!.id, userName: req.user!.email, companyId: req.user!.companyId, entityType: "user", entityId: req.user!.id });
  res.json({ success: true, message: "Logged out" });
});

// GET /auth/sessions — list the caller's active sessions.
router.get("/auth/sessions", requireAuth, async (req: AuthRequest, res) => {
  const sessions = await listActiveSessions(req.user!.id, req.user!.sessionId ?? null);
  res.json({ sessions });
});

// DELETE /auth/sessions — revoke all other sessions (keep the current one).
router.delete("/auth/sessions", requireAuth, async (req: AuthRequest, res) => {
  const count = await revokeOtherSessions(req.user!.id, req.user!.sessionId ?? -1, "terminate_others");
  await writeAudit(req, { action: "user.sessions_terminate_others", userId: req.user!.id, userName: req.user!.email, companyId: req.user!.companyId, entityType: "user", entityId: req.user!.id, metadata: { count } });
  res.json({ success: true, terminated: count });
});

// DELETE /auth/sessions/:id — revoke one of the caller's sessions.
router.delete("/auth/sessions/:id", requireAuth, async (req: AuthRequest, res) => {
  const id = parseInt(String(req.params.id));
  await auth.revokeUserSession(req.user!.id, id);
  if (id === req.user!.sessionId) clearAuthCookies(res);
  res.json({ success: true });
});

// GET /auth/mfa/status
router.get("/auth/mfa/status", requireAuth, async (req: AuthRequest, res) => {
  res.json(await auth.mfaStatus(req.user!.id));
});

// POST /auth/mfa/setup — generate a secret + QR. Stored encrypted but not yet
// enabled; the user must confirm a code via /auth/mfa/enable.
router.post("/auth/mfa/setup", requireAuth, async (req: AuthRequest, res) => {
  res.json(await auth.mfaSetup(req.user!.id));
});

// POST /auth/mfa/enable — confirm a TOTP code, enable MFA, issue backup codes.
router.post("/auth/mfa/enable", requireAuth, validateBody(MfaEnableBody), async (req: AuthRequest, res) => {
  const { code } = req.body ?? {};
  const { user, backupCodes } = await auth.mfaEnable(req.user!.id, code);
  await writeAudit(req, { action: "user.mfa_enabled", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
  res.json({ success: true, backupCodes });
});

// POST /auth/mfa/disable — requires the account password.
router.post("/auth/mfa/disable", requireAuth, validateBody(MfaDisableBody), async (req: AuthRequest, res) => {
  const { password } = req.body ?? {};
  const user = await auth.mfaDisable(req.user!.id, password);
  await writeAudit(req, { action: "user.mfa_disabled", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
  res.json({ success: true });
});

// POST /auth/mfa/backup-codes — regenerate the backup-code set (requires password).
router.post("/auth/mfa/backup-codes", requireAuth, validateBody(MfaDisableBody), async (req: AuthRequest, res) => {
  const { password } = req.body ?? {};
  const { user, backupCodes } = await auth.regenerateBackupCodes(req.user!.id, password);
  await writeAudit(req, { action: "user.mfa_backup_regenerated", userId: user.id, userName: user.email, companyId: user.companyId, entityType: "user", entityId: user.id });
  res.json({ success: true, backupCodes });
});

// POST /auth/forgot-password — public. Always 200 (no account enumeration); a reset
// email is sent only when the account exists. Never reveals whether the email matched.
router.post("/auth/forgot-password", validateBody(ForgotPasswordBody), async (req: AuthRequest, res) => {
  const { email } = req.body ?? {};
  await auth.requestPasswordReset(email);
  res.json({ success: true, message: "If an account exists for that email, a password reset link has been sent." });
});

// POST /auth/reset-password — public. Consumes a single-use token + sets new password.
// A completed reset is a security-relevant credential change → audit it (the token
// itself is never logged).
router.post("/auth/reset-password", validateBody(ResetPasswordBody), async (req: AuthRequest, res) => {
  const { token, newPassword } = req.body ?? {};
  const user = await auth.resetPassword(token, newPassword);
  if (user) {
    await writeAudit(req, {
      action: "user.password_reset",
      userId: user.id,
      userName: user.email,
      companyId: user.companyId,
      entityType: "user",
      entityId: user.id,
    });
  }
  res.json({ success: true, message: "Your password has been reset. Please sign in with your new password." });
});

// POST /auth/verify-email — public. Consumes a single-use email-verification token.
router.post("/auth/verify-email", validateBody(VerifyEmailBody), async (req: AuthRequest, res) => {
  const { token } = req.body ?? {};
  await auth.verifyEmail(token);
  res.json({ success: true, message: "Your email has been verified." });
});

// POST /auth/resend-verification — authed. Re-issues a verification email to self.
router.post("/auth/resend-verification", requireAuth, async (req: AuthRequest, res) => {
  const { alreadyVerified } = await auth.sendVerification(req.user!.id);
  res.json({ success: true, alreadyVerified });
});

// POST /auth/change-password
router.post("/auth/change-password", requireAuth, validateBody(ChangePasswordBody), async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  const user = await auth.changePassword(req.user!.id, req.user!.sessionId ?? null, currentPassword, newPassword);
  await writeAudit(req, {
    action: "user.change_password",
    userId: user.id,
    userName: user.email,
    companyId: user.companyId,
    entityType: "user",
    entityId: user.id,
  });
  res.json({ success: true, message: "Password updated" });
});

export default router;
