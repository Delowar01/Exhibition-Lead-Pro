import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { config } from "../config.js";
import { encryptSecret, decryptSecret, sha256, randomToken } from "./crypto.js";

export function generateMfaSecret(): string {
  return generateSecret();
}

export function buildOtpauthUrl(accountEmail: string, secret: string): string {
  return generateURI({ secret, label: accountEmail, issuer: config.auth.issuer, strategy: "totp" });
}

export async function otpauthQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
}

// Verifies a 6-digit TOTP code. `epochTolerance` (seconds) allows +/- one 30s
// time-step of clock skew between the server and the authenticator app.
export async function verifyTotp(secret: string, token: string): Promise<boolean> {
  const normalized = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  try {
    const result = await verify({ token: normalized, secret, strategy: "totp", epochTolerance: 30 });
    return result.valid === true;
  } catch {
    return false;
  }
}

export function encryptMfaSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptMfaSecret(payload: string): string {
  return decryptSecret(payload);
}

// Backup codes: human-friendly, single-use. Stored only as a sha256 of the
// normalized (uppercase, hyphen-stripped) value.
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // randomToken is base64url (contains '-'/'_'); after stripping non-alphanumerics
    // a single token can yield fewer than 10 chars, producing a malformed code.
    // Accumulate until we have at least 10 alphanumerics, then slice to 10.
    let raw = "";
    while (raw.length < 10) {
      raw += randomToken(8).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    }
    raw = raw.slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export function hashBackupCode(code: string): string {
  return sha256(normalizeBackupCode(code));
}
