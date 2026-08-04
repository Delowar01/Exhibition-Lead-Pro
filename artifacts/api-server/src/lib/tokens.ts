import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { randomToken, sha256 } from "./crypto.js";

const SECRET: string = config.sessionSecret;

export interface AccessTokenPayload {
  id: number;
  email: string;
  role: string;
  companyId: number | null;
  // Server-side session id this token belongs to. Optional for backward
  // compatibility with legacy tokens minted before sessions existed.
  sid?: number;
  typ?: "access";
}

export function signAccessToken(payload: Omit<AccessTokenPayload, "typ">): string {
  return jwt.sign({ ...payload, typ: "access" }, SECRET, {
    expiresIn: config.auth.accessTokenTtl as jwt.SignOptions["expiresIn"],
    issuer: config.auth.issuer,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, SECRET, { issuer: config.auth.issuer }) as AccessTokenPayload;
    if (decoded.typ && decoded.typ !== "access") return null;
    return decoded;
  } catch {
    return null;
  }
}

// Short-lived token that proves a password was verified and an MFA code is still
// required. Carries the user id plus a `jti` bound to a server-side single-use row
// (verification_tokens, type "mfa_challenge") so a challenge cannot be replayed
// after it has been consumed by a successful verification. Useless without a valid
// TOTP/backup code.
export function signMfaChallenge(userId: number, jti: string): string {
  return jwt.sign({ uid: userId, jti, typ: "mfa" }, SECRET, {
    expiresIn: config.auth.mfaChallengeTtl as jwt.SignOptions["expiresIn"],
    issuer: config.auth.issuer,
  });
}

export function verifyMfaChallenge(token: string): { uid: number; jti: string } | null {
  try {
    const decoded = jwt.verify(token, SECRET, { issuer: config.auth.issuer }) as { uid: number; jti?: string; typ?: string };
    if (decoded.typ !== "mfa" || typeof decoded.jti !== "string" || !decoded.jti) return null;
    return { uid: decoded.uid, jti: decoded.jti };
  } catch {
    return null;
  }
}

// Refresh token format: `<familyId>.<secret>`. The prefix is the session family's
// unguessable random UUID (NOT a serial id), so an attacker cannot enumerate ids to
// target a victim's session. Only sha256(secret) is stored server-side, so the raw
// token is never persisted. The UUID prefix lets us look up the family in one
// indexed query before the constant-time compare. (UUIDs contain no `.`, so the
// first-dot split always recovers the full secret.)
export function generateRefreshToken(familyId: string): { token: string; secretHash: string } {
  const secret = randomToken(48);
  return { token: `${familyId}.${secret}`, secretHash: sha256(secret) };
}

export function parseRefreshToken(token: string): { familyId: string; secret: string } | null {
  const idx = token.indexOf(".");
  if (idx <= 0) return null;
  const familyId = token.slice(0, idx);
  const secret = token.slice(idx + 1);
  if (!familyId || !secret) return null;
  return { familyId, secret };
}

export function hashRefreshSecret(secret: string): string {
  return sha256(secret);
}
