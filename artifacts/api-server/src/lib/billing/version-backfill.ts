import { db, auditLogsTable } from "@workspace/db";
import type { Executor } from "../../repositories/base.js";
import * as repo from "../../repositories/subscriptions.repository.js";
import type { PlanRow, PlanVersionRow, SubscriptionRow } from "../../repositories/subscriptions.repository.js";
import { effectiveLimitsFor } from "../../services/entitlements.service.js";
import { resolveEntitlement, LIMIT_RESOURCES } from "./lifecycle.js";
import { writeSubscriptionAudit, type AuditActor } from "./audit.js";
import { defaultTrialPolicy, snapshotFromPlanRow } from "./plan-versions.js";

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
  const ent = resolveEntitlement(sub, now);
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
export function compareSnapshots(before: EntitlementSnapshotRow[], after: EntitlementSnapshotRow[]): SnapshotMismatch[] {
  const out: SnapshotMismatch[] = [];
  const byCompany = new Map(after.map((r) => [r.companyId, r]));
  for (const b of before) {
    const a = byCompany.get(b.companyId);
    if (!a) {
      out.push({ companyId: b.companyId, field: "row", before: "present", after: "missing" });
      continue;
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
export interface BackfillReport {
  mode: "dry-run" | "apply";
  startedAt: string;
  finishedAt: string;
  plans: BackfillPlanEntry[];
  subscriptions: {
    total: number;
    alreadyPinned: number;
    pinned: BackfillPinEntry[];
    unpinnable: BackfillUnpinnable[];
  };
  verification: { compared: number; mismatches: SnapshotMismatch[] };
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
    plans: [],
    subscriptions: { total: 0, alreadyPinned: 0, pinned: [], unpinnable: [] },
    verification: { compared: 0, mismatches: [] },
    applied: false,
    rolledBack: false,
    reason: null,
  });
  try {
    return await db.transaction(async (tx) => {
      const report = base();
      // 1. BEFORE — every subscription's entitlement as it is today.
      const before = await entitlementSnapshot(now, tx);
      report.subscriptions.total = before.length;
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
      // 4. AFTER — identical entitlement required for every subscription.
      const after = await entitlementSnapshot(now, tx);
      report.verification.compared = before.length;
      report.verification.mismatches = compareSnapshots(before, after);
      report.finishedAt = new Date().toISOString();
      if (report.verification.mismatches.length > 0) {
        report.rolledBack = true;
        report.reason = `verification found ${report.verification.mismatches.length} difference(s); nothing was changed`;
        throw new RollbackSignal(report);
      }
      if (!opts.apply) {
        report.rolledBack = true;
        report.reason = "dry run: the transaction was rolled back on purpose";
        throw new RollbackSignal(report);
      }
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
