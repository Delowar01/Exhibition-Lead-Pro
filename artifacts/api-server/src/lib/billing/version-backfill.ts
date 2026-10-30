import { db, auditLogsTable } from "@workspace/db";
import type { Executor } from "../../repositories/base.js";
import * as repo from "../../repositories/subscriptions.repository.js";
import type { PlanRow, PlanVersionRow, SubscriptionRow } from "../../repositories/subscriptions.repository.js";
import { effectiveLimitsFor } from "../../services/entitlements.service.js";
import { LIMIT_RESOURCES } from "./lifecycle.js";
import { writeSubscriptionAudit, type AuditActor } from "./audit.js";
import { defaultTrialPolicy, snapshotFromPlanRow, PLAN_FEATURE_KEYS } from "./plan-versions.js";
import { resolveSubscriptionContext } from "../company-access.js";

// Batch 40 — VERSION-1 COMPATIBILITY BACKFILL (idempotent, dry-run first).
//
// For every PUBLISHED plan that has no version yet, version 1 is the plan row's
// ACTUAL current values (limits, display fields, feature flags, trial days, the
// active verified prices). Every subscription whose version reference is NULL is
// pinned to version 1 of its current plan. BEFORE and AFTER the pins — inside the
// same transaction — every subscription's entitlement is snapshotted and compared
// field by field (effective limits + source, overrides, status, access mode,
// billing source, trial / period dates, provider price); ANY difference rolls the
// whole transaction back. A dry run executes the identical path and always rolls
// back, so the report shows exactly what an apply would do.
//
// Nothing here is scheduled or run at start-up: it is invoked explicitly by
// artifacts/api-server/scripts/backfill-plan-versions.ts (or by tests). It must
// never run against production without the owner's separate authorization.
//
// Batch 41 — SAFETY HARDENING (the Batch 40 defects corrected here):
//   • an UNPINNABLE subscription (plan missing / not published / no published
//     version) can never yield a COMPLETE or APPLIED verdict: the run is rolled
//     back with verdict INCOMPLETE and every diagnostic kept (nothing partial
//     is ever committed);
//   • an INTEGRITY ERROR in a BEFORE or AFTER entitlement snapshot (the limits
//     resolver failed closed for a row) is never counted as parity: such a row
//     is a mismatch by definition and the run is rolled back with verdict
//     INTEGRITY_ERROR;
//   • the report says explicitly `complete`, `verdict`, `integrityErrors` and
//     the evaluation instant; dry-run-first and idempotency are unchanged.

export const BACKFILL_ACTOR: AuditActor = { userId: null, userName: "system:plan-version-backfill", ipAddress: null };

export interface EntitlementSnapshotRow {
  companyId: number;
  subscriptionId: number;
  plan: string;
  planVersionId: number | null;
  status: string;
  billingSource: string;
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  accessMode: string;
  reasonCode: string | null;
  limitOverrides: SubscriptionRow["limitOverrides"];
  effective: Array<{ resource: string; limit: number | null; source: string }> | { error: string };
  stripePriceId: string | null;
  stripeSubscriptionBound: boolean;
  // Batch 41 (PB-3): the feature entitlements and trial policy the gate applies
  // (a legacy NULL reference and its version-1 pin must agree: all allowed,
  // blocked at the trial end).
  featureEnforcement: string;
  features: Record<string, boolean>;
  trialPolicy: { endOutcome: string; readOnlyGraceDays: number };
}

export function snapshotHasIntegrityError(row: Pick<EntitlementSnapshotRow, "effective">): boolean {
  return !Array.isArray(row.effective);
}

// Fields compared BEFORE vs AFTER (everything except the version reference itself).
const COMPARED: Array<keyof EntitlementSnapshotRow> = [
  "subscriptionId",
  "plan",
  "status",
  "billingSource",
  "trialStartedAt",
  "trialExpiresAt",
  "currentPeriodStartsAt",
  "currentPeriodEndsAt",
  "cancelAtPeriodEnd",
  "accessMode",
  "reasonCode",
  "limitOverrides",
  "effective",
  "stripePriceId",
  "stripeSubscriptionBound",
  "featureEnforcement",
  "features",
  "trialPolicy",
];

export async function snapshotSubscription(sub: SubscriptionRow, now: Date, tx?: Executor): Promise<EntitlementSnapshotRow> {
  let effective: EntitlementSnapshotRow["effective"];
  try {
    const limits = await effectiveLimitsFor(sub, tx);
    effective = LIMIT_RESOURCES.map((r) => {
      const l = limits.find((x) => x.resource === r);
      return { resource: r, limit: l?.limit ?? null, source: l?.source ?? "unlimited" };
    });
  } catch (err) {
    effective = { error: (err as { code?: string }).code ?? "ERROR" };
  }
  const ctx = await resolveSubscriptionContext(sub, now, tx);
  const ent = ctx.entitlement;
  return {
    companyId: sub.companyId,
    subscriptionId: sub.id,
    plan: sub.plan,
    planVersionId: sub.planVersionId ?? null,
    status: sub.status,
    billingSource: sub.billingSource,
    trialStartedAt: sub.trialStartedAt?.toISOString() ?? null,
    trialExpiresAt: sub.trialExpiresAt?.toISOString() ?? null,
    currentPeriodStartsAt: sub.currentPeriodStartsAt?.toISOString() ?? null,
    currentPeriodEndsAt: sub.currentPeriodEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    accessMode: ent.accessMode,
    reasonCode: ent.reasonCode,
    limitOverrides: sub.limitOverrides,
    effective,
    stripePriceId: sub.stripePriceId,
    stripeSubscriptionBound: !!sub.stripeSubscriptionId,
    featureEnforcement: ctx.features.enforcement,
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, ctx.features.allowed[k]])),
    trialPolicy: { endOutcome: ctx.trialPolicy.endOutcome, readOnlyGraceDays: ctx.trialPolicy.readOnlyGraceDays },
  };
}

export async function entitlementSnapshot(now: Date, tx?: Executor): Promise<EntitlementSnapshotRow[]> {
  const subs = await repo.allSubscriptionsWithCompanies(tx);
  const out: EntitlementSnapshotRow[] = [];
  for (const { s } of subs) out.push(await snapshotSubscription(s, now, tx));
  return out.sort((a, b) => a.companyId - b.companyId);
}

export interface SnapshotMismatch {
  companyId: number;
  field: string;
  before: unknown;
  after: unknown;
}

// Field-by-field comparison; the version reference is the only field allowed to change.
// Batch 41: an integrity error on EITHER side is a mismatch by definition — two
// failed resolutions are never "equal" entitlements (the Batch 40 comparison
// treated `{ error }` == `{ error }` as parity).
export function compareSnapshots(before: EntitlementSnapshotRow[], after: EntitlementSnapshotRow[]): SnapshotMismatch[] {
  const out: SnapshotMismatch[] = [];
  const byCompany = new Map(after.map((r) => [r.companyId, r]));
  for (const b of before) {
    const a = byCompany.get(b.companyId);
    if (!a) {
      out.push({ companyId: b.companyId, field: "row", before: "present", after: "missing" });
      continue;
    }
    if (snapshotHasIntegrityError(b) || snapshotHasIntegrityError(a)) {
      out.push({ companyId: b.companyId, field: "effective.integrity", before: b.effective, after: a.effective });
    }
    for (const f of COMPARED) {
      const bv = JSON.stringify(b[f] ?? null);
      const av = JSON.stringify(a[f] ?? null);
      if (bv !== av) out.push({ companyId: b.companyId, field: f, before: b[f] ?? null, after: a[f] ?? null });
    }
  }
  for (const a of after) if (!before.some((b) => b.companyId === a.companyId)) out.push({ companyId: a.companyId, field: "row", before: "missing", after: "present" });
  return out;
}

export interface BackfillPlanEntry {
  planId: string;
  status: string;
  action: "version_created" | "version_exists" | "skipped_not_published" | "blocked_draft_only";
  versionId: number | null;
  version: number | null;
}
export interface BackfillPinEntry {
  companyId: number;
  subscriptionId: number;
  planId: string;
  versionId: number;
  version: number;
}
export interface BackfillUnpinnable {
  companyId: number;
  subscriptionId: number;
  planId: string;
  reason: "plan_not_published" | "plan_has_no_published_version" | "plan_missing";
}
export interface BackfillIntegrityError {
  phase: "before" | "after";
  companyId: number;
  subscriptionId: number;
  code: string;
}

// Batch 41 verdicts:
//   APPLIED             every reference resolved, parity proven, committed
//   DRY_RUN_OK          same as APPLIED but rolled back on purpose (nothing written)
//   INCOMPLETE          at least one subscription could not be pinned — rolled back
//   INTEGRITY_ERROR     a BEFORE/AFTER snapshot failed to resolve — rolled back
//   VERIFICATION_FAILED BEFORE != AFTER for a tenant — rolled back
export type BackfillVerdict = "APPLIED" | "DRY_RUN_OK" | "INCOMPLETE" | "INTEGRITY_ERROR" | "VERIFICATION_FAILED";

export interface BackfillReport {
  mode: "dry-run" | "apply";
  startedAt: string;
  finishedAt: string;
  // The instant every entitlement was evaluated at (the caller's `now`).
  evaluationInstant: string;
  plans: BackfillPlanEntry[];
  subscriptions: {
    total: number;
    alreadyPinned: number;
    pinned: BackfillPinEntry[];
    unpinnable: BackfillUnpinnable[];
  };
  verification: { compared: number; mismatches: SnapshotMismatch[] };
  integrityErrors: BackfillIntegrityError[];
  // true only when EVERY NULL reference was (or, in a dry run, would be)
  // resolved and parity was proven for every tenant. Never true with an
  // unpinnable subscription or an integrity error.
  complete: boolean;
  verdict: BackfillVerdict;
  applied: boolean;
  rolledBack: boolean;
  reason: string | null;
}

export interface BackfillOptions {
  apply: boolean;
  actor?: AuditActor;
  now?: Date;
}

class RollbackSignal extends Error {
  constructor(readonly report: BackfillReport) {
    super("rollback");
  }
}

export async function runVersionBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? BACKFILL_ACTOR;
  const startedAt = new Date().toISOString();
  const base = (): BackfillReport => ({
    mode: opts.apply ? "apply" : "dry-run",
    startedAt,
    finishedAt: new Date().toISOString(),
    evaluationInstant: now.toISOString(),
    plans: [],
    subscriptions: { total: 0, alreadyPinned: 0, pinned: [], unpinnable: [] },
    verification: { compared: 0, mismatches: [] },
    integrityErrors: [],
    complete: false,
    verdict: "INCOMPLETE",
    applied: false,
    rolledBack: false,
    reason: null,
  });
  const integrityErrorsOf = (phase: "before" | "after", rows: EntitlementSnapshotRow[]): BackfillIntegrityError[] =>
    rows.filter(snapshotHasIntegrityError).map((r) => ({ phase, companyId: r.companyId, subscriptionId: r.subscriptionId, code: (r.effective as { error: string }).error }));
  try {
    return await db.transaction(async (tx) => {
      const report = base();
      // 1. BEFORE — every subscription's entitlement as it is today. A row whose
      //    entitlement cannot be resolved is an integrity fault: refuse before
      //    touching anything (no version, no pin), with the diagnostics kept.
      const before = await entitlementSnapshot(now, tx);
      report.subscriptions.total = before.length;
      report.integrityErrors.push(...integrityErrorsOf("before", before));
      if (report.integrityErrors.length > 0) {
        report.finishedAt = new Date().toISOString();
        report.verdict = "INTEGRITY_ERROR";
        report.rolledBack = true;
        report.reason = `${report.integrityErrors.length} subscription(s) could not resolve their entitlement before the backfill; nothing was changed`;
        throw new RollbackSignal(report);
      }
      // 2. Plans: lock every row; create version 1 where no version exists.
      const plans = await repo.lockAllPlans(tx);
      const currentByPlan = new Map<string, PlanVersionRow>();
      for (const plan of plans) {
        const versions = await repo.listPlanVersions(plan.id, tx);
        const current = await repo.findCurrentPublishedVersion(plan.id, tx);
        if (plan.status !== "published") {
          report.plans.push({ planId: plan.id, status: plan.status, action: "skipped_not_published", versionId: current?.id ?? null, version: current?.version ?? null });
          if (current) currentByPlan.set(plan.id, current);
          continue;
        }
        if (current) {
          currentByPlan.set(plan.id, current);
          report.plans.push({ planId: plan.id, status: plan.status, action: "version_exists", versionId: current.id, version: current.version });
          continue;
        }
        if (versions.length > 0) {
          // A draft (or only retired versions) without a published version: version 1
          // would no longer be the legacy snapshot — refuse rather than guess.
          report.plans.push({ planId: plan.id, status: plan.status, action: "blocked_draft_only", versionId: null, version: null });
          continue;
        }
        const prices = (await repo.listPlanPricesForVersion(plan.id, null, tx)).filter((p) => p.active);
        const created = await createVersionOne(tx, plan, prices, now, actor);
        currentByPlan.set(plan.id, created);
        report.plans.push({ planId: plan.id, status: plan.status, action: "version_created", versionId: created.id, version: created.version });
      }
      // 3. Subscriptions: pin every NULL reference to its plan's version 1 / current version.
      const unpinned = await repo.lockUnpinnedSubscriptions(tx);
      report.subscriptions.alreadyPinned = before.length - unpinned.length;
      for (const sub of unpinned) {
        const plan = plans.find((p) => p.id === sub.plan);
        if (!plan) {
          report.subscriptions.unpinnable.push({ companyId: sub.companyId, subscriptionId: sub.id, planId: sub.plan, reason: "plan_missing" });
          continue;
        }
        if (plan.status !== "published") {
          report.subscriptions.unpinnable.push({ companyId: sub.companyId, subscriptionId: sub.id, planId: sub.plan, reason: "plan_not_published" });
          continue;
        }
        const version = currentByPlan.get(sub.plan);
        if (!version) {
          report.subscriptions.unpinnable.push({ companyId: sub.companyId, subscriptionId: sub.id, planId: sub.plan, reason: "plan_has_no_published_version" });
          continue;
        }
        const after = await repo.update(sub.id, { planVersionId: version.id }, tx);
        if (!after) throw new Error(`subscription ${sub.id} vanished during the backfill`);
        await writeSubscriptionAudit(tx, { action: "subscription.pin_version", companyId: sub.companyId, subscriptionId: sub.id, before: sub, after, actor, extra: { backfill: true, planVersionId: version.id, version: version.version } });
        report.subscriptions.pinned.push({ companyId: sub.companyId, subscriptionId: sub.id, planId: sub.plan, versionId: version.id, version: version.version });
      }
      // 4. AFTER — identical entitlement required for every subscription. An
      //    integrity error here (a pin that made a row unresolvable) is never
      //    parity: it is reported and the whole run rolls back.
      const after = await entitlementSnapshot(now, tx);
      report.verification.compared = before.length;
      report.verification.mismatches = compareSnapshots(before, after);
      report.integrityErrors.push(...integrityErrorsOf("after", after));
      report.finishedAt = new Date().toISOString();
      if (report.integrityErrors.length > 0) {
        report.verdict = "INTEGRITY_ERROR";
        report.rolledBack = true;
        report.reason = `${report.integrityErrors.length} subscription(s) could not resolve their entitlement after the pins; nothing was changed`;
        throw new RollbackSignal(report);
      }
      if (report.verification.mismatches.length > 0) {
        report.verdict = "VERIFICATION_FAILED";
        report.rolledBack = true;
        report.reason = `verification found ${report.verification.mismatches.length} difference(s); nothing was changed`;
        throw new RollbackSignal(report);
      }
      // 5. Completeness — an unpinnable subscription means the backfill cannot
      //    deliver what it promises (every reference resolved). Nothing partial
      //    is ever committed: roll back and say so, keeping the diagnostics.
      if (report.subscriptions.unpinnable.length > 0) {
        report.verdict = "INCOMPLETE";
        report.rolledBack = true;
        report.reason = `${report.subscriptions.unpinnable.length} subscription(s) cannot be pinned (${Array.from(new Set(report.subscriptions.unpinnable.map((u) => u.reason))).join(", ")}); the backfill is incomplete and nothing was changed`;
        throw new RollbackSignal(report);
      }
      report.complete = true;
      if (!opts.apply) {
        report.verdict = "DRY_RUN_OK";
        report.rolledBack = true;
        report.reason = "dry run: the transaction was rolled back on purpose";
        throw new RollbackSignal(report);
      }
      report.verdict = "APPLIED";
      report.applied = true;
      return report;
    });
  } catch (err) {
    if (err instanceof RollbackSignal) return err.report;
    throw err;
  }
}

async function createVersionOne(tx: Executor, plan: PlanRow, prices: Awaited<ReturnType<typeof repo.listPlanPricesForVersion>>, now: Date, actor: AuditActor): Promise<PlanVersionRow> {
  const snapshot = snapshotFromPlanRow(plan, prices);
  const trialPolicy = defaultTrialPolicy(plan.trialDays);
  const version = (await repo.maxVersionNumber(plan.id, tx)) + 1;
  const created = await repo.insertPlanVersion({ planId: plan.id, version, snapshot, trialPolicy, publishedAt: now, publishedBy: actor.userId }, tx);
  await tx.insert(auditLogsTable).values({
    companyId: null,
    userId: actor.userId,
    userName: actor.userName,
    action: "plan_version.backfill",
    entityType: "plan_version",
    entityId: String(created.id),
    metadata: { planId: plan.id, version, source: "plan_row", limits: snapshot.limits, trialDays: plan.trialDays, priceCount: prices.length },
    ipAddress: actor.ipAddress,
  });
  return created;
}
