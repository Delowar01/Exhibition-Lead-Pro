// =============================================================================
// Batch 25 — capability tokens for upload targets and downloads.
//
// Every product-file access is API-mediated: the feature route runs the normal
// authentication / tenant / permission checks FIRST and only then mints a
// short-lived, HMAC-signed capability bound to ONE object id, ONE tenant and
// ONE operation (put or get). The file routes verify the signature and expiry,
// re-check that the object is still active and owned by the tenant in the
// token, and stream the bytes. Clients keep treating the returned URLs as
// opaque strings, exactly as they treated the former signed storage URLs.
//
// The signing key is derived (HKDF) from SESSION_SECRET with a dedicated label;
// it is never the raw session secret and never the object encryption key.
// =============================================================================
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export type CapabilityOp = "put" | "get";

export interface CapabilityPayload {
  v: 1;
  op: CapabilityOp;
  /** storage_objects.id */
  o: string;
  /** owning company id */
  c: number;
  /** minting user id (null for system-minted) */
  u: number | null;
  /** unix seconds */
  exp: number;
  /** download file name (get only) */
  fn?: string;
  /** content disposition (get only) */
  d?: "inline" | "attachment";
}

let signingKey: Buffer | null = null;

function key(): Buffer {
  if (!signingKey) {
    signingKey = Buffer.from(hkdfSync("sha256", Buffer.from(config.sessionSecret, "utf8"), Buffer.alloc(0), "lcp.object-storage.capability.v1", 32));
  }
  return signingKey;
}

function b64url(b: Buffer): string {
  return b.toString("base64url");
}

function sign(payloadB64: string): string {
  return b64url(createHmac("sha256", key()).update(payloadB64).digest());
}

export function mintCapability(payload: Omit<CapabilityPayload, "v">): string {
  const full: CapabilityPayload = { v: 1, ...payload };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  return `${body}.${sign(body)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns the payload when the token is well-formed, authentic, unexpired and for `op`; null otherwise. */
export function verifyCapability(token: string | undefined, op: CapabilityOp, now: number = Date.now()): CapabilityPayload | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: CapabilityPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || payload.op !== op) return null;
  if (typeof payload.o !== "string" || !UUID.test(payload.o)) return null;
  if (!Number.isInteger(payload.c) || payload.c <= 0) return null;
  if (!(payload.u === null || Number.isInteger(payload.u))) return null;
  if (!Number.isInteger(payload.exp) || payload.exp * 1000 <= now) return null;
  if (payload.fn !== undefined && (typeof payload.fn !== "string" || payload.fn.length > 255)) return null;
  if (payload.d !== undefined && payload.d !== "inline" && payload.d !== "attachment") return null;
  return payload;
}

/** Test support: forget the derived key (config may be mutated by unit tests). */
export function __resetCapabilityKeyForTests(): void {
  if (!config.isProduction) signingKey = null;
}
