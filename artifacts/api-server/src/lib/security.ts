import type { Request } from "express";
import { UAParser } from "ua-parser-js";
import { and, eq, gte, desc } from "drizzle-orm";
import { db, loginAttemptsTable } from "@workspace/db";
import { config } from "../config.js";

export interface PasswordCheck {
  valid: boolean;
  errors: string[];
}

// Server-side password policy. Mirrors the client strength meter so the two never
// disagree. Minimum length is configurable; complexity is fixed here.
export function validatePassword(password: unknown): PasswordCheck {
  const errors: string[] = [];
  if (typeof password !== "string") {
    return { valid: false, errors: ["Password is required"] };
  }
  const min = config.security.minPasswordLength;
  if (password.length < min) errors.push(`Must be at least ${min} characters`);
  if (!/[a-z]/.test(password)) errors.push("Must include a lowercase letter");
  if (!/[A-Z]/.test(password)) errors.push("Must include an uppercase letter");
  if (!/[0-9]/.test(password)) errors.push("Must include a number");
  if (!/[^A-Za-z0-9]/.test(password)) errors.push("Must include a symbol");
  return { valid: errors.length === 0, errors };
}

// Best-effort client IP. Trusts the left-most X-Forwarded-For entry (the shared
// reverse proxy sets it); falls back to the socket address.
export function getClientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0]!.trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

// Approximate country from CDN/proxy headers when present. No geoip DB is bundled,
// so this is null in most local/dev setups — documented limitation.
export function getCountry(req: Request): string | null {
  const candidates = ["cf-ipcountry", "x-vercel-ip-country", "x-country-code"];
  for (const h of candidates) {
    const v = req.headers[h];
    if (typeof v === "string" && v && v !== "XX") return v.toUpperCase();
  }
  return null;
}

export interface DeviceInfo {
  userAgent: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
}

export function parseDevice(req: Request): DeviceInfo {
  const ua = req.headers["user-agent"] ?? null;
  if (!ua) return { userAgent: null, browser: null, os: null, deviceType: null };
  const parsed = new UAParser(ua).getResult();
  const browser = [parsed.browser.name, parsed.browser.version?.split(".")[0]].filter(Boolean).join(" ") || null;
  const os = [parsed.os.name, parsed.os.version].filter(Boolean).join(" ") || null;
  const deviceType = parsed.device.type ?? "desktop";
  return { userAgent: ua, browser, os, deviceType };
}

export interface LockoutState {
  locked: boolean;
  retryAfterSeconds: number;
  failedCount: number;
}

// Brute-force gate: counts failed attempts for this email+IP within the rolling
// window. At/over the threshold the caller is locked out until the most recent
// failure ages past the lockout duration.
export async function checkLockout(email: string, ip: string | null): Promise<LockoutState> {
  const windowStart = new Date(Date.now() - config.security.lockoutWindowMinutes * 60_000);
  const conds = [
    eq(loginAttemptsTable.email, email),
    eq(loginAttemptsTable.success, false),
    gte(loginAttemptsTable.createdAt, windowStart),
  ];
  if (ip) conds.push(eq(loginAttemptsTable.ipAddress, ip));

  const rows = await db
    .select({ createdAt: loginAttemptsTable.createdAt })
    .from(loginAttemptsTable)
    .where(and(...conds))
    .orderBy(desc(loginAttemptsTable.createdAt));

  const failedCount = rows.length;
  if (failedCount < config.security.maxFailedAttempts) {
    return { locked: false, retryAfterSeconds: 0, failedCount };
  }
  const newest = rows[0]!.createdAt.getTime();
  const unlockAt = newest + config.security.lockoutMinutes * 60_000;
  const retryAfterSeconds = Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000));
  return { locked: retryAfterSeconds > 0, retryAfterSeconds, failedCount };
}

export async function recordLoginAttempt(args: {
  email: string;
  ip: string | null;
  userId?: number | null;
  success: boolean;
  reason?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await db.insert(loginAttemptsTable).values({
    email: args.email,
    ipAddress: args.ip,
    userId: args.userId ?? null,
    success: args.success,
    reason: args.reason ?? null,
    userAgent: args.userAgent ?? null,
  });
}
