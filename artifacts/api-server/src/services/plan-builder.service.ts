import { db, auditLogsTable } from "@workspace/db";
import { config } from "../config.js";
import { AppError } from "../middlewares/errorHandler.js";
import { logger } from "../lib/logger.js";
import type { Executor } from "../repositories/base.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { PlanRow, PlanVersionRow, PlanPriceRow, SubscriptionRow } from "../repositories/subscriptions.repository.js";
import type { AuditActor } from "../lib/billing/audit.js";
import { DEFAULT_TRIAL_DAYS } from "../lib/billing/plan-catalog.js";
import { LIMIT_RESOURCES, SUBSCRIPTION_STATUSES, normalizeLegacyStatus, resolveEffectiveLimits } from "../lib/billing/lifecycle.js";
import { usageReport } from "./entitlements.service.js";
import {
  MAX_NAME,
  compareVersions,
  defaultTrialPolicy,
  emptyFeatureMatrix,
  isFixedPlanId,
  isPlanSlug,
  limitTightens,
  limitsAsPlanDefaults,
  parseDisplayInput,
  parseFeaturesInput,
  parseLimitsInput,
  parseTrialPolicyInput,
  planRowMirrorFromSnapshot,
  priceSummary,
  snapshotFromPlanRow,
  unlimitedLimits,
  validateVersionForPublish,
  type CompareRow,
  type FieldIssue,
  type PlanTrialPolicy,
  type PlanVersionSnapshot,
  type VersionContent,
  normalizeSnapshot
} from "../lib/billing/plan-versions.js";

// Batch 40 — PB-2 plan lifecycle (platform owner only; every route is behind
// requireRole("platform_owner") and every mutation runs in ONE transaction with
// the plan row locked).
//
// Invariants enforced here (PB-1.3 / PB-2):
//   • a PUBLISHED version is immutable — PATCH / DELETE answer 409;
//   • a plan has at most one DRAFT (partial unique index + lock);
//   • publishing is atomic and concurrency safe (plan row FOR UPDATE; assignments
//     take FOR SHARE), re-validates inside the transaction and NEVER moves an
//     existing subscriber (no subscription row is written);
//   • publishing is refused while the plan still has NULL-reference (legacy,
//     pre-backfill) subscribers, so an unresolved reference can never change
//     access silently — the version-1 backfill resolves them first;
//   • retiring keeps every subscriber on the version; the last published version
//     of a plan cannot be retired; a version with subscribers is never deleted
//     (published versions are never deleted at all);
//   • the five fixed plan ids are permanent: never deleted, never archived here
//     (archiving a fixed id requires the PB-4.5 migration target — unapproved);
//   • the plan row MIRRORS the current published version (display, limits,
//     features, trial days) and is written only at publish / retire; pinned
//     subscribers read their own version snapshot (entitlements.service);
//   • every action appends an audit row (plan.* / plan_version.*).

type Actor = AuditActor;

function conflict(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, message, { code, ...(details ? { details } : {}) });
}
function notFoundPlan(): AppError {
  return new AppError(404, "Plan not found", { code: "PLAN_NOT_FOUND" });
}
function notFoundVersion(): AppError {
  return new AppError(404, "Plan version not found", { code: "VERSION_NOT_FOUND" });
}

async function writePlanAudit(tx: Executor, actor: Actor, action: string, entityType: "plan" | "plan_version", entityId: string, metadata: Record<string, unknown>): Promise<void> {
  await tx.insert(auditLogsTable).values({ companyId: null, userId: actor.userId, userName: actor.userName, action, entityType, entityId, metadata, ipAddress: actor.ipAddress });
}

function providerMode(): "test" | "live" {
  return config.billing.stripeMode ?? "test";
}

// ── Projections ──────────────────────────────────────────────────────────────

export type VersionState = "draft" | "published" | "retired";

export function versionState(v: PlanVersionRow): VersionState {
  if (!v.publishedAt) return "draft";
  return v.retiredAt ? "retired" : "published";
}

export interface PlanVersionView {
  id: number;
  planId: string;
  version: number;
  state: VersionState;
  isCurrent: boolean;
  snapshot: PlanVersionSnapshot;
  trialPolicy: PlanTrialPolicy;
  subscribers: number;
  publishedAt: string | null;
  publishedBy: number | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function versionView(v: PlanVersionRow, extra: { isCurrent: boolean; subscribers: number }): PlanVersionView {
  return {
    id: v.id,
    planId: v.planId,
    version: v.version,
    state: versionState(v),
    isCurrent: extra.isCurrent,
    snapshot: normalizeSnapshot(v.snapshot),
    trialPolicy: v.trialPolicy,
    subscribers: extra.subscribers,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    publishedBy: v.publishedBy ?? null,
    retiredAt: v.retiredAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export interface VersionSummary {
  id: number;
  version: number;
  state: VersionState;
  publishedAt: string | null;
  retiredAt: string | null;
  subscribers: number;
}
export function versionSummary(v: PlanVersionRow, subscribers: number): VersionSummary {
  return { id: v.id, version: v.version, state: versionState(v), publishedAt: v.publishedAt?.toISOString() ?? null, retiredAt: v.retiredAt?.toISOString() ?? null, subscribers };
}

// ── Lookups ──────────────────────────────────────────────────────────────────

async function requirePlan(planId: string, tx?: Executor, lock = false): Promise<PlanRow> {
  if (!isPlanSlug(planId)) throw notFoundPlan();
  const plan = lock && tx ? await repo.lockPlan(planId, tx) : await repo.findPlanById(planId, tx);
  if (!plan) throw notFoundPlan();
  return plan;
}
async function requireVersionOf(plan: PlanRow, versionId: number, tx?: Executor, lock = false): Promise<PlanVersionRow> {
  const v = lock && tx ? await repo.lockPlanVersion(versionId, tx) : await repo.findPlanVersionById(versionId, tx);
  if (!v || v.planId !== plan.id) throw notFoundVersion();
  return v;
}
async function subscribersByVersion(planId: string, tx?: Executor): Promise<Map<number | null, number>> {
  const rows = await repo.countSubscriptionsByVersion(planId, tx);
  return new Map(rows.map((r) => [r.planVersionId, r.count]));
}

// ── Input ────────────────────────────────────────────────────────────────────

export interface VersionInput {
  name?: unknown;
  description?: unknown;
  sortOrder?: unknown;
  limits?: unknown;
  features?: unknown;
  trialPolicy?: unknown;
}

function applyInput(base: VersionContent, input: VersionInput): VersionContent & { changed: string[] } {
  const display = parseDisplayInput(input as Record<string, unknown>, { name: base.snapshot.name, description: base.snapshot.description, sortOrder: base.snapshot.sortOrder });
  const limits = parseLimitsInput(input.limits, base.snapshot.limits);
  const features = parseFeaturesInput(input.features, base.snapshot.features);
  const trial = parseTrialPolicyInput(input.trialPolicy, base.trialPolicy);
  const issues: FieldIssue[] = [...display.issues, ...limits.issues, ...features.issues, ...trial.issues];
  if (issues.length > 0) throw new AppError(400, "Invalid plan version input", { code: "VERSION_INPUT_INVALID", details: { issues } });
  const snapshot: PlanVersionSnapshot = { ...base.snapshot, name: display.value.name, description: display.value.description, sortOrder: display.value.sortOrder, limits: limits.value, features: features.value };
  const next = { snapshot, trialPolicy: trial.value };
  const changed = compareVersions(base, next)
    .filter((r) => r.changed)
    .map((r) => `${r.group}.${r.field}`);
  return { ...next, changed };
}

function contentOf(v: PlanVersionRow): VersionContent {
  return { snapshot: normalizeSnapshot(v.snapshot), trialPolicy: v.trialPolicy };
}

async function legacyContent(plan: PlanRow, tx?: Executor): Promise<VersionContent> {
  const prices = (await repo.listPlanPricesForVersion(plan.id, null, tx)).filter((p) => p.active);
  return { snapshot: snapshotFromPlanRow(plan, prices), trialPolicy: defaultTrialPolicy(plan.trialDays) };
}

// ── PB-2.1 Create a draft plan ───────────────────────────────────────────────

export async function createPlan(actor: Actor, input: { id?: unknown } & VersionInput): Promise<{ plan: PlanRow; draft: PlanVersionView }> {
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  if (!isPlanSlug(id)) throw new AppError(400, "id must be a lowercase slug of 2–40 characters (a-z, 0-9, '-') starting with a letter", { code: "INVALID_PLAN_ID" });
  if (isFixedPlanId(id)) throw conflict("PLAN_ID_RESERVED", "This id belongs to the fixed plan catalog");
  if (input.name === undefined) throw new AppError(400, "name is required", { code: "NAME_INVALID" });
  const base: VersionContent = {
    snapshot: { name: "", description: null, sortOrder: 100, limits: unlimitedLimits(), features: emptyFeatureMatrix(), prices: [] },
    trialPolicy: defaultTrialPolicy(DEFAULT_TRIAL_DAYS),
  };
  const content = applyInput(base, input);
  return db.transaction(async (tx) => {
    const plan = await repo.insertPlan({ id, ...planRowMirrorFromSnapshot(content.snapshot, content.trialPolicy), isActive: false, status: "draft" }, tx);
    if (!plan) throw conflict("PLAN_EXISTS", "A plan with this id already exists");
    const draft = await repo.insertPlanVersion({ planId: id, version: 1, snapshot: content.snapshot, trialPolicy: content.trialPolicy }, tx);
    await writePlanAudit(tx, actor, "plan.create", "plan", id, { planId: id, draftVersionId: draft.id, version: 1, name: content.snapshot.name, limits: content.snapshot.limits, trialDays: content.trialPolicy.trialDays });
    logger.info({ planId: id, draftVersionId: draft.id, actorUserId: actor.userId }, "Plan created (draft)");
    return { plan, draft: versionView(draft, { isCurrent: false, subscribers: 0 }) };
  });
}

// ── PB-2.3 Duplicate a plan into a new draft plan ────────────────────────────

export async function duplicatePlan(actor: Actor, sourcePlanId: string, input: { id?: unknown; name?: unknown }): Promise<{ plan: PlanRow; draft: PlanVersionView }> {
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  if (!isPlanSlug(id)) throw new AppError(400, "id must be a lowercase slug of 2–40 characters (a-z, 0-9, '-') starting with a letter", { code: "INVALID_PLAN_ID" });
  if (isFixedPlanId(id)) throw conflict("PLAN_ID_RESERVED", "This id belongs to the fixed plan catalog");
  return db.transaction(async (tx) => {
    const source = await requirePlan(sourcePlanId, tx);
    const sourceVersion = (await repo.findCurrentPublishedVersion(source.id, tx)) ?? (await repo.findDraftVersion(source.id, tx));
    const base = sourceVersion ? contentOf(sourceVersion) : await legacyContent(source, tx);
    const fallbackName = `${base.snapshot.name} (copy)`.slice(0, MAX_NAME);
    const content = applyInput({ snapshot: { ...base.snapshot, name: fallbackName, prices: [] }, trialPolicy: base.trialPolicy }, input.name !== undefined ? { name: input.name } : {});
    const plan = await repo.insertPlan({ id, ...planRowMirrorFromSnapshot(content.snapshot, content.trialPolicy), isActive: false, status: "draft" }, tx);
    if (!plan) throw conflict("PLAN_EXISTS", "A plan with this id already exists");
    const draft = await repo.insertPlanVersion({ planId: id, version: 1, snapshot: content.snapshot, trialPolicy: content.trialPolicy }, tx);
    await writePlanAudit(tx, actor, "plan.duplicate", "plan", id, {
      planId: id,
      draftVersionId: draft.id,
      sourcePlanId: source.id,
      sourceVersionId: sourceVersion?.id ?? null,
      sourceVersion: sourceVersion?.version ?? null,
      source: sourceVersion ? versionState(sourceVersion) : "plan_row",
      // Provider prices are NOT copied: a provider price id maps to exactly one plan.
      pricesCopied: 0,
    });
    return { plan, draft: versionView(draft, { isCurrent: false, subscribers: 0 }) };
  });
}

// ── PB-2.2 New draft from the current (or a chosen) published version ────────

export async function createDraft(actor: Actor, planId: string, input: { sourceVersionId?: unknown } = {}): Promise<PlanVersionView> {
  return db.transaction(async (tx) => {
    const plan = await requirePlan(planId, tx, true);
    if (plan.status === "archived") throw conflict("PLAN_ARCHIVED", "An archived plan cannot receive a new draft");
    const existing = await repo.findDraftVersion(plan.id, tx);
    if (existing) throw conflict("DRAFT_EXISTS", "This plan already has a draft; edit or delete it first", { draftVersionId: existing.id, version: existing.version });
    let source: PlanVersionRow | undefined;
    if (input.sourceVersionId !== undefined) {
      if (typeof input.sourceVersionId !== "number" || !Number.isInteger(input.sourceVersionId) || input.sourceVersionId <= 0) throw new AppError(400, "sourceVersionId must be a positive integer", { code: "INVALID_VERSION_ID" });
      source = await requireVersionOf(plan, input.sourceVersionId, tx);
      if (!source.publishedAt) throw conflict("VERSION_NOT_PUBLISHED", "Only a published version can seed a new draft");
    } else {
      source = await repo.findCurrentPublishedVersion(plan.id, tx);
    }
    const base = source ? contentOf(source) : await legacyContent(plan, tx);
    const version = (await repo.maxVersionNumber(plan.id, tx)) + 1;
    const draft = await repo.insertPlanVersion({ planId: plan.id, version, snapshot: { ...base.snapshot, prices: [] }, trialPolicy: base.trialPolicy }, tx);
    await writePlanAudit(tx, actor, "plan_version.create", "plan_version", String(draft.id), { planId: plan.id, versionId: draft.id, version, sourceVersionId: source?.id ?? null, sourceVersion: source?.version ?? null, source: source ? "version" : "plan_row" });
    return versionView(draft, { isCurrent: false, subscribers: 0 });
  });
}

// ── PB-2.2 Edit a draft (published versions are immutable) ───────────────────

export async function updateDraft(actor: Actor, planId: string, versionId: number, input: VersionInput): Promise<PlanVersionView> {
  return db.transaction(async (tx) => {
    const plan = await requirePlan(planId, tx, true);
    if (plan.status === "archived") throw conflict("PLAN_ARCHIVED", "An archived plan cannot be edited");
    const v = await requireVersionOf(plan, versionId, tx, true);
    if (v.publishedAt) throw conflict("VERSION_IMMUTABLE", "A published version is immutable; create a new draft to change the plan", { versionId: v.id, version: v.version });
    const content = applyInput(contentOf(v), input);
    if (content.changed.length === 0) return versionView(v, { isCurrent: false, subscribers: 0 });
    const updated = await repo.updatePlanVersion(v.id, { snapshot: content.snapshot, trialPolicy: content.trialPolicy }, tx);
    // A DRAFT plan's row mirrors its draft (nothing reads it for entitlement: the
    // plan is unassignable). A published plan's row keeps mirroring the current
    // published version — never the draft.
    if (plan.status === "draft") await repo.updatePlan(plan.id, planRowMirrorFromSnapshot(content.snapshot, content.trialPolicy), tx);
    await writePlanAudit(tx, actor, "plan_version.update", "plan_version", String(v.id), { planId: plan.id, versionId: v.id, version: v.version, changed: content.changed });
    return versionView(updated!, { isCurrent: false, subscribers: 0 });
  });
}

// ── PB-2.4 Validation (read-only) ────────────────────────────────────────────

export interface PublishBlocker {
  code: "VERSION_IMMUTABLE" | "VERSION_RETIRED" | "PLAN_ARCHIVED" | "UNPINNED_SUBSCRIBERS";
  message: string;
  count?: number;
}

async function publishBlockers(plan: PlanRow, v: PlanVersionRow, tx?: Executor): Promise<PublishBlocker[]> {
  const out: PublishBlocker[] = [];
  if (v.publishedAt) out.push({ code: "VERSION_IMMUTABLE", message: "This version is already published" });
  if (plan.status === "archived") out.push({ code: "PLAN_ARCHIVED", message: "The plan is archived" });
  const unpinned = await repo.countUnpinnedSubscriptions(plan.id, tx);
  if (unpinned > 0) out.push({ code: "UNPINNED_SUBSCRIBERS", message: "Subscribers still reference the plan row (legacy); run the version-1 backfill first so no reference can change silently", count: unpinned });
  return out;
}

export async function validateVersion(planId: string, versionId: number) {
  const plan = await requirePlan(planId);
  const v = await requireVersionOf(plan, versionId);
  const prices = await repo.listPlanPricesForVersion(plan.id, v.id);
  const validation = validateVersionForPublish(v.snapshot, v.trialPolicy, { configuredProviderMode: providerMode(), prices });
  const blockers = await publishBlockers(plan, v);
  return {
    planId: plan.id,
    versionId: v.id,
    version: v.version,
    state: versionState(v),
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    blockers,
    publishable: validation.ok && blockers.length === 0,
    pricesConsidered: prices.filter((p) => p.active).map(priceSummary),
    providerMode: providerMode(),
  };
}

// ── PB-2.4 Publish (atomic, concurrency safe, never moves subscribers) ───────

export async function publishVersion(actor: Actor, planId: string, versionId: number): Promise<PlanVersionView> {
  return db.transaction(async (tx) => {
    const plan = await requirePlan(planId, tx, true); // FOR UPDATE: serializes with other publishes and with every assignment (FOR SHARE)
    if (plan.status === "archived") throw conflict("PLAN_ARCHIVED", "An archived plan cannot publish a version");
    const v = await requireVersionOf(plan, versionId, tx, true);
    if (v.publishedAt) throw conflict("VERSION_IMMUTABLE", "This version is already published", { versionId: v.id, version: v.version });
    const unpinned = await repo.countUnpinnedSubscriptions(plan.id, tx);
    if (unpinned > 0) throw conflict("UNPINNED_SUBSCRIBERS", "Subscribers still reference the plan row (legacy); run the version-1 backfill first", { count: unpinned });
    const prices = await repo.listPlanPricesForVersion(plan.id, v.id, tx);
    const validation = validateVersionForPublish(v.snapshot, v.trialPolicy, { configuredProviderMode: providerMode(), prices });
    if (!validation.ok) throw conflict("VERSION_INVALID", "The draft does not pass publication validation", { errors: validation.errors, warnings: validation.warnings });
    const previous = await repo.findCurrentPublishedVersion(plan.id, tx);
    const subscribersOnPlan = await repo.countSubscriptionsOnPlan(plan.id, tx);
    const now = new Date();
    const snapshot: PlanVersionSnapshot = { ...v.snapshot, prices: prices.filter((p) => p.active).map(priceSummary) };
    const published = await repo.updatePlanVersion(v.id, { snapshot, publishedAt: now, publishedBy: actor.userId }, tx);
    await repo.updatePlan(plan.id, { ...planRowMirrorFromSnapshot(snapshot, v.trialPolicy), status: "published", isActive: true }, tx);
    // No subscription row is written: existing subscribers stay on their version.
    await writePlanAudit(tx, actor, "plan.publish", "plan_version", String(v.id), {
      planId: plan.id,
      versionId: v.id,
      version: v.version,
      previousVersionId: previous?.id ?? null,
      previousVersion: previous?.version ?? null,
      subscribersOnPlan,
      subscribersMoved: 0,
      warnings: validation.warnings.map((w) => w.code),
      limits: snapshot.limits,
      trialDays: v.trialPolicy.trialDays,
      activePrices: snapshot.prices.length,
    });
    logger.info({ planId: plan.id, versionId: v.id, version: v.version, previousVersionId: previous?.id ?? null, actorUserId: actor.userId }, "Plan version published");
    return versionView(published!, { isCurrent: true, subscribers: 0 });
  });
}

// ── PB-2.5 Retire a published version (subscribers keep it) ──────────────────

export async function retireVersion(actor: Actor, planId: string, versionId: number): Promise<PlanVersionView> {
  return db.transaction(async (tx) => {
    const plan = await requirePlan(planId, tx, true);
    const v = await requireVersionOf(plan, versionId, tx, true);
    if (!v.publishedAt) throw conflict("VERSION_NOT_PUBLISHED", "Only a published version can be retired; delete a draft instead");
    if (v.retiredAt) throw conflict("VERSION_RETIRED", "This version is already retired");
    if ((await repo.countPublishedNonRetiredVersions(plan.id, tx)) <= 1) throw conflict("LAST_PUBLISHED_VERSION", "The last published version of a plan cannot be retired; publish a replacement first (or archive the plan)");
    const subscribersKept = await repo.countSubscriptionsOnVersion(v.id, tx);
    const retired = await repo.updatePlanVersion(v.id, { retiredAt: new Date() }, tx);
    const newCurrent = await repo.findCurrentPublishedVersion(plan.id, tx);
    if (plan.status === "published" && newCurrent) await repo.updatePlan(plan.id, planRowMirrorFromSnapshot(newCurrent.snapshot, newCurrent.trialPolicy), tx);
    await writePlanAudit(tx, actor, "plan_version.retire", "plan_version", String(v.id), { planId: plan.id, versionId: v.id, version: v.version, subscribersKept, newCurrentVersionId: newCurrent?.id ?? null, newCurrentVersion: newCurrent?.version ?? null });
    logger.info({ planId: plan.id, versionId: v.id, version: v.version, subscribersKept, actorUserId: actor.userId }, "Plan version retired");
    return versionView(retired!, { isCurrent: false, subscribers: subscribersKept });
  });
}

// ── Delete a draft (published versions are never deleted) ────────────────────

export async function deleteDraft(actor: Actor, planId: string, versionId: number): Promise<{ deleted: true; versionId: number; planDeleted: boolean }> {
  return db.transaction(async (tx) => {
    const plan = await requirePlan(planId, tx, true);
    const v = await requireVersionOf(plan, versionId, tx, true);
    if (v.publishedAt) throw conflict("VERSION_PUBLISHED", "A published version is never deleted (retire it instead)", { versionId: v.id, version: v.version });
    const subscribers = await repo.countSubscriptionsOnVersion(v.id, tx);
    if (subscribers > 0) throw conflict("VERSION_HAS_SUBSCRIBERS", "A version with subscribers cannot be deleted", { count: subscribers });
    await repo.deletePlanVersion(v.id, tx);
    let planDeleted = false;
    if (plan.status === "draft" && (await repo.listPlanVersions(plan.id, tx)).length === 0) {
      // A never-published plan without any version has no reason to exist — unless a
      // provider price was registered on it (prices are never deleted).
      const prices = await repo.listPlanPrices({ planId: plan.id }, tx);
      if (prices.length > 0) throw conflict("PLAN_HAS_PRICES", "The draft plan carries registered provider prices and cannot be removed; keep a draft on it instead", { count: prices.length });
      if ((await repo.countSubscriptionsOnPlan(plan.id, tx)) > 0) throw conflict("PLAN_HAS_SUBSCRIBERS", "The plan has subscribers");
      await repo.deletePlan(plan.id, tx);
      planDeleted = true;
      await writePlanAudit(tx, actor, "plan.delete", "plan", plan.id, { planId: plan.id, reason: "draft plan without versions" });
    }
    await writePlanAudit(tx, actor, "plan_version.delete", "plan_version", String(v.id), { planId: plan.id, versionId: v.id, version: v.version, planDeleted });
    return { deleted: true as const, versionId: v.id, planDeleted };
  });
}

// ── PB-2.5 Archive a plan (non-fixed, no subscribers) ────────────────────────

export async function archivePlan(actor: Actor, planId: string): Promise<PlanRow> {
  return db.transaction(async (tx) => {
    const plan = await requirePlan(planId, tx, true);
    if (plan.status === "archived") throw conflict("PLAN_ARCHIVED", "This plan is already archived");
    if (isFixedPlanId(plan.id)) throw conflict("ARCHIVE_REQUIRES_MIGRATION_TARGET", "A fixed catalog plan can only be archived with an approved tenant migration target (PB-4.5), and is never deleted");
    if (plan.status === "draft") throw conflict("PLAN_NOT_PUBLISHED", "A draft plan is removed by deleting its draft, not archived");
    const subscribers = await repo.countSubscriptionsOnPlan(plan.id, tx);
    if (subscribers > 0) throw conflict("PLAN_HAS_SUBSCRIBERS", "A plan with subscribers cannot be archived", { count: subscribers });
    const draft = await repo.findDraftVersion(plan.id, tx);
    if (draft) throw conflict("DRAFT_EXISTS", "Delete the plan's draft before archiving it", { draftVersionId: draft.id });
    const updated = await repo.updatePlan(plan.id, { status: "archived", isActive: false }, tx);
    await writePlanAudit(tx, actor, "plan.archive", "plan", plan.id, { planId: plan.id, publishedVersions: (await repo.listPlanVersions(plan.id, tx)).filter((x) => x.publishedAt).length });
    return updated!;
  });
}

// ── Reads: history, detail, comparison, impact ───────────────────────────────

export async function listVersions(planId: string) {
  const plan = await requirePlan(planId);
  const [versions, current, counts] = await Promise.all([repo.listPlanVersions(plan.id), repo.findCurrentPublishedVersion(plan.id), subscribersByVersion(plan.id)]);
  const draft = versions.find((v) => !v.publishedAt) ?? null;
  return {
    planId: plan.id,
    planStatus: plan.status,
    currentVersionId: current?.id ?? null,
    draftVersionId: draft?.id ?? null,
    unpinnedSubscribers: counts.get(null) ?? 0,
    versions: versions.map((v) => versionView(v, { isCurrent: current?.id === v.id, subscribers: counts.get(v.id) ?? 0 })),
  };
}

export async function getVersion(planId: string, versionId: number) {
  const plan = await requirePlan(planId);
  const v = await requireVersionOf(plan, versionId);
  const [current, subscribers, prices] = await Promise.all([repo.findCurrentPublishedVersion(plan.id), repo.countSubscriptionsOnVersion(v.id), repo.listPlanPricesForVersion(plan.id, v.id)]);
  const view = versionView(v, { isCurrent: current?.id === v.id, subscribers });
  const validation = v.publishedAt ? null : await validateVersion(plan.id, v.id);
  return { ...view, prices: prices.map(priceSummary), validation };
}

export async function compare(planId: string, versionId: number, otherVersionId: number) {
  const plan = await requirePlan(planId);
  const [left, right] = await Promise.all([requireVersionOf(plan, versionId), requireVersionOf(plan, otherVersionId)]);
  const counts = await subscribersByVersion(plan.id);
  const rows: CompareRow[] = compareVersions(contentOf(left), contentOf(right));
  const tightenedLimits = LIMIT_RESOURCES.filter((r) => limitTightens(left.snapshot.limits[r], right.snapshot.limits[r]));
  const loosenedLimits = LIMIT_RESOURCES.filter((r) => limitTightens(right.snapshot.limits[r], left.snapshot.limits[r]));
  return {
    planId: plan.id,
    left: versionSummary(left, counts.get(left.id) ?? 0),
    right: versionSummary(right, counts.get(right.id) ?? 0),
    rows,
    changedFields: rows.filter((r) => r.changed).map((r) => `${r.group}.${r.field}`),
    tightenedLimits,
    loosenedLimits,
  };
}

const IMPACT_SAMPLE = 50;

export interface ExceedingTenant {
  companyId: number;
  companyName: string | null;
  status: string;
  resources: Array<{ resource: string; limit: number; used: number }>;
}

async function tenantsExceeding(plan: PlanRow, snapshot: PlanVersionSnapshot, now: Date): Promise<{ checked: number; sampled: boolean; tenants: ExceedingTenant[] }> {
  const subs = await repo.listSubscriptionsOnPlan(plan.id, IMPACT_SAMPLE + 1);
  const sampled = subs.length > IMPACT_SAMPLE;
  const checked = subs.slice(0, IMPACT_SAMPLE);
  const tenants: ExceedingTenant[] = [];
  for (const sub of checked) {
    const limits = resolveEffectiveLimits(limitsAsPlanDefaults(snapshot.limits), sub.limitOverrides);
    const usage = await usageReport(sub.companyId, sub, now);
    const resources: ExceedingTenant["resources"] = [];
    for (const l of limits) {
      const u = usage.resources.find((r) => r.resource === l.resource);
      if (l.limit != null && u?.measurable && u.used > l.limit) resources.push({ resource: l.resource, limit: l.limit, used: u.used });
    }
    if (resources.length > 0) {
      const company = await repo.findCompany(sub.companyId);
      tenants.push({ companyId: sub.companyId, companyName: company?.name ?? null, status: normalizeLegacyStatus(sub.status) ?? sub.status, resources });
    }
  }
  return { checked: checked.length, sampled, tenants };
}

function statusCounts(subs: SubscriptionRow[]): Record<string, number> {
  const out = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const s of subs) {
    const st = normalizeLegacyStatus(s.status) ?? s.status;
    if (st in out) out[st] += 1;
  }
  return out;
}

export async function impact(planId: string, versionId: number, now = new Date()) {
  const plan = await requirePlan(planId);
  const v = await requireVersionOf(plan, versionId);
  const [current, counts, versions, planTotal] = await Promise.all([repo.findCurrentPublishedVersion(plan.id), subscribersByVersion(plan.id), repo.listPlanVersions(plan.id), repo.countSubscriptionsOnPlan(plan.id)]);
  const onVersion = counts.get(v.id) ?? 0;
  const unpinned = counts.get(null) ?? 0;
  const byVersion = versions.map((x) => ({ versionId: x.id, version: x.version, state: versionState(x), subscribers: counts.get(x.id) ?? 0 }));
  const state = versionState(v);
  const base = {
    planId: plan.id,
    planStatus: plan.status,
    versionId: v.id,
    version: v.version,
    state,
    planSubscribers: planTotal,
    unpinnedSubscribers: unpinned,
    subscribersOnVersion: onVersion,
    subscribersByVersion: byVersion,
    currentVersion: current ? versionSummary(current, counts.get(current.id) ?? 0) : null,
    generatedAt: now.toISOString(),
  };
  if (state === "draft") {
    const diff = current ? compareVersions(contentOf(current), contentOf(v)) : compareVersions(await legacyContent(plan), contentOf(v));
    const exceeding = await tenantsExceeding(plan, v.snapshot, now);
    const subsOnVersionRows = await repo.listSubscriptionsOnVersion(v.id, 1);
    void subsOnVersionRows;
    return {
      ...base,
      publish: {
        subscribersMoved: 0,
        wouldBecomeCurrent: true,
        newTenantsGetThisVersion: true,
        diffVsCurrent: diff.filter((r) => r.changed),
        tightenedLimits: LIMIT_RESOURCES.filter((r) => limitTightens(current ? current.snapshot.limits[r] : plan[`${r === "storageMb" ? "storageLimitMb" : `${r}Limit`}` as keyof PlanRow] as number | null, v.snapshot.limits[r])),
        tenantsExceedingNewLimits: exceeding,
        blockers: await publishBlockers(plan, v),
      },
      retire: null,
    };
  }
  const subsOnVersion = await repo.listSubscriptionsOnVersion(v.id, 1000);
  const publishedNonRetired = versions.filter((x) => x.publishedAt && !x.retiredAt);
  const nextCurrent = publishedNonRetired.filter((x) => x.id !== v.id).sort((a, b) => b.version - a.version)[0] ?? null;
  return {
    ...base,
    publish: null,
    retire: {
      subscribersKept: onVersion,
      subscribersByStatus: statusCounts(subsOnVersion),
      isCurrent: current?.id === v.id,
      isLastPublished: publishedNonRetired.length <= 1,
      alreadyRetired: state === "retired",
      newCurrentVersion: nextCurrent ? versionSummary(nextCurrent, counts.get(nextCurrent.id) ?? 0) : null,
    },
  };
}

export type { PlanPriceRow };
