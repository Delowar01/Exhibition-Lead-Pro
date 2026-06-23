import crypto from "node:crypto";
import type { Request } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db, sessionsTable, usersTable, type Session } from "@workspace/db";
import { config } from "../config.js";
import {
  signAccessToken,
  generateRefreshToken,
  parseRefreshToken,
  hashRefreshSecret,
} from "./tokens.js";
import { parseDevice, getClientIp, getCountry } from "./security.js";

export interface IssuedTokens {
  sessionId: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface SessionUser {
  id: number;
  email: string;
  role: string;
  companyId: number | null;
}

function refreshTtlDays(rememberMe: boolean): number {
  return rememberMe ? config.auth.rememberMeRefreshTtlDays : config.auth.refreshTtlDays;
}

// Creates a server-side session and mints the matching access + refresh tokens.
// The refresh secret hash is written in a second update because the token embeds
// the freshly-generated session id.
export async function createSession(
  user: SessionUser,
  req: Request,
  rememberMe: boolean,
): Promise<IssuedTokens> {
  const device = parseDevice(req);
  const expiresAt = new Date(Date.now() + refreshTtlDays(rememberMe) * 24 * 60 * 60 * 1000);
  const familyId = crypto.randomUUID();

  const [session] = await db
    .insert(sessionsTable)
    .values({
      userId: user.id,
      familyId,
      refreshTokenHash: "pending",
      userAgent: device.userAgent,
      ipAddress: getClientIp(req),
      browser: device.browser,
      os: device.os,
      deviceType: device.deviceType,
      country: getCountry(req),
      rememberMe,
      expiresAt,
    })
    .returning();

  const { token: refreshToken, secretHash } = generateRefreshToken(session.id);
  await db.update(sessionsTable).set({ refreshTokenHash: secretHash }).where(eq(sessionsTable.id, session.id));

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    sid: session.id,
  });

  return { sessionId: session.id, accessToken, refreshToken, expiresAt };
}

export type RotateResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; status: number; error: string };

// Rotates a refresh token. On a valid current token: issues a new access +
// refresh pair and advances the stored hash. If a stale-but-known token from the
// same family is replayed (theft signal), the entire family is revoked.
export async function rotateSession(rawToken: string, req: Request): Promise<RotateResult> {
  const parsed = parseRefreshToken(rawToken);
  if (!parsed) return { ok: false, status: 401, error: "Invalid refresh token" };

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, parsed.sessionId)).limit(1);
  if (!session) return { ok: false, status: 401, error: "Invalid refresh token" };

  if (session.revokedAt) {
    await revokeFamily(session.familyId, "reuse_after_revoke");
    return { ok: false, status: 401, error: "Session revoked" };
  }
  if (session.expiresAt.getTime() < Date.now()) {
    return { ok: false, status: 401, error: "Session expired" };
  }

  const presentedHash = hashRefreshSecret(parsed.secret);
  if (presentedHash !== session.refreshTokenHash) {
    // A previously-rotated (now invalid) secret from this family was replayed.
    await revokeFamily(session.familyId, "token_reuse");
    return { ok: false, status: 401, error: "Refresh token reuse detected" };
  }

  // Load the live user so the rotated access token carries fresh claims and we
  // can reject refreshes for disabled accounts.
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, session.userId)).limit(1);
  if (!user || !user.isActive) {
    await revokeFamily(session.familyId, "user_inactive");
    return { ok: false, status: 401, error: "Account is disabled" };
  }

  const { token: refreshToken, secretHash } = generateRefreshToken(session.id);
  const device = parseDevice(req);
  await db
    .update(sessionsTable)
    .set({
      refreshTokenHash: secretHash,
      lastUsedAt: new Date(),
      ipAddress: getClientIp(req) ?? session.ipAddress,
      userAgent: device.userAgent ?? session.userAgent,
    })
    .where(eq(sessionsTable.id, session.id));

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    sid: session.id,
  });

  return {
    ok: true,
    tokens: { sessionId: session.id, accessToken, refreshToken, expiresAt: session.expiresAt },
  };
}

// Returns the live session for an access token's `sid`, or null when missing,
// revoked, or expired. Called on every authenticated request.
export async function validateSession(sessionId: number): Promise<Session | null> {
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).limit(1);
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  return session;
}

export async function touchSession(sessionId: number): Promise<void> {
  await db.update(sessionsTable).set({ lastUsedAt: new Date() }).where(eq(sessionsTable.id, sessionId));
}

export async function revokeSession(sessionId: number, reason: string): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessionsTable.id, sessionId));
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessionsTable.familyId, familyId));
}

// Revokes every active session for a user except the one to keep (used by
// "terminate all other sessions").
export async function revokeOtherSessions(userId: number, keepSessionId: number, reason: string): Promise<number> {
  const rows = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(and(eq(sessionsTable.userId, userId)));
  let count = 0;
  for (const row of rows) {
    if (row.id === keepSessionId) continue;
    await db
      .update(sessionsTable)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(sessionsTable.id, row.id));
    count++;
  }
  return count;
}

export interface SessionView {
  id: number;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  ipAddress: string | null;
  country: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  current: boolean;
}

// Active (not revoked, not expired) sessions for a user, newest activity first.
export async function listActiveSessions(userId: number, currentSessionId: number | null): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.userId, userId))
    .orderBy(desc(sessionsTable.lastUsedAt));
  const now = Date.now();
  return rows
    .filter((r) => !r.revokedAt && r.expiresAt.getTime() > now)
    .map((r) => ({
      id: r.id,
      browser: r.browser,
      os: r.os,
      deviceType: r.deviceType,
      ipAddress: r.ipAddress,
      country: r.country,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
      current: r.id === currentSessionId,
    }));
}
