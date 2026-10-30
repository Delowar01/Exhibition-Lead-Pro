import { config } from "../config.js";
import { AppError } from "../middlewares/errorHandler.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { PlanRow, SubscriptionRow } from "../repositories/subscriptions.repository.js";
import { PLAN_CATALOG, DEFAULT_TRIAL_DAYS } from "../lib/billing/plan-catalog.js";
import {
  BILLING_SOURCES,
  LIMIT_RESOURCES,
  SUBSCRIPTION_STATUSES,
  isPlanId,
  normalizeLegacyStatus,
  resolveEffectiveLimits,
  resolveEntitlement,
  type EffectiveLimit,
  type LimitResource,
} from "../lib/billing/lifecycle.js";
import { getBillingProvider } from "../lib/billing/provider.js";
import { effectiveLimitsFor, usageReport } from "./entitlements.service.js";
import { listPrices } from "./platform-billing.service.js";

// Batch 39 — Plan Builder foundation (PB-1, schema-independent, READ-ONLY).
//
// Platform-owner views over the EXISTING entities only: the five fixed plans
// (`plans`), their verified provider price mappings (`plan_prices`), the canonical
// subscriptions and their per-tenant `limit_overrides`. Nothing here writes, and no
// endpoint of this module mutates a plan: published-plan entitlements stay exactly
// as they are until the owner approves the versioned model (PB-1.4 / PB-2).
//
// Entitlement decisions are NOT re-implemented. The effective-limit preview calls
// the single resolver (`resolveEffectiveLimits` through `effectiveLimitsFor`) and the
// single usage counter (`usageReport`) the enforcement paths already use.

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
    rule: "A trialing subscription whose trial_expires_at has passed resolves to blocked (TRIAL_ENDED); no read-only grace exists today. Manual trials are expired by the system sweep with audit evidence.",
  };
}

interface Aggregates {
  prices: Awaited<ReturnType<typeof listPrices>>;
  byStatus: Map<string, StatusCounts>;
  bySource: Map<string, SourceCounts>;
  overrides: Map<string, { tenants: number; byResource: ResourceCounts }>;
}

async function loadAggregates(): Promise<Aggregates> {
  const [prices, statusRows, sourceRows, overrideRows] = await Promise.all([
    listPrices(),
    repo.countSubscriptionsByPlanAndStatus(),
    repo.countSubscriptionsByPlanAndSource(),
    repo.listSubscriptionLimitOverrides(),
  ]);
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
  return { prices, byStatus, bySource, overrides };
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
    versioning: "not_versioned" as const,
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
    readOnly: true as const,
    generatedAt: new Date().toISOString(),
  };
}

async function requirePlan(planId: string): Promise<PlanRow> {
  const plan = isPlanId(planId) ? await repo.findPlanById(planId) : undefined;
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
export async function previewEffectiveLimits(planId: string, companyId: number, now = new Date()) {
  const plan = await requirePlan(planId);
  const sub = await repo.findByCompanyId(companyId);
  if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  const company = await repo.findCompany(companyId);
  const current = await effectiveLimitsFor(sub); // fails closed on integrity faults, like every enforcement path
  const preview = resolveEffectiveLimits(plan, sub.limitOverrides);
  const usage = await usageReport(companyId, sub, now);
  const defaults = planLimits(plan);
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
    previewPlan: plan.id,
    isCurrentPlan: plan.id === sub.plan,
    status: normalizeLegacyStatus(sub.status) ?? sub.status,
    accessMode: resolveEntitlement(sub, now).accessMode,
    billingSource: sub.billingSource,
    rows,
    changedResources: rows.filter((r) => r.changes).map((r) => r.resource),
    blockingResources: rows.filter((r) => r.exceeds).map((r) => r.resource),
    readOnly: true as const,
    generatedAt: now.toISOString(),
  };
}
