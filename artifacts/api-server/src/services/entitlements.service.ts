import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import type { Executor } from "../repositories/base.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow } from "../repositories/subscriptions.repository.js";
import {
  resolveEffectiveLimits,
  resolveUsageWindow,
  limitFor,
  LIMIT_RESOURCES,
  type EffectiveLimit,
  type LimitResource,
  type UsageWindow,
} from "../lib/billing/lifecycle.js";

// Batch 20 — central entitlement / usage service. This is the ONLY place that
// compares usage with a limit. Every creation / import / invitation / role-change
// / capture path calls assertCapacity() INSIDE its mutation transaction, under a
// per-tenant+resource advisory lock, so parallel requests (and a CSV import racing
// a direct create) contend on the same boundary. A resource is enforced only when
// its effective limit is non-null; seeded defaults are all unlimited.

export type CountedResource = "contacts" | "events" | "admins" | "employees" | "scans";

export interface ResourceUsage {
  resource: LimitResource;
  used: number;
  limit: number | null;
  remaining: number | null;
  source: EffectiveLimit["source"];
  enforced: boolean;
  // Storage cannot be measured durably across the current upload architecture
  // (object storage is external and not metered); reported honestly as unavailable.
  measurable: boolean;
  details?: Record<string, number | string>;
}

export interface UsageReport {
  window: { startsAt: string; endsAt: string; source: UsageWindow["source"] };
  resources: ResourceUsage[];
}

export async function effectiveLimitsFor(sub: SubscriptionRow, tx?: Executor): Promise<EffectiveLimit[]> {
  const plan = await repo.findPlanById(sub.plan, tx);
  return resolveEffectiveLimits(plan ?? null, sub.limitOverrides);
}

export function roleFamily(role: string): "admins" | "employees" | null {
  switch (role) {
    case "admin":
    case "primary_admin":
    case "company_admin":
      return "admins";
    case "employee":
    case "team_member":
      return "employees";
    default:
      return null;
  }
}

interface CountOptions {
  excludeInvitationId?: number | null;
  now?: Date;
}

async function countUsage(companyId: number, sub: SubscriptionRow, resource: CountedResource, opts: CountOptions, tx?: Executor): Promise<{ used: number; details?: Record<string, number | string> }> {
  const now = opts.now ?? new Date();
  switch (resource) {
    case "contacts":
      return { used: await repo.countContacts(companyId, tx) };
    case "events":
      return { used: await repo.countEvents(companyId, tx) };
    case "admins":
    case "employees": {
      const users = await repo.countUsersByFamily(companyId, resource, tx);
      const pending = await repo.countPendingInvitationsByFamily(companyId, resource, now, opts.excludeInvitationId ?? null, tx);
      return { used: users + pending, details: { users, pendingInvitations: pending } };
    }
    case "scans": {
      const w = resolveUsageWindow(sub, now);
      const c = await repo.countScansInWindow(companyId, w.startsAt, w.endsAt, now, tx);
      return { used: c.scans + c.reservations, details: { scans: c.scans, reservations: c.reservations, windowStartsAt: w.startsAt.toISOString(), windowEndsAt: w.endsAt.toISOString() } };
    }
  }
}

export async function usageReport(companyId: number, sub: SubscriptionRow, now = new Date()): Promise<UsageReport> {
  const limits = await effectiveLimitsFor(sub);
  const window = resolveUsageWindow(sub, now);
  const resources: ResourceUsage[] = [];
  for (const l of limits) {
    if (l.resource === "storageMb") {
      resources.push({ resource: l.resource, used: 0, limit: l.limit, remaining: null, source: l.source, enforced: false, measurable: false });
      continue;
    }
    const { used, details } = await countUsage(companyId, sub, l.resource, { now });
    resources.push({
      resource: l.resource,
      used,
      limit: l.limit,
      remaining: l.limit == null ? null : Math.max(0, l.limit - used),
      source: l.source,
      enforced: l.limit != null,
      measurable: true,
      details,
    });
  }
  return { window: { startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(), source: window.source }, resources };
}

export class LimitExceededError extends AppError {
  constructor(resource: LimitResource, limit: number, used: number, requested: number) {
    super(409, `The ${resource} limit for this subscription has been reached (${used}/${limit}; ${requested} requested).`, {
      code: "LIMIT_EXCEEDED",
      details: { resource, limit, used, requested },
    });
    Object.setPrototypeOf(this, LimitExceededError.prototype);
  }
}

// Serializes on (company, resource), re-reads the canonical subscription INSIDE
// the transaction, and throws LimitExceededError when used + quantity > limit.
// Returns the effective limit (null = unlimited, nothing was locked or counted).
export async function assertCapacity(tx: Executor, companyId: number, resource: CountedResource, quantity: number, opts: CountOptions = {}): Promise<{ limit: number | null; used: number }> {
  if (quantity <= 0) return { limit: null, used: 0 };
  const sub = await repo.findByCompanyId(companyId, tx);
  if (!sub) return { limit: null, used: 0 }; // no canonical row → unlimited (repair guarantees rows; access is already fail-closed)
  const limits = await effectiveLimitsFor(sub, tx);
  const limit = limitFor(limits, resource);
  if (limit == null) return { limit: null, used: 0 };
  await repo.acquireUsageLock(companyId, resource, tx);
  const { used } = await countUsage(companyId, sub, resource, opts, tx);
  if (used + quantity > limit) throw new LimitExceededError(resource, limit, used, quantity);
  return { limit, used };
}

// ── Scan reservations (idempotent; release on failure; never consume twice) ──

export interface ReserveResult {
  reservationId: number;
  status: "pending" | "consumed";
  // true when an earlier attempt with the same key already consumed capacity —
  // the caller must not count the work again.
  alreadyConsumed: boolean;
}

export async function reserveScans(companyId: number, idempotencyKey: string, quantity = 1): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    const existing = await repo.findReservationByKey(idempotencyKey, tx);
    if (existing && existing.companyId !== companyId) throw new AppError(409, "Reservation key belongs to another tenant", { code: "RESERVATION_MISMATCH" });
    // A consumed reservation is honoured as "already paid for" only within the
    // retry window (TTL): a client retry of the same capture never consumes twice,
    // but re-scanning the same image later is a new scan admitted under the limit.
    const ttl = config.billing.usageReservationTtlMs;
    if (existing?.status === "consumed" && existing.consumedAt && Date.now() - existing.consumedAt.getTime() < ttl) {
      return { reservationId: existing.id, status: "consumed", alreadyConsumed: true };
    }
    if (existing?.status === "pending" && existing.expiresAt.getTime() > Date.now()) return { reservationId: existing.id, status: "pending", alreadyConsumed: false };
    const sub = await repo.findByCompanyId(companyId, tx);
    if (sub) {
      const limits = await effectiveLimitsFor(sub, tx);
      const limit = limitFor(limits, "scans");
      if (limit != null) {
        await repo.acquireUsageLock(companyId, "scans", tx);
        const { used } = await countUsage(companyId, sub, "scans", {}, tx);
        if (used + quantity > limit) throw new LimitExceededError("scans", limit, used, quantity);
      }
    }
    const expiresAt = new Date(Date.now() + ttl);
    if (existing) {
      // released or expired pending → re-arm the same key
      const row = await repo.updateReservation(existing.id, { status: "pending", quantity, expiresAt, releasedAt: null, consumedAt: null, scanId: null }, tx);
      return { reservationId: row!.id, status: "pending", alreadyConsumed: false };
    }
    const row = await repo.insertReservation({ companyId, resource: "scans", quantity, idempotencyKey, status: "pending", expiresAt }, tx);
    return { reservationId: row.id, status: "pending", alreadyConsumed: false };
  });
}

export async function consumeReservation(reservationId: number, scanId: number | null): Promise<void> {
  await repo.updateReservation(reservationId, { status: "consumed", consumedAt: new Date(), scanId });
}

export async function releaseReservation(reservationId: number): Promise<void> {
  await repo.updateReservation(reservationId, { status: "released", releasedAt: new Date() }).catch((err) => {
    logger.error({ err, reservationId }, "Failed to release usage reservation");
  });
}

export const RESOURCES = LIMIT_RESOURCES;
