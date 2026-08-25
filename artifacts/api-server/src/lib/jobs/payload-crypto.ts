import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Authenticated encryption for durable job payloads (Batch 14). Email jobs carry
// password-reset / verification / invitation links, so persisting queue rows must
// never create a plaintext token store — every payload written by the Postgres
// driver goes through AES-256-GCM with a DEDICATED key
// (JOBS_PAYLOAD_ENCRYPTION_KEY). There is no fallback secret: selecting the
// postgres driver without the key is a hard startup error (config-level).
//
// Envelope format (versioned for future rotation):
//   gcm1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>

const ENVELOPE_PREFIX = "gcm1";

// Thrown when an envelope is malformed or fails authentication (wrong key,
// corrupted row). The worker treats this as PERMANENT — the job dead-letters
// immediately without echoing any payload material.
export class PayloadDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadDecryptError";
  }
}

// Any non-trivial secret string is accepted; the 256-bit cipher key is derived
// with SHA-256 so operators can use `openssl rand -hex 32` (or longer) verbatim.
export function deriveKey(secret: string): Buffer {
  if (!secret || secret.length < 32) {
    throw new Error("JOBS_PAYLOAD_ENCRYPTION_KEY must be at least 32 characters");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptPayload(key: Buffer, payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}

export function decryptPayload(key: Buffer, envelope: string): unknown {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    throw new PayloadDecryptError("Unrecognized payload envelope");
  }
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const data = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    // Never include cipher/text material in the error.
    throw new PayloadDecryptError("Payload decryption failed");
  }
}
