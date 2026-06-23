import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";

const jsonHandler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
  res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
};

// General ceiling for the whole /api/auth surface (refresh, mfa status, etc.).
export const authRateLimiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler,
});

// Tighter ceiling for credential-checking endpoints (login + MFA verification).
// This is the network-level guard; per-account brute-force lockout is enforced
// separately in the login handler against the login_attempts table.
// `skipSuccessfulRequests` so only FAILED credential attempts (>=400) burn the
// budget — a successful authentication is not an attack, and counting it would
// false-positive legitimate shared-IP/NAT traffic while doing nothing against
// guessing. The guard now targets exactly what it should: repeated failures.
export const loginRateLimiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: jsonHandler,
});
