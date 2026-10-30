import { randomUUID } from "node:crypto";
import { db, auditLogsTable } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import { logger } from "../lib/logger.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { PlanRow, PlanVersionRow, SubscriptionRow } from "../repositories/subscriptions.repository.js";
import { sanitizeReason, type AuditActor } from "../lib/billing/audit.js";
import { isPlanSlug } from "../lib/billing/plan-versions.js";
import { digestOf, evaluatePlanChange, type ChangeTarget, type PlanChangeEvaluation } from "./plan-change.service.js";
import { applyPlanChange } from "./subscription-lifecycle.service.js";

// Batch 42 (PB-4.5) — safe tenant migration between PUBLISHED versions for
// platform-managed (manual-billing) tenants.
//
//   • scope = every subscription on a SOURCE published version and/or an
//     explicit list of company ids (≤ MAX_SCOPE); never "everyone";
//   • target = a published, NON-retired version of the addressed plan (a tenant
//     may change plan when the source belongs to another plan — the archive
//     path); the owner's per-tenant set-plan stays the tool for a retired target;
//   • dry run = the SAME per-tenant evaluation the execution uses (U6 blockers,
//     D3 feature confirmation, provider exclusion D4, transition table) — no
//     write — and a DIGEST over the reviewed rows;
//   • execution requires the digest of a dry run computed on the SAME current
//     data: the server recomputes the dry run first and refuses (409
//     DRY_RUN_STALE) on any difference, which also makes a duplicate execution
//     impossible (the migrated rows change the digest);
//   • each tenant is migrated in its OWN transaction (row lock, recheck against
//     the dry-run row, commit, post-change verification → rollback on mismatch)
//     with one audit row per tenant carrying the migration id and the digest;
//     an audit summary row records the counts; outcomes are reported per tenant
//     as migrated / skipped / failed / rolled_back — never a silent partial
//     success (`complete` is true only when nothing failed or rolled back).

export const MAX_SCOPE = 200;

export type MigrationReason =
  | "ELIGIBLE"
  | "ALREADY_ON_VERSION"
  | "PROVIDER_MANAGED"
  | "TRANSITION_NOT_ALLOWED"
  | "NOT_ON_SOURCE_VERSION"
  | "DOWNGRADE_BLOCKED"
  | "FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED"
  | "SUBSCRIPTION_MISSING";

export type MigrationOutcome = "migrated" | "skipped" | "failed" | "rolled_back" | "not_attempted";

export interface MigrationRow {
  companyId: number;
  companyName: string | null;
  currentPlan: string | null;
  currentPlanVersionId: number | null;
  currentVersion: number | null;
  currentReferenceValid: boolean;
  billingSource: string | null;
  status: string | null;
  reason: MigrationReason;
  blocking: Array<{ resource: string; used: number; limit: number }>;
  unmeasurable: string[];
  lostFeatures: string[];
  tightenedLimits: string[];
  outcome: MigrationOutcome;
  outcomeReason: string | null;
}

export interface MigrateInput {
  dryRun?: unknown;
  companyIds?: unknown;
  sourceVersionId?: unknown;
  confirmDigest?: unknown;
  confirmFeatureDowngrade?: unknown;
  reason?: unknown;
}

function conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, message, { code, ...(details ? { details } : {}) });
}
function bad(code: string, message: string): AppError {
  return new AppError(400, message, { code });
}

interface Parsed {
  dryRun: boolean;
  companyIds: number[] | null;
  sourceVersionId: number | null;
  confirmDigest: string | null;
  confirmFeatureDowngrade: boolean;
  reason: string | null;
}

function parseInput(input: MigrateInput): Parsed {
  if (typeof input.dryRun !== "boolean") throw bad("INVALID_DRY_RUN", "dryRun must be true or false");
  let companyIds: number[] | null = null;
  if (input.companyIds !== undefined && input.companyIds !== null) {
    if (!Array.isArray(input.companyIds) || input.companyIds.some((x) => typeof x !== "number" || !Number.isInteger(x) || x <= 0)) throw bad("INVALID_COMPANY_IDS", "companyIds must be an array of positive integers");
    companyIds = [...new Set(input.companyIds as number[])].sort((a, b) => a - b);
    if (companyIds.length === 0) throw bad("INVALID_COMPANY_IDS", "companyIds must not be empty");
    if (companyIds.length > MAX_SCOPE) throw bad("SCOPE_TOO_LARGE", `at most ${MAX_SCOPE} companies per migration`);
  }
  let sourceVersionId: number | null = null;
  if (input.sourceVersionId !== undefined && input.sourceVersionId !== null) {
    if (typeof input.sourceVersionId !== "number" || !Number.isInteger(input.sourceVersionId) || input.sourceVersionId <= 0) throw bad("INVALID_VERSION_ID", "sourceVersionId must be a positive integer");
    sourceVersionId = input.sourceVersionId;
  }
  if (companyIds == null && sourceVersionId == null) throw bad("MIGRATION_SCOPE_REQUIRED", "a migration needs a sourceVersionId and/or an explicit companyIds list");
  if (input.confirmFeatureDowngrade !== undefined && typeof input.confirmFeatureDowngrade !== "boolean") throw bad("INVALID_CONFIRMATION", "confirmFeatureDowngrade must be a boolean");
  let confirmDigest: string | null = null;
  if (input.confirmDigest !== undefined && input.confirmDigest !== null) {
    if (typeof input.confirmDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.confirmDigest)) throw bad("INVALID_DIGEST", "confirmDigest must be the 64-hex digest of a dry run");
    confirmDigest = input.confirmDigest;
  }
  if (!input.dryRun && !confirmDigest) throw bad("DRY_RUN_DIGEST_REQUIRED", "execution requires confirmDigest = the digest of a dry run over the same scope");
  return { dryRun: input.dryRun, companyIds, sourceVersionId, confirmDigest, confirmFeatureDowngrade: input.confirmFeatureDowngrade === true, reason: sanitizeReason(input.reason) };
}

async function resolveTarget(planId: string, versionId: number): Promise<{ plan: PlanRow; version: PlanVersionRow }> {
  const plan = isPlanSlug(planId) ? await repo.findPlanById(planId) : undefined;
  if (!plan) throw new AppError(404, "Plan not found", { code: "PLAN_NOT_FOUND" });
  const version = await repo.findPlanVersionById(versionId);
  if (!version || version.planId !== plan.id) throw new AppError(404, "Plan version not found", { code: "VERSION_NOT_FOUND" });
  if (plan.status !== "published") throw conflict("PLAN_NOT_PUBLISHED", "Only a published plan can receive migrated tenants");
  if (!version.publishedAt) throw conflict("TARGET_NOT_PUBLISHED", "The migration target must be a published version; publish the draft first", { versionId: version.id, version: version.version });
  if (version.retiredAt) throw conflict("TARGET_RETIRED", "A retired version is not a migration target; use the per-tenant plan change for an explicit revert", { versionId: version.id, version: version.version });
  return { plan, version };
}

async function resolveSource(sourceVersionId: number | null, target: PlanVersionRow): Promise<PlanVersionRow | null> {
  if (sourceVersionId == null) return null;
  const source = await repo.findPlanVersionById(sourceVersionId);
  if (!source) throw new AppError(404, "Source version not found", { code: "SOURCE_VERSION_NOT_FOUND" });
  if (!source.publishedAt) throw conflict("SOURCE_NOT_PUBLISHED", "The source must be a published version (a draft has no subscribers)");
  if (source.id === target.id) throw conflict("SOURCE_EQUALS_TARGET", "Source and target are the same version");
  return source;
}

function reasonOf(sub: SubscriptionRow, e: PlanChangeEvaluation, source: PlanVersionRow | null, confirm: boolean): MigrationReason {
  if (e.changeKind === "none") return "ALREADY_ON_VERSION";
  if (sub.billingSource !== "manual") return "PROVIDER_MANAGED";
  if (!e.transition.ok) return "TRANSITION_NOT_ALLOWED";
  if (source && sub.planVersionId !== source.id) return "NOT_ON_SOURCE_VERSION";
  if (e.blocking.length > 0) return "DOWNGRADE_BLOCKED";
  if (e.requiresFeatureConfirmation && !confirm) return "FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED";
  return "ELIGIBLE";
}

async function evaluateRow(sub: SubscriptionRow, target: ChangeTarget, source: PlanVersionRow | null, confirm: boolean, now: Date, name: string | null): Promise<{ row: MigrationRow; evaluation: PlanChangeEvaluation }> {
  const evaluation = await evaluatePlanChange(sub, target, now);
  const reason = reasonOf(sub, evaluation, source, confirm);
  return {
    evaluation,
    row: {
      companyId: sub.companyId,
      companyName: name,
      currentPlan: sub.plan,
      currentPlanVersionId: sub.planVersionId ?? null,
      currentVersion: evaluation.current.version,
      currentReferenceValid: evaluation.current.valid,
      billingSource: sub.billingSource,
      status: evaluation.current.status,
      reason,
      blocking: evaluation.blocking,
      unmeasurable: evaluation.unmeasurable,
      lostFeatures: evaluation.features.lost,
      tightenedLimits: evaluation.tightenedLimits,
      outcome: "not_attempted",
      outcomeReason: null,
    },
  };
}

function missingRow(companyId: number): MigrationRow {
  return { companyId, companyName: null, currentPlan: null, currentPlanVersionId: null, currentVersion: null, currentReferenceValid: false, billingSource: null, status: null, reason: "SUBSCRIPTION_MISSING", blocking: [], unmeasurable: [], lostFeatures: [], tightenedLimits: [], outcome: "not_attempted", outcomeReason: null };
}

// What the owner reviews and what the execution must still see (stable key order).
function dryRunDigest(targetVersionId: number, sourceVersionId: number | null, confirm: boolean, rows: MigrationRow[]): string {
  return digestOf({
    targetVersionId,
    sourceVersionId,
    confirmFeatureDowngrade: confirm,
    rows: rows.map((r) => ({ companyId: r.companyId, currentPlan: r.currentPlan, currentPlanVersionId: r.currentPlanVersionId, reason: r.reason, blocking: r.blocking, lostFeatures: r.lostFeatures })),
  });
}

async function dryRun(planId: string, versionId: number, p: Parsed, now: Date) {
  const { plan, version } = await resolveTarget(planId, versionId);
  const source = await resolveSource(p.sourceVersionId, version);
  const target: ChangeTarget = { plan, version, explicit: true };
  let subs: SubscriptionRow[];
  const rows: MigrationRow[] = [];
  if (p.companyIds) {
    subs = await repo.listSubscriptionsByCompanyIds(p.companyIds);
    const found = new Set(subs.map((s) => s.companyId));
    for (const id of p.companyIds) if (!found.has(id)) rows.push(missingRow(id));
  } else {
    subs = await repo.listSubscriptionsOnVersion(source!.id, MAX_SCOPE + 1);
    if (subs.length > MAX_SCOPE) throw conflict("SCOPE_TOO_LARGE", `the source version has more than ${MAX_SCOPE} subscribers; migrate explicit company batches instead`, { max: MAX_SCOPE });
  }
  const evaluations = new Map<number, PlanChangeEvaluation>();
  for (const sub of subs) {
    const company = await repo.findCompany(sub.companyId);
    const { row, evaluation } = await evaluateRow(sub, target, source, p.confirmFeatureDowngrade, now, company?.name ?? null);
    rows.push(row);
    evaluations.set(sub.companyId, evaluation);
  }
  rows.sort((a, b) => a.companyId - b.companyId);
  const digest = dryRunDigest(version.id, source?.id ?? null, p.confirmFeatureDowngrade, rows);
  return { plan, version, source, target, rows, digest, evaluations };
}

function summarize(rows: MigrationRow[]) {
  const byReason: Record<string, number> = {};
  for (const r of rows) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const count = (o: MigrationOutcome) => rows.filter((r) => r.outcome === o).length;
  return { total: rows.length, eligible: rows.filter((r) => r.reason === "ELIGIBLE").length, byReason, migrated: count("migrated"), skipped: count("skipped"), failed: count("failed"), rolledBack: count("rolled_back"), notAttempted: count("not_attempted") };
}

export async function migrateTenants(actor: AuditActor, planId: string, versionId: number, input: MigrateInput) {
  const p = parseInput(input);
  const now = new Date();
  const dr = await dryRun(planId, versionId, p, now);
  const base = {
    planId: dr.plan.id,
    target: { versionId: dr.version.id, version: dr.version.version },
    source: dr.source ? { versionId: dr.source.id, version: dr.source.version, planId: dr.source.planId } : null,
    scope: p.companyIds ? ("companies" as const) : ("source_version" as const),
    confirmFeatureDowngrade: p.confirmFeatureDowngrade,
    digest: dr.digest,
    generatedAt: now.toISOString(),
  };
  if (p.dryRun) return { ...base, dryRun: true as const, migrationId: null, rows: dr.rows, summary: summarize(dr.rows), complete: null };

  // Execution: the owner's digest must match a dry run over the CURRENT data.
  if (p.confirmDigest !== dr.digest) {
    throw conflict("DRY_RUN_STALE", "The reviewed dry run no longer matches the current data; review the new dry run and confirm its digest", { expectedDigest: dr.digest, rows: dr.rows, summary: summarize(dr.rows) });
  }
  const eligible = dr.rows.filter((r) => r.reason === "ELIGIBLE");
  if (eligible.length === 0) throw conflict("NOTHING_TO_MIGRATE", "No tenant in the reviewed scope is eligible", { rows: dr.rows, summary: summarize(dr.rows) });
  const migrationId = randomUUID();
  const target = dr.target;
  for (const row of eligible) {
    try {
      const outcome = await db.transaction(async (tx) => {
        const locked = await repo.lockByCompanyId(row.companyId, tx);
        if (!locked) return { outcome: "skipped" as const, reason: "SUBSCRIPTION_MISSING" };
        // Recheck against the reviewed row: anything that moved since the dry run is skipped, never guessed.
        if (locked.plan !== row.currentPlan || (locked.planVersionId ?? null) !== row.currentPlanVersionId) return { outcome: "skipped" as const, reason: "CHANGED_SINCE_DRY_RUN" };
        const evaluation = await evaluatePlanChange(locked, target, now, tx);
        const reason = reasonOf(locked, evaluation, dr.source, p.confirmFeatureDowngrade);
        if (reason !== "ELIGIBLE") return { outcome: "skipped" as const, reason };
        await applyPlanChange(tx, locked, target, evaluation, "subscription.migrate_version", actor, {
          migrationId,
          dryRunDigest: dr.digest,
          sourceVersionId: dr.source?.id ?? null,
          reason: p.reason,
          confirmFeatureDowngrade: p.confirmFeatureDowngrade,
          planChangeSource: "migration",
        }, now);
        return { outcome: "migrated" as const, reason: null };
      });
      row.outcome = outcome.outcome;
      row.outcomeReason = outcome.reason;
    } catch (err) {
      const code = err instanceof AppError ? (err.code ?? "ERROR") : err instanceof Error ? err.constructor.name : "Error";
      row.outcome = code === "PLAN_CHANGE_VERIFICATION_FAILED" ? "rolled_back" : "failed";
      row.outcomeReason = code;
      logger.error({ companyId: row.companyId, migrationId, code }, "Tenant migration step failed; the tenant's transaction was rolled back");
    }
  }
  const summary = summarize(dr.rows);
  const complete = summary.failed === 0 && summary.rolledBack === 0;
  await db.insert(auditLogsTable).values({
    companyId: null,
    userId: actor.userId,
    userName: actor.userName,
    action: "plan_version.migrate",
    entityType: "plan_version",
    entityId: String(dr.version.id),
    metadata: { migrationId, planId: dr.plan.id, targetVersionId: dr.version.id, targetVersion: dr.version.version, sourceVersionId: dr.source?.id ?? null, dryRunDigest: dr.digest, scope: base.scope, reason: p.reason, confirmFeatureDowngrade: p.confirmFeatureDowngrade, summary, complete, companies: dr.rows.map((r) => ({ companyId: r.companyId, reason: r.reason, outcome: r.outcome, outcomeReason: r.outcomeReason })) },
    ipAddress: actor.ipAddress,
  });
  logger.info({ migrationId, planId: dr.plan.id, targetVersionId: dr.version.id, ...summary, complete, actorUserId: actor.userId }, "Tenant migration executed");
  return { ...base, dryRun: false as const, migrationId, rows: dr.rows, summary, complete };
}
