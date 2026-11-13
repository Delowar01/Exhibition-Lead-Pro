import { config } from "../config.js";
import { AppError } from "../middlewares/errorHandler.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { PlanRow, PlanVersionRow, SubscriptionRow } from "../repositories/subscriptions.repository.js";
import { PLAN_CATALOG, DEFAULT_TRIAL_DAYS } from "../lib/billing/plan-catalog.js";
import {
  BILLING_SOURCES,
  LIMIT_RESOURCES,
  SUBSCRIPTION_STATUSES,
  normalizeLegacyStatus,
  resolveEffectiveLimits,
  resolveEntitlement,
  type EffectiveLimit,
  type LimitResource,
  type PlanLimitDefaults,
} from "../lib/billing/lifecycle.js";
import { getBillingProvider } from "../lib/billing/provider.js";
import { FEATURE_LABEL, PLAN_FEATURE_KEYS, allowancesOf, defaultTrialPolicy, featureEnforcementOf, isPlanSlug, limitsAsPlanDefaults, resolveFeatureEntitlements, snapshotFromPlanRow, trialEndPolicyOf, type PlanVersionSnapshot } from "../lib/billing/plan-versions.js";
import { resolveSubscriptionContext, tenantEntitlementsOf } from "../lib/company-access.js";
import { trialGraceEndsAt } from "../lib/billing/lifecycle.js";
import * as aiRepo from "../repositories/ai.repository.js";
import { applyPlanAllowance } from "./ai.service.js";
import { effectiveLimitsFor, usageReport } from "./entitlements.service.js";
import { listPrices } from "./platform-billing.service.js";
import { versionState, versionSummary, type VersionSummary } from "./plan-builder.service.js";

// Batch 39 — Plan Builder foundation (PB-1, READ-ONLY views), extended in Batch 40
// with the versioning state of every plan (status, current published version,
// draft, pinned / unpinned subscribers). Mutations live in plan-builder.service.ts.
//
// Entitlement decisions are NOT re-implemented. The effective-limit preview calls
// the single resolver (`resolveEffectiveLimits` through `effectiveLimitsFor`) and the
// single usage counter (`usageReport`) the enforcement paths already use; a
// version preview feeds the version's snapshot limits to the same resolver.

const SEEDED_IDS = new Set<string>(PLAN_CATALOG.map((p) => p.id));

type StatusCounts = Record<(typeof SUBSCRIPTION_STATUSES)[number], number>;
type SourceCounts = Record<(typeof BILLING_SOURCES)[number], number>;
type ResourceCounts = Record<LimitResource, number>;

function emptyStatusCounts(): StatusCounts {
  return Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, 0])) as StatusCounts;
}
function emptySourceCounts(): SourceCounts {
  return Object.fromEntries(BILLING_SOURCES.map((s) => [s, 0])) as SourceCounts;
}
function emptyResourceCounts(): ResourceCounts {
  return Object.fromEntries(LIMIT_RESOURCES.map((r) => [r, 0])) as ResourceCounts;
}

export function planLimits(p: PlanRow) {
  return {
    contacts: p.contactsLimit,
    events: p.eventsLimit,
    admins: p.adminsLimit,
    employees: p.employeesLimit,
    scans: p.scansLimit,
    storageMb: p.storageLimitMb,
  };
}

// A numeric override is the only kind the resolver honours (a `null` override means
// "no override"); mirrored here for display so the preview never disagrees with it.
export function numericOverride(overrides: SubscriptionRow["limitOverrides"], resource: LimitResource): number | null {
  const o = overrides?.[resource];
  return typeof o === "number" && Number.isFinite(o) && o >= 0 ? Math.floor(o) : null;
}

function hasAnyOverride(overrides: SubscriptionRow["limitOverrides"]): boolean {
  return LIMIT_RESOURCES.some((r) => numericOverride(overrides, r) != null);
}

export function trialPolicy() {
  return {
    defaultTrialDays: DEFAULT_TRIAL_DAYS,
    configuredTrialDays: config.billing.trialDays,
    endOfTrialOutcome: "blocked" as const,
    readOnlyGraceDays: 0,
    manualTrialExpirySweep: true,
    rule: "Default (U5): a trialing subscription whose trial_expires_at has passed resolves to blocked (TRIAL_ENDED). A published plan version configured with endOutcome read_only and a 1–90 day grace resolves to read-only (TRIAL_ENDED_GRACE) until the grace ends, then blocked. Manual trials are expired by the system sweep only after any grace, with audit evidence.",
  };
}

interface Aggregates {
  prices: Awaited<ReturnType<typeof listPrices>>;
  byStatus: Map<string, StatusCounts>;
  bySource: Map<string, SourceCounts>;
  overrides: Map<string, { tenants: number; byResource: ResourceCounts }>;
  versions: Map<string, PlanVersionRow[]>;
  byVersion: Map<string, Map<number | null, number>>;
}

async function loadAggregates(): Promise<Aggregates> {
  const [prices, statusRows, sourceRows, overrideRows, versionRows, versionCounts] = await Promise.all([
    listPrices(),
    repo.countSubscriptionsByPlanAndStatus(),
    repo.countSubscriptionsByPlanAndSource(),
    repo.listSubscriptionLimitOverrides(),
    repo.listAllPlanVersions(),
    repo.countSubscriptionsByPlanAndVersion(),
  ]);
  const versions = new Map<string, PlanVersionRow[]>();
  for (const v of versionRows) versions.set(v.planId, [...(versions.get(v.planId) ?? []), v]);
  const byVersion = new Map<string, Map<number | null, number>>();
  for (const r of versionCounts) {
    const m = byVersion.get(r.plan) ?? new Map<number | null, number>();
    m.set(r.planVersionId, r.count);
    byVersion.set(r.plan, m);
  }
  const byStatus = new Map<string, StatusCounts>();
  for (const r of statusRows) {
    const counts = byStatus.get(r.plan) ?? emptyStatusCounts();
    const status = normalizeLegacyStatus(r.status) ?? r.status;
    if (status in counts) counts[status as keyof StatusCounts] += r.count;
    byStatus.set(r.plan, counts);
  }
  const bySource = new Map<string, SourceCounts>();
  for (const r of sourceRows) {
    const counts = bySource.get(r.plan) ?? emptySourceCounts();
    if (r.billingSource in counts) counts[r.billingSource as keyof SourceCounts] += r.count;
    bySource.set(r.plan, counts);
  }
  const overrides = new Map<string, { tenants: number; byResource: ResourceCounts }>();
  for (const r of overrideRows) {
    if (!hasAnyOverride(r.limitOverrides)) continue;
    const entry = overrides.get(r.plan) ?? { tenants: 0, byResource: emptyResourceCounts() };
    entry.tenants += 1;
    for (const resource of LIMIT_RESOURCES) if (numericOverride(r.limitOverrides, resource) != null) entry.byResource[resource] += 1;
    overrides.set(r.plan, entry);
  }
  return { prices, byStatus, bySource, overrides, versions, byVersion };
}

export interface PlanVersioningSummary {
  status: PlanRow["status"];
  versioning: "not_versioned" | "versioned";
  currentVersion: VersionSummary | null;
  draft: VersionSummary | null;
  versionCount: number;
  publishedVersionCount: number;
  retiredVersionCount: number;
  pinnedSubscriptions: number;
  unpinnedSubscriptions: number;
}

function versioningOf(p: PlanRow, agg: Aggregates): PlanVersioningSummary {
  const versions = agg.versions.get(p.id) ?? [];
  const counts = agg.byVersion.get(p.id) ?? new Map<number | null, number>();
  const published = versions.filter((v) => v.publishedAt);
  const current = published.filter((v) => !v.retiredAt).sort((a, b) => b.version - a.version)[0] ?? null;
  const draft = versions.find((v) => !v.publishedAt) ?? null;
  let pinned = 0;
  for (const [k, n] of counts) if (k != null) pinned += n;
  return {
    status: p.status,
    versioning: current ? "versioned" : "not_versioned",
    currentVersion: current ? versionSummary(current, counts.get(current.id) ?? 0) : null,
    draft: draft ? versionSummary(draft, 0) : null,
    versionCount: versions.length,
    publishedVersionCount: published.length,
    retiredVersionCount: published.filter((v) => v.retiredAt).length,
    pinnedSubscriptions: pinned,
    unpinnedSubscriptions: counts.get(null) ?? 0,
  };
}

function overview(p: PlanRow, agg: Aggregates) {
  const prices = agg.prices.filter((pr) => pr.planId === p.id);
  const byStatus = agg.byStatus.get(p.id) ?? emptyStatusCounts();
  const byBillingSource = agg.bySource.get(p.id) ?? emptySourceCounts();
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    seeded: SEEDED_IDS.has(p.id),
    trialDays: p.trialDays,
    limits: planLimits(p),
    features: p.features ?? {},
    prices,
    activePriceCount: prices.filter((pr) => pr.active).length,
    subscriptions: { total, byStatus, byBillingSource, withOverrides: agg.overrides.get(p.id)?.tenants ?? 0 },
    ...versioningOf(p, agg),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listPlanCatalog() {
  const [plans, agg] = await Promise.all([repo.listPlans(false), loadAggregates()]);
  const provider = getBillingProvider();
  return {
    plans: plans.map((p) => overview(p, agg)),
    limitResources: [...LIMIT_RESOURCES],
    trialPolicy: trialPolicy(),
    provider: { kind: provider.kind, available: provider.available, stripeMode: config.billing.stripeMode ?? null },
    featureCatalog: [...PLAN_FEATURE_KEYS],
    // Batch 40: the versioned Plan Builder is live — published versions stay
    // immutable; changes go through drafts (plan-builder.service.ts).
    readOnly: false as const,
    generatedAt: new Date().toISOString(),
  };
}

async function requirePlan(planId: string): Promise<PlanRow> {
  const plan = isPlanSlug(planId) ? await repo.findPlanById(planId) : undefined;
  if (!plan) throw new AppError(404, "Plan not found", { code: "PLAN_NOT_FOUND" });
  return plan;
}

export async function getPlanDetail(planId: string) {
  const [plan, agg] = await Promise.all([requirePlan(planId), loadAggregates()]);
  const o = agg.overrides.get(plan.id);
  return {
    ...overview(plan, agg),
    overrides: { tenantsWithAnyOverride: o?.tenants ?? 0, byResource: o?.byResource ?? emptyResourceCounts() },
  };
}

function limitOf(limits: EffectiveLimit[], resource: LimitResource): EffectiveLimit {
  return limits.find((l) => l.resource === resource) ?? { resource, limit: null, source: "unlimited" };
}

// READ-ONLY preview: what the tenant's effective limits would be under `planId`,
// computed by the same resolver and the same usage counter the product enforces
// with. Nothing is written; the tenant's subscription, plan and overrides stay as
// they are. `exceeds` and `blockingResources` are informational (U6 is unapproved).
export async function previewEffectiveLimits(planId: string, companyId: number, now = new Date(), versionId?: number) {
  const plan = await requirePlan(planId);
  // Batch 40: preview under a specific version (draft or published) when asked;
  // otherwise under the plan row, which mirrors the current published version.
  let version: PlanVersionRow | undefined;
  if (versionId != null) {
    version = await repo.findPlanVersionById(versionId);
    if (!version || version.planId !== plan.id) throw new AppError(404, "Plan version not found", { code: "VERSION_NOT_FOUND" });
  } else {
    version = await repo.findCurrentPublishedVersion(plan.id);
  }
  const source: PlanLimitDefaults = versionId != null && version ? limitsAsPlanDefaults(version.snapshot.limits) : plan;
  const sub = await repo.findByCompanyId(companyId);
  if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  const company = await repo.findCompany(companyId);
  const current = await effectiveLimitsFor(sub); // fails closed on integrity faults, like every enforcement path
  const preview = resolveEffectiveLimits(source, sub.limitOverrides);
  // Batch 41 (PB-3): the tenant's CURRENT entitlements (the same decision path
  // as the per-request gate) and what the previewed version would entitle.
  const currentCtx = await resolveSubscriptionContext(sub, now);
  const currentEntitlements = tenantEntitlementsOf(currentCtx);
  const previewSnapshot: PlanVersionSnapshot = version ? version.snapshot : snapshotFromPlanRow(plan, []);
  const previewTrial = version ? version.trialPolicy : defaultTrialPolicy(plan.trialDays);
  const previewFeatures = resolveFeatureEntitlements(previewSnapshot);
  const previewTrialPolicy = trialEndPolicyOf(previewTrial);
  const previewAllowance = allowancesOf(previewSnapshot);
  const aiRow = await aiRepo.getSettingsByCompany(companyId);
  const tenantBudgets = { monthlyTokenBudget: aiRow?.monthlyTokenBudget ?? null, monthlyCostBudgetMicroUsd: aiRow?.monthlyCostBudgetMicroUsd ?? null };
  const previewBudget = applyPlanAllowance(tenantBudgets, { planVersionId: version?.id ?? null, ...previewAllowance });
  const currentAllowance = currentCtx.version ? allowancesOf(currentCtx.version.snapshot) : { aiTokensPerMonth: null, aiCostMicroUsdPerMonth: null };
  const currentBudget = applyPlanAllowance(tenantBudgets, { planVersionId: currentCtx.version?.id ?? null, ...currentAllowance });
  const usage = await usageReport(companyId, sub, now);
  const defaults = versionId != null && version ? version.snapshot.limits : planLimits(plan);
  const rows = LIMIT_RESOURCES.map((resource) => {
    const pv = limitOf(preview, resource);
    const cur = limitOf(current, resource);
    const u = usage.resources.find((r) => r.resource === resource);
    const used = u?.used ?? 0;
    const measurable = u?.measurable ?? false;
    const effective = pv.limit;
    return {
      resource,
      planDefault: defaults[resource],
      override: numericOverride(sub.limitOverrides, resource),
      effective,
      source: pv.source,
      currentEffective: cur.limit,
      changes: cur.limit !== effective,
      used,
      measurable,
      remaining: effective == null || !measurable ? null : Math.max(0, effective - used),
      exceeds: measurable && effective != null && used > effective,
    };
  });
  return {
    companyId,
    companyName: company?.name ?? null,
    currentPlan: sub.plan,
    currentPlanVersionId: sub.planVersionId ?? null,
    previewPlan: plan.id,
    previewVersionId: version?.id ?? null,
    previewVersion: version?.version ?? null,
    previewVersionState: version ? versionState(version) : null,
    isCurrentPlan: plan.id === sub.plan,
    status: normalizeLegacyStatus(sub.status) ?? sub.status,
    accessMode: currentCtx.entitlement.accessMode,
    billingSource: sub.billingSource,
    rows,
    changedResources: rows.filter((r) => r.changes).map((r) => r.resource),
    blockingResources: rows.filter((r) => r.exceeds).map((r) => r.resource),
    // Batch 41 (PB-3): feature entitlements, trial policy and AI allowances —
    // preview vs current, with the source of every effective value.
    featureEnforcement: { preview: version ? featureEnforcementOf(previewSnapshot) : "legacy", current: currentEntitlements.featureEnforcement },
    features: PLAN_FEATURE_KEYS.map((feature) => ({
      feature,
      label: FEATURE_LABEL[feature],
      recorded: previewSnapshot.features?.[feature] === true,
      previewAllowed: previewFeatures.allowed[feature],
      currentAllowed: currentEntitlements.features[feature],
      changes: previewFeatures.allowed[feature] !== currentEntitlements.features[feature],
    })),
    changedFeatures: PLAN_FEATURE_KEYS.filter((f) => previewFeatures.allowed[f] !== currentEntitlements.features[f]),
    trialPolicy: {
      preview: { endOutcome: previewTrialPolicy.endOutcome, readOnlyGraceDays: previewTrialPolicy.readOnlyGraceDays, graceEndsAt: sub.trialExpiresAt && previewTrialPolicy.endOutcome === "read_only" ? trialGraceEndsAt(sub.trialExpiresAt, previewTrialPolicy).toISOString() : null },
      current: currentEntitlements.trialPolicy,
    },
    aiAllowances: {
      tenantOverride: { monthlyTokenBudget: tenantBudgets.monthlyTokenBudget, monthlyCostBudgetMicroUsd: tenantBudgets.monthlyCostBudgetMicroUsd },
      preview: { allowance: previewAllowance, effectiveTokenBudget: previewBudget.monthlyTokenBudget, effectiveCostBudgetMicroUsd: previewBudget.monthlyCostBudgetMicroUsd, source: previewBudget.budgetSource },
      current: { allowance: currentAllowance, effectiveTokenBudget: currentBudget.monthlyTokenBudget, effectiveCostBudgetMicroUsd: currentBudget.monthlyCostBudgetMicroUsd, source: currentBudget.budgetSource },
    },
    readOnly: true as const,
    generatedAt: now.toISOString(),
  };
}
