import { createHash } from "node:crypto";
import { AppError } from "../middlewares/errorHandler.js";
import type { Executor } from "../repositories/base.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { PlanRow, PlanVersionRow, SubscriptionRow } from "../repositories/subscriptions.repository.js";
import { resolvePlanAssignment } from "../lib/billing/plan-catalog.js";
import { LIMIT_RESOURCES, checkTransition, normalizeLegacyStatus, resolveEffectiveLimits, type EffectiveLimit, type LimitResource, type PlanLimitDefaults } from "../lib/billing/lifecycle.js";
import { PLAN_FEATURE_KEYS, allowancesOf, featureEnforcementOf, limitTightens, limitsAsPlanDefaults, resolveFeatureEntitlements, trialEndPolicyOf, type PlanFeatureKey, type PlanVersionAllowances } from "../lib/billing/plan-versions.js";
import { resolveSubscriptionContext } from "../lib/company-access.js";
import { SubscriptionIntegrityError, effectiveLimitsFor, measureUsage } from "./entitlements.service.js";

// Batch 42 (PB-4.4) — the ONE evaluation of a plan / version change for a tenant,
// shared by the owner's direct change (set-plan), its read-only preview and the
// tenant migration (dry run AND execution recheck). It never writes.
//
//   • target = a PUBLISHED plan and either an explicit published version of it
//     (retired allowed for an explicit owner choice, draft never) or the plan's
//     current published version (null = legacy plan-row reference);
//   • limits: the TARGET version's defaults through the single resolver with the
//     tenant's own overrides (tenant override precedence is the resolver's rule)
//     compared with the tenant's MEASURED usage — U6: any measurable resource
//     whose usage exceeds the target limit BLOCKS the change (never silent data
//     deletion); unmeasurable resources (storage) are reported, never "verified";
//   • features: what the tenant has now (the same decision path as the request
//     gate) vs what the target version grants; a feature-only downgrade requires
//     explicit confirmation (owner decision D3);
//   • the current reference may be INVALID (fail-closed elsewhere): the change
//     is then a repair and the comparison reports the current side as unknown.

export type VersionAssignState = "published" | "retired" | "legacy";

export interface ChangeTarget {
  plan: PlanRow;
  version: PlanVersionRow | null; // null = legacy reference (no published version)
  explicit: boolean;
}

function intId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export function versionAssignState(v: PlanVersionRow | null): VersionAssignState {
  if (!v) return "legacy";
  return v.retiredAt ? "retired" : "published";
}

// Resolves the target under the plan's SHARE lock (serializes with publish / retire).
export async function resolveChangeTarget(planId: unknown, planVersionId: unknown, tx: Executor): Promise<ChangeTarget> {
  const plan = typeof planId === "string" ? planId : "";
  const assignment = await resolvePlanAssignment(plan, tx);
  if (!assignment) throw new AppError(400, "Invalid plan", { code: "INVALID_PLAN" });
  if (planVersionId === undefined || planVersionId === null) {
    const version = assignment.planVersionId != null ? ((await repo.findPlanVersionById(assignment.planVersionId, tx)) ?? null) : null;
    return { plan: assignment.plan, version, explicit: false };
  }
  const id = intId(planVersionId);
  if (id == null) throw new AppError(400, "planVersionId must be a positive integer", { code: "INVALID_VERSION_ID" });
  const version = await repo.findPlanVersionById(id, tx);
  if (!version || version.planId !== assignment.plan.id) throw new AppError(404, "Plan version not found for this plan", { code: "VERSION_NOT_FOUND" });
  if (!version.publishedAt) throw new AppError(409, "Only a published version can be assigned; publish the draft first", { code: "VERSION_NOT_PUBLISHED", details: { versionId: version.id, version: version.version } });
  return { plan: assignment.plan, version, explicit: true };
}

export interface LimitComparisonRow {
  resource: LimitResource;
  currentLimit: number | null; // null = unlimited (or unknown when currentValid is false)
  targetLimit: number | null;
  targetSource: EffectiveLimit["source"];
  override: number | null;
  used: number;
  measurable: boolean;
  exceeds: boolean;
  tightens: boolean;
  loosens: boolean;
}

export interface PlanChangeEvaluation {
  current: { plan: string; planVersionId: number | null; version: number | null; valid: boolean; legacyReference: boolean; billingSource: string; status: string };
  target: { plan: string; planVersionId: number | null; version: number | null; state: VersionAssignState; explicit: boolean };
  sameTarget: boolean;
  changeKind: "none" | "plan_change" | "version_change" | "repair";
  transition: { ok: boolean; code: string | null };
  limits: LimitComparisonRow[];
  blocking: Array<{ resource: LimitResource; used: number; limit: number }>;
  unmeasurable: LimitResource[];
  tightenedLimits: LimitResource[];
  loosenedLimits: LimitResource[];
  features: {
    enforcement: { current: string; target: string };
    current: Record<PlanFeatureKey, boolean>;
    target: Record<PlanFeatureKey, boolean>;
    lost: PlanFeatureKey[];
    gained: PlanFeatureKey[];
  };
  trialPolicy: { current: { endOutcome: string; readOnlyGraceDays: number }; target: { endOutcome: string; readOnlyGraceDays: number } };
  allowances: { current: PlanVersionAllowances; target: PlanVersionAllowances };
  requiresFeatureConfirmation: boolean;
  eligible: boolean; // transition ok, nothing blocking (confirmation aside)
}

export async function evaluatePlanChange(sub: SubscriptionRow, target: ChangeTarget, now: Date, tx?: Executor): Promise<PlanChangeEvaluation> {
  const ctx = await resolveSubscriptionContext(sub, now, tx);
  let currentLimits: EffectiveLimit[] | null = null;
  try {
    currentLimits = await effectiveLimitsFor(sub, tx);
  } catch (err) {
    if (!(err instanceof SubscriptionIntegrityError)) throw err;
  }
  const targetDefaults: PlanLimitDefaults = target.version ? limitsAsPlanDefaults(target.version.snapshot.limits) : target.plan;
  const targetLimits = resolveEffectiveLimits(targetDefaults, sub.limitOverrides);
  const usage = await measureUsage(sub.companyId, sub, now, tx);
  const limits: LimitComparisonRow[] = LIMIT_RESOURCES.map((resource) => {
    const t = targetLimits.find((l) => l.resource === resource) ?? { resource, limit: null, source: "unlimited" as const };
    const c = currentLimits?.find((l) => l.resource === resource) ?? null;
    const u = usage.find((x) => x.resource === resource);
    const used = u?.used ?? 0;
    const measurable = u?.measurable ?? false;
    const o = sub.limitOverrides?.[resource];
    return {
      resource,
      currentLimit: c?.limit ?? null,
      targetLimit: t.limit,
      targetSource: t.source,
      override: typeof o === "number" && Number.isFinite(o) && o >= 0 ? Math.floor(o) : null,
      used,
      measurable,
      exceeds: measurable && t.limit != null && used > t.limit,
      tightens: currentLimits != null && limitTightens(c?.limit ?? null, t.limit),
      loosens: currentLimits != null && limitTightens(t.limit, c?.limit ?? null),
    };
  });
  const targetFeatures = resolveFeatureEntitlements(target.version?.snapshot ?? null);
  const lost = PLAN_FEATURE_KEYS.filter((k) => ctx.features.allowed[k] === true && targetFeatures.allowed[k] === false);
  const gained = PLAN_FEATURE_KEYS.filter((k) => ctx.features.allowed[k] === false && targetFeatures.allowed[k] === true);
  const sameTarget = sub.plan === target.plan.id && (sub.planVersionId ?? null) === (target.version?.id ?? null);
  const changeKind: PlanChangeEvaluation["changeKind"] = sameTarget ? "none" : sub.plan !== target.plan.id ? "plan_change" : !ctx.versionValid ? "repair" : "version_change";
  const transition = checkTransition("set_plan", sub);
  const blocking = limits.filter((r) => r.exceeds).map((r) => ({ resource: r.resource, used: r.used, limit: r.targetLimit as number }));
  const targetTrial = trialEndPolicyOf(target.version?.trialPolicy ?? null);
  return {
    current: { plan: sub.plan, planVersionId: sub.planVersionId ?? null, version: ctx.version?.version ?? null, valid: ctx.versionValid, legacyReference: sub.planVersionId == null, billingSource: sub.billingSource, status: normalizeLegacyStatus(sub.status) ?? sub.status },
    target: { plan: target.plan.id, planVersionId: target.version?.id ?? null, version: target.version?.version ?? null, state: versionAssignState(target.version), explicit: target.explicit },
    sameTarget,
    changeKind,
    transition: { ok: transition.ok, code: transition.ok ? null : transition.code },
    limits,
    blocking,
    unmeasurable: limits.filter((r) => !r.measurable).map((r) => r.resource),
    tightenedLimits: limits.filter((r) => r.tightens).map((r) => r.resource),
    loosenedLimits: limits.filter((r) => r.loosens).map((r) => r.resource),
    features: {
      enforcement: { current: ctx.features.enforcement, target: target.version ? featureEnforcementOf(target.version.snapshot) : "legacy" },
      current: { ...ctx.features.allowed },
      target: { ...targetFeatures.allowed },
      lost,
      gained,
    },
    trialPolicy: { current: { endOutcome: ctx.trialPolicy.endOutcome, readOnlyGraceDays: ctx.trialPolicy.readOnlyGraceDays }, target: { endOutcome: targetTrial.endOutcome, readOnlyGraceDays: targetTrial.readOnlyGraceDays } },
    allowances: { current: ctx.version ? allowancesOf(ctx.version.snapshot) : { aiTokensPerMonth: null, aiCostMicroUsdPerMonth: null }, target: allowancesOf(target.version?.snapshot ?? null) },
    requiresFeatureConfirmation: lost.length > 0,
    eligible: transition.ok && blocking.length === 0,
  };
}

// Throws the deterministic 409s of a refused change (U6 + D3).
export function assertChangeAllowed(e: PlanChangeEvaluation, opts: { confirmFeatureDowngrade: boolean }): void {
  if (e.blocking.length > 0) {
    throw new AppError(409, `The change is blocked: current usage exceeds the target limits for ${e.blocking.map((b) => b.resource).join(", ")}. Reduce usage or raise a tenant override first; no data is deleted.`, {
      code: "DOWNGRADE_BLOCKED",
      details: { blocking: e.blocking, unmeasurable: e.unmeasurable, targetPlan: e.target.plan, targetPlanVersionId: e.target.planVersionId },
    });
  }
  if (e.requiresFeatureConfirmation && !opts.confirmFeatureDowngrade) {
    throw new AppError(409, `The target version removes features the tenant currently has (${e.features.lost.join(", ")}); repeat the request with confirmFeatureDowngrade: true to apply it.`, {
      code: "FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED",
      details: { lostFeatures: e.features.lost, targetPlan: e.target.plan, targetPlanVersionId: e.target.planVersionId },
    });
  }
}

// The safe audit summary of an evaluated change (plan history reads it back).
export function changeAuditExtra(e: PlanChangeEvaluation, extra: Record<string, unknown>): Record<string, unknown> {
  const limitsOf = (pick: (r: LimitComparisonRow) => number | null) => Object.fromEntries(e.limits.map((r) => [r.resource, pick(r)]));
  return {
    changeKind: e.changeKind,
    previousPlan: e.current.plan,
    previousPlanVersionId: e.current.planVersionId,
    previousVersion: e.current.version,
    previousReferenceValid: e.current.valid,
    planVersionId: e.target.planVersionId,
    targetVersion: e.target.version,
    targetVersionState: e.target.state,
    limitsBefore: e.current.valid ? limitsOf((r) => r.currentLimit) : null,
    limitsAfter: limitsOf((r) => r.targetLimit),
    tightenedLimits: e.tightenedLimits,
    loosenedLimits: e.loosenedLimits,
    unmeasurable: e.unmeasurable,
    lostFeatures: e.features.lost,
    gainedFeatures: e.features.gained,
    featureEnforcementBefore: e.features.enforcement.current,
    featureEnforcementAfter: e.features.enforcement.target,
    ...extra,
  };
}

// Re-reads the committed row INSIDE the same transaction and proves that the
// limits / features it now resolves to are exactly what the evaluation predicted;
// any difference throws (the caller's transaction rolls back — nothing applied).
export async function verifyAppliedChange(after: SubscriptionRow, e: PlanChangeEvaluation, now: Date, tx: Executor): Promise<void> {
  const limits = await effectiveLimitsFor(after, tx);
  for (const row of e.limits) {
    const got = limits.find((l) => l.resource === row.resource)?.limit ?? null;
    if (got !== row.targetLimit) throw new AppError(500, "Plan change verification failed; the change was rolled back", { code: "PLAN_CHANGE_VERIFICATION_FAILED", details: { resource: row.resource, expected: row.targetLimit, actual: got } });
  }
  const ctx = await resolveSubscriptionContext(after, now, tx);
  if (!ctx.versionValid) throw new AppError(500, "Plan change verification failed; the change was rolled back", { code: "PLAN_CHANGE_VERIFICATION_FAILED", details: { reason: "version_invalid" } });
  for (const k of PLAN_FEATURE_KEYS) {
    if (ctx.features.allowed[k] !== e.features.target[k]) throw new AppError(500, "Plan change verification failed; the change was rolled back", { code: "PLAN_CHANGE_VERIFICATION_FAILED", details: { feature: k } });
  }
  if (after.plan !== e.target.plan || (after.planVersionId ?? null) !== e.target.planVersionId) throw new AppError(500, "Plan change verification failed; the change was rolled back", { code: "PLAN_CHANGE_VERIFICATION_FAILED", details: { reason: "reference" } });
}

// Deterministic digest over the facts an owner reviewed (stable key order).
export function digestOf(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
