import crypto from "node:crypto";
import { config } from "../config.js";

// 32-byte key for AES-256-GCM, derived from a dedicated MFA key when provided,
// otherwise from SESSION_SECRET so no new required env var is introduced.
function encryptionKey(): Buffer {
  const material = config.auth.mfaEncryptionKey || config.sessionSecret;
  return crypto.createHash("sha256").update(material).digest();
}

// Encrypts a short secret (e.g. a TOTP base32 string) to "iv.tag.ciphertext"
// (all base64url). Reversible only with the server key.
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

// SHA-256 hex — used for refresh-token secrets, backup codes, and device tokens.
// These are high-entropy random values, so a fast hash (not bcrypt) is correct
// and lets us index/compare them.
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Constant-time compare for two hex strings of equal length.
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
