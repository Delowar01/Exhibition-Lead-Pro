import { db, subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_TRIAL_END_POLICY,
  normalizeLegacyStatus,
  resolveEntitlement,
  trialGraceEndsAt,
  type AccessMode,
  type Entitlement,
  type EntitlementReason,
  type TrialEndPolicy,
} from "./billing/lifecycle.js";
import { invalidFeatureEntitlements, resolveFeatureEntitlements, trialEndPolicyOf, type FeatureEntitlements, type PlanFeatureKey } from "./billing/plan-versions.js";
import { AppError } from "../middlewares/errorHandler.js";
import type { Executor } from "../repositories/base.js";
import * as subsRepo from "../repositories/subscriptions.repository.js";
import type { PlanVersionRow, SubscriptionRow } from "../repositories/subscriptions.repository.js";

// Batch 20 — tenant access is decided EXCLUSIVELY from the canonical
// `subscriptions` row through the shared entitlement resolver. This module is
// the ONLY reader used by the login path (services/auth.service.ts), the
// per-request gate (middlewares/requireAuth.ts) and the refresh-token rotation
// (lib/sessions.ts). The legacy companies.status / companies.trial_ends_at
// columns are never consulted (test/b20-structural.test.ts proves it).
//
// Batch 41 (PB-3) — the SAME decision path also resolves, from the subscription's
// pinned plan version, (a) the end-of-trial policy that feeds the entitlement
// resolver (read-only grace, U5) and (b) the feature entitlements (the fixed
// catalog, U2) that the per-request feature gate enforces. One resolution,
// one place: `resolveSubscriptionContext`.

export type CompanyAccess = { blocked: true; reason: string; reasonCode: EntitlementReason } | { blocked: false; readOnly: boolean; reasonCode: EntitlementReason | null };

export interface SubscriptionSummary {
  plan: string;
  status: string;
  billingSource: string;
  accessMode: AccessMode;
  reasonCode: EntitlementReason | null;
  message: string | null;
  trialExpiresAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
}

// Batch 41: the tenant-facing entitlement projection (login, /auth/me,
// GET /subscriptions/current) — what the web and mobile clients use to show or
// hide a capability. It is DERIVED from the same server decision that
// `requireFeature` enforces, so the UI can never disagree with the API.
export interface TenantEntitlements {
  planVersionId: number | null;
  featureEnforcement: FeatureEntitlements["enforcement"];
  features: Record<PlanFeatureKey, boolean>;
  trialPolicy: { endOutcome: TrialEndPolicy["endOutcome"]; readOnlyGraceDays: number; graceEndsAt: string | null };
}

export interface SubscriptionContext {
  sub: SubscriptionRow;
  // The pinned version when the reference is valid; null for a legacy NULL
  // reference. `versionValid` is false when the reference exists but is
  // missing, unpublished or belongs to another plan (fail closed).
  version: PlanVersionRow | null;
  versionValid: boolean;
  trialPolicy: TrialEndPolicy;
  entitlement: Entitlement;
  features: FeatureEntitlements;
}

export interface TenantAccess {
  access: CompanyAccess;
  entitlement: Entitlement;
  summary: SubscriptionSummary | null;
  // null only when the company has no subscription row (blocked anyway).
  entitlements: TenantEntitlements | null;
}

export function accessFromEntitlement(e: Entitlement): CompanyAccess {
  if (e.accessMode === "blocked") return { blocked: true, reason: e.message ?? "Access is blocked.", reasonCode: e.reasonCode ?? "UNKNOWN_STATUS" };
  return { blocked: false, readOnly: e.accessMode === "read_only", reasonCode: e.reasonCode };
}

export function summarizeSubscription(sub: typeof subscriptionsTable.$inferSelect, e: Entitlement): SubscriptionSummary {
  return {
    plan: sub.plan,
    status: normalizeLegacyStatus(sub.status) ?? sub.status,
    billingSource: sub.billingSource,
    accessMode: e.accessMode,
    reasonCode: e.reasonCode,
    message: e.message,
    trialExpiresAt: sub.trialExpiresAt ? sub.trialExpiresAt.toISOString() : null,
    currentPeriodEndsAt: sub.currentPeriodEndsAt ? sub.currentPeriodEndsAt.toISOString() : null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

// Batch 41 — resolves the version-dependent policy of ONE subscription.
//   NULL reference     → legacy: default trial policy (blocked, no grace), every
//                        catalog feature allowed (grandfathered).
//   valid reference    → the version's trial policy + feature entitlements
//                        (enforced only when the version says "enforced").
//   invalid reference  → fail closed: default trial policy (never a grace the
//                        row cannot prove), every feature DENIED, enforcement
//                        "invalid". Authentication, billing and administrative
//                        recovery are NOT blocked by this (the limits path keeps
//                        raising SUBSCRIPTION_PLAN_VERSION_INVALID as before).
export async function resolveSubscriptionContext(sub: SubscriptionRow, now: Date = new Date(), tx?: Executor): Promise<SubscriptionContext> {
  let version: PlanVersionRow | null = null;
  let versionValid = true;
  if (sub.planVersionId != null) {
    const row = await subsRepo.findPlanVersionById(sub.planVersionId, tx);
    if (!row || row.planId !== sub.plan || !row.publishedAt) versionValid = false;
    else version = row;
  }
  const trialPolicy = versionValid && version ? trialEndPolicyOf(version.trialPolicy) : DEFAULT_TRIAL_END_POLICY;
  const entitlement = resolveEntitlement(sub, now, trialPolicy);
  const features = versionValid ? resolveFeatureEntitlements(version?.snapshot ?? null) : invalidFeatureEntitlements();
  return { sub, version, versionValid, trialPolicy, entitlement, features };
}

export function tenantEntitlementsOf(ctx: SubscriptionContext): TenantEntitlements {
  const graceEndsAt = ctx.sub.trialExpiresAt && ctx.trialPolicy.endOutcome === "read_only" ? trialGraceEndsAt(ctx.sub.trialExpiresAt, ctx.trialPolicy).toISOString() : null;
  return {
    planVersionId: ctx.sub.planVersionId ?? null,
    featureEnforcement: ctx.features.enforcement,
    features: { ...ctx.features.allowed },
    trialPolicy: { endOutcome: ctx.trialPolicy.endOutcome, readOnlyGraceDays: ctx.trialPolicy.readOnlyGraceDays, graceEndsAt },
  };
}

// Loads the company's canonical subscription and resolves its entitlement.
// A company without a subscription row resolves to BLOCKED (fail closed): the
// repair command (scripts/repair-subscriptions.ts) guarantees a row for every
// existing company before the Batch 20 API serves traffic, and every creation
// path inserts the row in the same transaction as the company.
export async function loadTenantAccess(companyId: number, now: Date = new Date()): Promise<TenantAccess> {
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
  if (!sub) {
    const entitlement = resolveEntitlement(null, now);
    return { access: accessFromEntitlement(entitlement), entitlement, summary: null, entitlements: null };
  }
  const ctx = await resolveSubscriptionContext(sub, now);
  return { access: accessFromEntitlement(ctx.entitlement), entitlement: ctx.entitlement, summary: summarizeSubscription(sub, ctx.entitlement), entitlements: tenantEntitlementsOf(ctx) };
}

// ── Background-work gate (B20 Correction 1) ──────────────────────────────────
// Every scheduler sweep / queue handler that performs a side effect on a tenant's
// behalf (email, push, notification, CRM write, AI provider call, export artifact)
// re-reads the CANONICAL entitlement first — never the legacy companies.status
// mirror, never a principal captured at enqueue time. Anything but `full` means
// the work is not performed and the caller records a deterministic
// SUBSCRIPTION_NOT_WRITABLE outcome (no retry, no replay).

export interface TenantWritable {
  writable: boolean;
  accessMode: AccessMode;
  reasonCode: EntitlementReason | null;
}

export async function tenantWritable(companyId: number, now: Date = new Date()): Promise<TenantWritable> {
  const { entitlement } = await loadTenantAccess(companyId, now);
  return { writable: entitlement.accessMode === "full", accessMode: entitlement.accessMode, reasonCode: entitlement.reasonCode };
}

export class TenantNotWritableError extends AppError {
  readonly accessMode: AccessMode;
  readonly reasonCode: EntitlementReason | null;
  constructor(companyId: number, gate: TenantWritable) {
    super(403, `The company's subscription is ${gate.accessMode === "blocked" ? "blocked" : "read-only"}; background work was not performed.`, {
      code: "SUBSCRIPTION_NOT_WRITABLE",
      details: { companyId, accessMode: gate.accessMode, reasonCode: gate.reasonCode },
    });
    this.accessMode = gate.accessMode;
    this.reasonCode = gate.reasonCode;
    Object.setPrototypeOf(this, TenantNotWritableError.prototype);
  }
}

export async function assertTenantWritable(companyId: number, now: Date = new Date()): Promise<void> {
  const gate = await tenantWritable(companyId, now);
  if (!gate.writable) throw new TenantNotWritableError(companyId, gate);
}

// Batch 41 — background-work FEATURE gate: a scheduler must not produce a
// side effect for a feature the tenant's plan version does not grant (e.g. a
// scheduled export when `exports.scheduled` is denied). Same decision path as
// the per-request gate; fails closed on an invalid version reference.
export interface TenantFeatureGate {
  allowed: boolean;
  enforcement: FeatureEntitlements["enforcement"];
  planVersionId: number | null;
}

export async function tenantFeatureAllowed(companyId: number, feature: PlanFeatureKey, now: Date = new Date()): Promise<TenantFeatureGate> {
  const { entitlements } = await loadTenantAccess(companyId, now);
  if (!entitlements) return { allowed: false, enforcement: "invalid", planVersionId: null };
  return { allowed: entitlements.features[feature] === true, enforcement: entitlements.featureEnforcement, planVersionId: entitlements.planVersionId };
}

// One query for global sweeps: the ids of every company whose canonical
// entitlement is `full` right now. Companies without a subscription row are
// absent (fail closed). A read-only trial grace never makes a tenant writable,
// so the default policy is exact here: grace only turns "blocked" into
// "read_only", and neither is `full`.
export async function writableCompanyIds(now: Date = new Date()): Promise<Set<number>> {
  const rows = await db.select().from(subscriptionsTable);
  const out = new Set<number>();
  for (const sub of rows) if (resolveEntitlement(sub, now).accessMode === "full") out.add(sub.companyId);
  return out;
}
