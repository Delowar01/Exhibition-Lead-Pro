import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import type { Executor } from "../repositories/base.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow } from "../repositories/subscriptions.repository.js";
import { findPlan } from "../lib/billing/plan-catalog.js";
import {
  checkTransition,
  legacyCompanyStatus,
  mapProviderStatus,
  normalizeLegacyStatus,
  LIMIT_RESOURCES,
  LIVE_PROVIDER_STATUSES,
  type LifecycleAction,
  type LimitOverrides,
  type SubscriptionStatus,
} from "../lib/billing/lifecycle.js";
import { writeSubscriptionAudit, sanitizeReason, type AuditActor, PROVIDER_ACTOR } from "../lib/billing/audit.js";
import { getBillingProvider, type ProviderSubscription } from "../lib/billing/provider.js";

// Batch 20 — the ONLY writer of canonical subscription state. Every change:
//   1. runs in one transaction with the subscription row locked (FOR UPDATE);
//   2. is validated against the pure transition table (lib/billing/lifecycle.ts);
//   3. writes the deprecated companies.plan/status/trial_ends_at mirror in the
//      SAME transaction (compatibility only — never read for access);
//   4. writes a before/after audit row in the SAME transaction.
// Routes call these functions; no lifecycle logic lives in route handlers.

export type Actor = AuditActor;

function conflict(code: string, message: string): AppError {
  return new AppError(409, message, { code });
}

const TRANSITION_MESSAGES: Record<string, string> = {
  INVALID_TRANSITION: "This action is not allowed from the subscription's current state.",
  MANAGED_BY_PROVIDER: "This subscription is managed by the payment provider; use the provider flow instead.",
  NOT_PROVIDER_MANAGED: "This subscription is not managed by the payment provider.",
  NO_RESTORE_STATE: "The subscription has no state to restore.",
};

function assertTransition(action: LifecycleAction, sub: SubscriptionRow): SubscriptionStatus | null {
  const check = checkTransition(action, sub);
  if (!check.ok) throw conflict(check.code, TRANSITION_MESSAGES[check.code] ?? "Transition not allowed.");
  return check.to;
}

export function mirrorFor(sub: Pick<SubscriptionRow, "plan" | "status" | "trialExpiresAt">) {
  const status = normalizeLegacyStatus(sub.status) ?? "trialing";
  return { plan: sub.plan, status: legacyCompanyStatus(status), trialEndsAt: sub.trialExpiresAt ?? null };
}

async function commitChange(
  tx: Executor,
  before: SubscriptionRow,
  patch: Partial<typeof before>,
  action: string,
  actor: Actor,
  extra?: Record<string, string | number | boolean | null>,
): Promise<SubscriptionRow> {
  const now = new Date();
  const statusChanged = patch.status !== undefined && patch.status !== before.status;
  const after = await repo.update(
    before.id,
    {
      ...patch,
      ...(statusChanged ? { statusChangedAt: now } : {}),
      // Deprecated date mirrors kept coherent for legacy readers.
      trialEndsAt: (patch.trialExpiresAt !== undefined ? patch.trialExpiresAt : before.trialExpiresAt)?.toISOString().slice(0, 10) ?? null,
      renewalDate: (patch.currentPeriodEndsAt !== undefined ? patch.currentPeriodEndsAt : before.currentPeriodEndsAt)?.toISOString().slice(0, 10) ?? null,
    },
    tx,
  );
  if (!after) throw new AppError(404, "Subscription not found");
  await repo.writeCompanyMirror(before.companyId, mirrorFor(after), tx);
  await writeSubscriptionAudit(tx, { action, companyId: before.companyId, subscriptionId: before.id, before, after, actor, extra });
  logger.info({ companyId: before.companyId, subscriptionId: before.id, action, from: before.status, to: after.status, actorUserId: actor.userId }, "Subscription lifecycle change");
  return after;
}

async function withLockedSubscription<T>(companyId: number, fn: (tx: Executor, sub: SubscriptionRow) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const sub = await repo.lockByCompanyId(companyId, tx);
    if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
    return fn(tx, sub);
  });
}

// ── Creation (every company-creation path) ───────────────────────────────────

export interface CreateSubscriptionOptions {
  plan?: string;
  trialDays?: number;
  actor: Actor;
}

// Inserts the canonical subscription for a company that was just inserted in
// the SAME transaction: manual, trialing, 14-day trial (owner decision), no
// provider identity, no invented price, no limit overrides (unlimited unless the
// plan configures a default).
export async function createSubscriptionForCompany(tx: Executor, company: { id: number; name: string }, opts: CreateSubscriptionOptions): Promise<SubscriptionRow> {
  const plan = opts.plan ?? "free";
  if (!(await findPlan(plan, tx))) throw new AppError(400, "Invalid plan", { code: "INVALID_PLAN" });
  const now = new Date();
  const days = opts.trialDays ?? config.billing.trialDays;
  const trialExpiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const sub = await repo.insert(
    {
      companyId: company.id,
      plan,
      status: "trialing",
      billingSource: "manual",
      trialStartedAt: now,
      trialExpiresAt,
      usageAnchorAt: now,
      statusChangedAt: now,
      limitOverrides: {},
      trialEndsAt: trialExpiresAt.toISOString().slice(0, 10),
      // Deprecated counters/limits stay at their column defaults; never read.
    },
    tx,
  );
  await repo.writeCompanyMirror(company.id, mirrorFor(sub), tx);
  await writeSubscriptionAudit(tx, { action: "subscription.create", companyId: company.id, subscriptionId: sub.id, before: null, after: sub, actor: opts.actor, extra: { trialDays: days } });
  return sub;
}

// ── Platform-owner manual operations ─────────────────────────────────────────

export async function setPlan(companyId: number, actor: Actor, input: { plan?: unknown }): Promise<SubscriptionRow> {
  const plan = typeof input.plan === "string" ? input.plan : "";
  if (!(await findPlan(plan))) throw new AppError(400, "Invalid plan", { code: "INVALID_PLAN" });
  return withLockedSubscription(companyId, async (tx, sub) => {
    assertTransition("set_plan", sub);
    if (sub.plan === plan) return sub;
    return commitChange(tx, sub, { plan }, "subscription.set_plan", actor);
  });
}

function parseDate(v: unknown, field: string): Date {
  const d = typeof v === "string" || v instanceof Date ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new AppError(400, `${field} must be an ISO date-time`, { code: "INVALID_DATE" });
  return d;
}

export async function startTrial(companyId: number, actor: Actor, input: { trialExpiresAt?: unknown; trialDays?: unknown }): Promise<SubscriptionRow> {
  const now = new Date();
  let expires: Date;
  if (input.trialExpiresAt != null) expires = parseDate(input.trialExpiresAt, "trialExpiresAt");
  else {
    const days = typeof input.trialDays === "number" && Number.isInteger(input.trialDays) && input.trialDays > 0 && input.trialDays <= 365 ? input.trialDays : config.billing.trialDays;
    expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }
  if (expires.getTime() <= now.getTime()) throw new AppError(400, "trialExpiresAt must be in the future", { code: "INVALID_DATE" });
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("start_trial", sub);
    return commitChange(
      tx,
      sub,
      { status: to ?? "trialing", trialStartedAt: sub.status === "trialing" ? (sub.trialStartedAt ?? now) : now, trialExpiresAt: expires, endedAt: null, canceledAt: null, pastDueSince: null },
      "subscription.start_trial",
      actor,
    );
  });
}

export async function activate(companyId: number, actor: Actor): Promise<SubscriptionRow> {
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("activate", sub);
    return commitChange(tx, sub, { status: to ?? "active", endedAt: null, canceledAt: null, pastDueSince: null, cancelAtPeriodEnd: false }, "subscription.activate", actor);
  });
}

export async function markPastDue(companyId: number, actor: Actor): Promise<SubscriptionRow> {
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("mark_past_due", sub);
    return commitChange(tx, sub, { status: to ?? "past_due", pastDueSince: new Date() }, "subscription.mark_past_due", actor);
  });
}

export async function cancel(companyId: number, actor: Actor): Promise<SubscriptionRow> {
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("cancel", sub);
    const now = new Date();
    return commitChange(tx, sub, { status: to ?? "cancelled", canceledAt: now, endedAt: now, cancelAtPeriodEnd: false }, "subscription.cancel", actor);
  });
}

export async function expire(companyId: number, actor: Actor): Promise<SubscriptionRow> {
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("expire", sub);
    return commitChange(tx, sub, { status: to ?? "expired", endedAt: new Date() }, "subscription.expire", actor);
  });
}

export async function suspend(companyId: number, actor: Actor, input: { reason?: unknown }): Promise<SubscriptionRow> {
  const reason = sanitizeReason(input.reason);
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("suspend", sub);
    return commitChange(
      tx,
      sub,
      { status: to ?? "suspended", suspendedAt: new Date(), suspendedReason: reason, statusBeforeSuspension: normalizeLegacyStatus(sub.status) ?? sub.status },
      "subscription.suspend",
      actor,
    );
  });
}

export async function reactivate(companyId: number, actor: Actor): Promise<SubscriptionRow> {
  return withLockedSubscription(companyId, async (tx, sub) => {
    const to = assertTransition("reactivate", sub);
    let target: SubscriptionStatus = to ?? "active";
    // A manual trial whose end already passed cannot be resurrected silently.
    if (target === "trialing" && sub.trialExpiresAt && sub.trialExpiresAt.getTime() <= Date.now()) target = "expired";
    // A Stripe-managed subscription resumes whatever the provider last reported.
    if (sub.billingSource === "stripe" && sub.providerStatus) {
      const mapped = mapProviderStatus(sub.providerStatus).status;
      if (mapped) target = mapped;
    }
    return commitChange(tx, sub, { status: target, suspendedAt: null, suspendedReason: null, statusBeforeSuspension: null }, "subscription.reactivate", actor);
  });
}

export function parseLimitOverrides(raw: unknown): LimitOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError(400, "limits must be an object", { code: "INVALID_LIMITS" });
  const out: LimitOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LIMIT_RESOURCES as readonly string[]).includes(k)) throw new AppError(400, `Unknown limit resource: ${k}`, { code: "INVALID_LIMITS" });
    if (v === null) {
      out[k as (typeof LIMIT_RESOURCES)[number]] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000_000) throw new AppError(400, `Limit for ${k} must be a non-negative integer or null`, { code: "INVALID_LIMITS" });
    out[k as (typeof LIMIT_RESOURCES)[number]] = v;
  }
  return out;
}

// Replaces the override map (null clears a single override; an empty object clears all).
export async function setLimitOverrides(companyId: number, actor: Actor, input: { limits?: unknown }): Promise<SubscriptionRow> {
  const parsed = parseLimitOverrides(input.limits ?? {});
  const next: LimitOverrides = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === "number") next[k as keyof LimitOverrides] = v;
  return withLockedSubscription(companyId, async (tx, sub) => {
    assertTransition("set_limits", sub);
    return commitChange(tx, sub, { limitOverrides: next }, "subscription.set_limits", actor);
  });
}

// Stripe → manual, only when no live provider subscription remains (verified
// against the provider before the transaction; the row lock re-checks the source).
export async function convertToManual(companyId: number, actor: Actor): Promise<SubscriptionRow> {
  const current = await repo.findByCompanyId(companyId);
  if (!current) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  const check = checkTransition("convert_to_manual", current);
  if (!check.ok) throw conflict(check.code, TRANSITION_MESSAGES[check.code]);
  if (current.stripeSubscriptionId) {
    const provider = getBillingProvider();
    if (!provider.available) throw new AppError(503, "Billing provider unavailable; cannot verify the provider subscription", { code: "PROVIDER_UNAVAILABLE" });
    const remote = await provider.retrieveSubscription(current.stripeSubscriptionId);
    if (remote && remote.status !== "canceled" && remote.status !== "incomplete_expired") {
      throw conflict("LIVE_PROVIDER_SUBSCRIPTION", "A live provider subscription still exists; cancel it in the provider first.");
    }
  }
  return withLockedSubscription(companyId, async (tx, sub) => {
    if (sub.billingSource !== "stripe") throw conflict("NOT_PROVIDER_MANAGED", TRANSITION_MESSAGES.NOT_PROVIDER_MANAGED);
    return commitChange(
      tx,
      sub,
      { billingSource: "manual", stripeSubscriptionId: null, stripePriceId: null, providerStatus: null, cancelAtPeriodEnd: false, currentPeriodStartsAt: null, currentPeriodEndsAt: null, usageAnchorAt: new Date() },
      "subscription.convert_to_manual",
      actor,
    );
  });
}

// ── Provider state application (webhook + manual sync share this) ────────────

export interface ApplyProviderResult {
  changed: boolean;
  outcome: "applied" | "stale" | "no_change" | "mismatch" | "unbound";
  subscription: SubscriptionRow;
}

// Applies the provider's authoritative subscription object to the locked local
// row. Rules:
//   • an event older than the newest applied event is STALE and ignored;
//   • a provider subscription id that disagrees with the bound id is a MISMATCH
//     (nothing changes);
//   • while the platform holds the tenant SUSPENDED, provider state updates only
//     the shadow fields (statusBeforeSuspension / provider*) — access stays blocked;
//   • incomplete / incomplete_expired never change entitlement;
//   • a PLATFORM-MANAGED (manual) row with no bound provider subscription is taken
//     over only by a LIVE provider subscription (trialing/active/past_due/unpaid/
//     paused). A late or terminal event about an old, detached subscription
//     (e.g. after convert-to-manual) is UNBOUND and changes nothing.
export async function applyProviderState(
  tx: Executor,
  sub: SubscriptionRow,
  remote: ProviderSubscription,
  eventCreated: Date | null,
  actor: Actor = PROVIDER_ACTOR,
  extra?: Record<string, string | number | boolean | null>,
): Promise<ApplyProviderResult> {
  if (sub.stripeSubscriptionId && sub.stripeSubscriptionId !== remote.id) return { changed: false, outcome: "mismatch", subscription: sub };
  if (sub.stripeCustomerId && remote.customerId && sub.stripeCustomerId !== remote.customerId) return { changed: false, outcome: "mismatch", subscription: sub };
  if (eventCreated && sub.providerEventCreatedAt && eventCreated.getTime() < sub.providerEventCreatedAt.getTime()) {
    return { changed: false, outcome: "stale", subscription: sub };
  }
  if (sub.billingSource === "manual" && !sub.stripeSubscriptionId && !LIVE_PROVIDER_STATUSES.has(remote.status)) {
    return { changed: false, outcome: "unbound", subscription: sub };
  }
  const mapped = mapProviderStatus(remote.status);
  // The plan follows the VERIFIED price mapping the provider subscription is
  // billed on (server-registered by the platform owner); an unmapped price never
  // changes the plan.
  const mappedPrice = remote.priceId ? await repo.findPlanPriceByProviderId(remote.priceId, tx) : undefined;
  const patch: Partial<SubscriptionRow> = {
    ...(mappedPrice ? { plan: mappedPrice.planId } : {}),
    billingSource: "stripe",
    stripeSubscriptionId: remote.id,
    stripeCustomerId: sub.stripeCustomerId ?? (remote.customerId || null),
    stripePriceId: remote.priceId ?? sub.stripePriceId,
    providerStatus: remote.status,
    providerSyncedAt: new Date(),
    providerEventCreatedAt: eventCreated ?? sub.providerEventCreatedAt,
    currentPeriodStartsAt: remote.currentPeriodStart ?? sub.currentPeriodStartsAt,
    currentPeriodEndsAt: remote.currentPeriodEnd ?? sub.currentPeriodEndsAt,
    cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
    canceledAt: remote.canceledAt ?? (mapped.status === "cancelled" ? sub.canceledAt ?? new Date() : sub.canceledAt),
    endedAt: remote.endedAt ?? (mapped.status === "cancelled" ? sub.endedAt ?? new Date() : null),
    trialStartedAt: remote.trialStart ?? sub.trialStartedAt,
    trialExpiresAt: remote.trialEnd ?? (mapped.status === "trialing" ? sub.trialExpiresAt : null),
  };
  if (mapped.status) {
    if (sub.status === "suspended") patch.statusBeforeSuspension = mapped.status;
    else {
      patch.status = mapped.status;
      patch.pastDueSince = mapped.status === "past_due" ? (sub.pastDueSince ?? new Date()) : null;
    }
  }
  // Skip the write when nothing observable changed (idempotent redelivery).
  const observable = ["plan", "status", "statusBeforeSuspension", "stripeSubscriptionId", "stripeCustomerId", "stripePriceId", "providerStatus", "currentPeriodStartsAt", "currentPeriodEndsAt", "cancelAtPeriodEnd", "canceledAt", "endedAt", "trialExpiresAt", "billingSource"] as const;
  const same = observable.every((k) => {
    const a = sub[k];
    const b = patch[k];
    if (b === undefined) return true;
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime() : a === b;
  });
  if (same) {
    if (eventCreated && (!sub.providerEventCreatedAt || eventCreated.getTime() > sub.providerEventCreatedAt.getTime())) {
      await repo.update(sub.id, { providerEventCreatedAt: eventCreated, providerSyncedAt: new Date() }, tx);
    }
    return { changed: false, outcome: "no_change", subscription: sub };
  }
  const after = await commitChange(tx, sub, patch, "subscription.provider_sync", actor, { providerStatus: remote.status, mapping: mapped.note, ...(extra ?? {}) });
  return { changed: true, outcome: "applied", subscription: after };
}

export async function syncFromProvider(companyId: number, actor: Actor): Promise<ApplyProviderResult> {
  const current = await repo.findByCompanyId(companyId);
  if (!current) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  const check = checkTransition("sync_provider", current);
  if (!check.ok) throw conflict(check.code, TRANSITION_MESSAGES[check.code]);
  if (!current.stripeSubscriptionId) throw conflict("NO_PROVIDER_SUBSCRIPTION", "No provider subscription is bound to this company.");
  const provider = getBillingProvider();
  if (!provider.available) throw new AppError(503, "Billing provider unavailable", { code: "PROVIDER_UNAVAILABLE" });
  const remote = await provider.retrieveSubscription(current.stripeSubscriptionId);
  if (!remote) throw conflict("PROVIDER_SUBSCRIPTION_NOT_FOUND", "The provider no longer knows this subscription.");
  return withLockedSubscription(companyId, async (tx, sub) => applyProviderState(tx, sub, remote, null, actor, { source: "manual_sync" }));
}

// ── System sweep (elapsed manual trials) ─────────────────────────────────────

export async function expireElapsedTrial(tx: Executor, sub: SubscriptionRow, actor: Actor): Promise<SubscriptionRow | null> {
  const check = checkTransition("sweep_expire_trial", sub);
  if (!check.ok) return null;
  if (!sub.trialExpiresAt || sub.trialExpiresAt.getTime() > Date.now()) return null;
  return commitChange(tx, sub, { status: "expired", endedAt: new Date() }, "subscription.trial_expired", actor, { sweep: true });
}
