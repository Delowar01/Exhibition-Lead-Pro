import { config } from "../config.js";
import { AppError } from "../middlewares/errorHandler.js";
import type { AiFeature } from "./types.js";

// Batch 6 — AI-specific rate limiting at the Enterprise AI Layer seam (the single
// choke point every Gemini call passes through), mirroring the process-local
// fixed-window semantics of the existing express-rate-limit auth guards. Policy comes
// from ONE source: config.ai.rateLimits (env-overridable, deterministic for tests).
//
// Keys:
//   user:<companyId>:<userId>          — per-user ceiling within a tenant
//   tenant:<companyId>                 — whole-tenant ceiling (all users combined)
//   heavy:<companyId>:<userId>         — stricter per-user ceiling for high-cost features
//   system:<userId|anon>               — calls without tenant context (incl. platform
//                                        owner), so nobody silently bypasses protection
//
// Enforcement happens BEFORE the tenant gates and the provider call; a denied request
// never contacts Gemini and never consumes token budget.

interface WindowEntry {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, WindowEntry>();

function hit(key: string, max: number, windowMs: number, now: number): number | null {
  let entry = buckets.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { windowStart: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > max) {
    return Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
  }
  return null;
}

// Periodic sweep so long-idle buckets don't accumulate forever.
let lastSweep = 0;
function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart >= windowMs) buckets.delete(key);
  }
}

export interface RateDenial {
  scope: "user" | "tenant" | "feature" | "system";
  retryAfterSeconds: number;
  limit: number;
}

/**
 * Counts this request against every applicable window and returns a denial when any
 * ceiling is exceeded. Counting happens even for requests later denied by the tenant
 * gates — the limiter protects the whole AI path, not just the provider.
 */
export function checkAiRateLimit(params: {
  companyId?: number | null;
  userId?: number | null;
  feature: AiFeature;
}): RateDenial | null {
  const rl = config.ai.rateLimits;
  const now = Date.now();
  sweep(now, rl.windowMs);

  if (params.companyId == null) {
    // System / platform-owner calls: shared per-caller bucket at the per-user ceiling.
    const retry = hit(`system:${params.userId ?? "anon"}`, rl.perUserMax, rl.windowMs, now);
    return retry == null ? null : { scope: "system", retryAfterSeconds: retry, limit: rl.perUserMax };
  }

  const cid = params.companyId;
  const uid = params.userId ?? "anon";

  const userRetry = hit(`user:${cid}:${uid}`, rl.perUserMax, rl.windowMs, now);
  const tenantRetry = hit(`tenant:${cid}`, rl.perTenantMax, rl.windowMs, now);
  const heavy = (rl.heavyFeatures as readonly string[]).includes(params.feature);
  const heavyRetry = heavy ? hit(`heavy:${cid}:${uid}`, rl.heavyPerUserMax, rl.windowMs, now) : null;

  if (heavyRetry != null) return { scope: "feature", retryAfterSeconds: heavyRetry, limit: rl.heavyPerUserMax };
  if (userRetry != null) return { scope: "user", retryAfterSeconds: userRetry, limit: rl.perUserMax };
  if (tenantRetry != null) return { scope: "tenant", retryAfterSeconds: tenantRetry, limit: rl.perTenantMax };
  return null;
}

/** Builds the standard 429 for an AI rate-limit denial (code distinguishes it from budget 429s). */
export function aiRateLimitError(denial: RateDenial): AppError {
  const what =
    denial.scope === "feature"
      ? "for this AI feature"
      : denial.scope === "tenant"
        ? "for your organization"
        : "for your account";
  return new AppError(429, `AI request rate limit reached ${what}. Please retry shortly.`, {
    code: "AI_RATE_LIMITED",
    retryAfterSeconds: denial.retryAfterSeconds,
    details: { scope: denial.scope, limit: denial.limit, windowMs: config.ai.rateLimits.windowMs },
  });
}

/** Test-only: clears all in-memory windows (used indirectly via server restarts). */
export function resetAiRateLimiter(): void {
  buckets.clear();
  lastSweep = 0;
}
