import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow, PlanPriceRow } from "../repositories/subscriptions.repository.js";
import { resolveEntitlement, normalizeLegacyStatus, allowedActions, SUBSCRIPTION_STATUSES, BILLING_SOURCES, LIVE_PROVIDER_STATUSES } from "../lib/billing/lifecycle.js";
import { findPlan } from "../lib/billing/plan-catalog.js";
import { getBillingProvider, BillingProviderError } from "../lib/billing/provider.js";
import { projectSubscription, priceView } from "./subscriptions.service.js";
import { parseListQuery } from "../lib/list-query.js";
import { auditLogsTable } from "@workspace/db";
import type { AuditActor } from "../lib/billing/audit.js";

// Batch 20 — platform-owner views: real subscription list/detail, provider price
// registration (server-verified), provider status, and truthful revenue.

function mask(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 6 ? "…" : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export interface ListParams {
  status?: string;
  plan?: string;
  billingSource?: string;
  search?: string;
  page?: string;
  limit?: string;
}

export async function listSubscriptions(params: ListParams) {
  const { page, limit, offset } = parseListQuery(params, { defaultPageSize: 20, maxPageSize: 100 });
  const status = params.status && (SUBSCRIPTION_STATUSES as readonly string[]).includes(params.status) ? params.status : undefined;
  const billingSource = params.billingSource && (BILLING_SOURCES as readonly string[]).includes(params.billingSource) ? params.billingSource : undefined;
  const plan = params.plan && /^[a-z_]{1,32}$/.test(params.plan) ? params.plan : undefined;
  const { rows, total } = await repo.listWithCompanies({ status, plan, billingSource, search: params.search?.trim() || undefined, limit, offset });
  const now = new Date();
  return {
    subscriptions: rows.map((r) => {
      const e = resolveEntitlement(r, now);
      return {
        id: r.id,
        companyId: r.companyId,
        companyName: r.companyName,
        plan: r.plan,
        status: normalizeLegacyStatus(r.status) ?? r.status,
        billingSource: r.billingSource,
        accessMode: e.accessMode,
        trialExpiresAt: r.trialExpiresAt?.toISOString() ?? null,
        currentPeriodEndsAt: r.currentPeriodEndsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        providerLinked: !!r.stripeCustomerId,
        statusChangedAt: r.statusChangedAt.toISOString(),
        companyCreatedAt: r.companyCreatedAt.toISOString(),
      };
    }),
    total,
    page,
    limit,
  };
}

export async function getSubscriptionDetail(companyId: number) {
  const sub = await repo.findByCompanyId(companyId);
  if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  const company = await repo.findCompany(companyId);
  const projection = await projectSubscription(sub);
  return {
    ...projection,
    companyName: company?.name ?? null,
    limitOverrides: sub.limitOverrides,
    allowedActions: allowedActions(sub),
    suspendedReason: sub.suspendedReason,
    statusBeforeSuspension: sub.statusBeforeSuspension,
    providerStatus: sub.providerStatus,
    providerSyncedAt: sub.providerSyncedAt?.toISOString() ?? null,
    // Sanitized diagnostic refs only (platform-only view).
    providerCustomerRef: mask(sub.stripeCustomerId),
    providerSubscriptionRef: mask(sub.stripeSubscriptionId),
    // B20 Correction 1: a second LIVE provider subscription for this company was
    // refused and recorded; the operator resolves it in the provider.
    providerConflict: await latestConflict(companyId),
    // Last provider delivery that could not be applied because its price is unregistered.
    providerPriceUnmapped: await latestPriceUnmapped(companyId),
  };
}

async function latestConflict(companyId: number) {
  const row = await repo.latestProviderEventByOutcome(companyId, "conflict");
  return row ? { eventType: row.eventType, eventRef: mask(row.eventId), receivedAt: row.receivedAt.toISOString() } : null;
}

async function latestPriceUnmapped(companyId: number) {
  const row = await repo.latestProviderEventByOutcome(companyId, "price_unmapped");
  return row ? { eventType: row.eventType, eventRef: mask(row.eventId), receivedAt: row.receivedAt.toISOString(), attempts: row.attempts } : null;
}

export async function listRecentProviderEvents(companyId: number, limit = 20) {
  const rows = await repo.listProviderEvents({ companyId, limit: Math.min(100, Math.max(1, limit)) });
  return rows.map((r) => ({ id: r.id, eventType: r.eventType, eventRef: mask(r.eventId), status: r.status, outcome: r.outcome, failureCode: r.failureCode, receivedAt: r.receivedAt.toISOString(), processedAt: r.processedAt?.toISOString() ?? null }));
}

// ── Provider status / price mappings ─────────────────────────────────────────

export function providerStatus() {
  const provider = getBillingProvider();
  return {
    provider: provider.kind,
    available: provider.available,
    unavailableReason: provider.unavailableReason,
    selfServiceCheckoutEnabled: config.billing.selfServiceCheckout,
    automaticTax: config.billing.automaticTax,
    portalConfigurationSet: !!config.billing.stripePortalConfigurationId,
    trialDays: config.billing.trialDays,
    // B20 Correction 1 — explicit Stripe mode + centrally validated return URL (never the value itself).
    stripeMode: config.billing.stripeMode,
    returnUrlConfigured: config.billing.returnUrl != null,
    returnUrlReason: config.billing.returnUrlReason,
  };
}

export async function listPrices() {
  const rows = await repo.listPlanPrices({});
  return rows.map(fullPriceView);
}

function fullPriceView(p: PlanPriceRow) {
  return { ...priceView(p), providerMode: p.providerMode, providerPriceRef: mask(p.providerPriceId), providerProductRef: mask(p.providerProductId), verifiedAt: p.verifiedAt.toISOString(), createdAt: p.createdAt.toISOString() };
}

// Registers a provider price for a plan. The browser supplies ONLY the plan and
// the provider price id; interval, currency, amount and product come from the
// provider (server-verified) and are persisted as returned.
export async function registerPrice(actor: AuditActor, input: { planId?: unknown; providerPriceId?: unknown }) {
  const planId = typeof input.planId === "string" ? input.planId : "";
  const providerPriceId = typeof input.providerPriceId === "string" ? input.providerPriceId.trim() : "";
  if (!(await findPlan(planId))) throw new AppError(400, "Invalid plan", { code: "INVALID_PLAN" });
  if (!/^price_[A-Za-z0-9_]{6,120}$/.test(providerPriceId)) throw new AppError(400, "providerPriceId must be a provider price id", { code: "INVALID_PRICE_ID" });
  const provider = getBillingProvider();
  if (!provider.available) throw new AppError(503, "Billing provider unavailable", { code: "PROVIDER_UNAVAILABLE" });
  if (await repo.findPlanPriceByProviderId(providerPriceId)) throw new AppError(409, "This provider price is already registered", { code: "PRICE_ALREADY_REGISTERED" });
  let remote;
  try {
    remote = await provider.retrievePrice(providerPriceId);
  } catch (err) {
    const code = err instanceof BillingProviderError ? err.code : "PROVIDER_ERROR";
    if (err instanceof BillingProviderError && err.providerStatus === 404) throw new AppError(404, "The provider does not know this price id", { code: "PROVIDER_PRICE_NOT_FOUND" });
    logger.warn({ code }, "Price retrieval failed at the provider");
    throw new AppError(502, "The payment provider could not verify this price", { code: "PROVIDER_ERROR" });
  }
  // B20 Correction 1: a price can only enter the catalog of the mode the server is configured for.
  const expectedLive = (config.billing.stripeMode ?? "test") === "live";
  if (remote.livemode !== expectedLive) throw new AppError(400, `This price belongs to Stripe ${remote.livemode ? "live" : "test"} mode; the platform is configured for ${expectedLive ? "live" : "test"} mode`, { code: "PRICE_MODE_MISMATCH" });
  if (remote.type !== "recurring" || !remote.recurringInterval) throw new AppError(400, "Only recurring prices can be mapped to a plan", { code: "PRICE_NOT_RECURRING" });
  if (remote.unitAmountMinor == null) throw new AppError(400, "Only fixed-amount prices can be mapped to a plan", { code: "PRICE_NOT_FIXED" });
  if (!remote.active) throw new AppError(400, "This provider price is not active", { code: "PRICE_INACTIVE" });
  const row = await db.transaction(async (tx) => {
    const created = await repo.insertPlanPrice(
      {
        planId,
        provider: "stripe",
        providerPriceId: remote.id,
        providerProductId: remote.productId,
        interval: remote.recurringInterval as string,
        intervalCount: remote.recurringIntervalCount,
        currency: remote.currency,
        unitAmountMinor: remote.unitAmountMinor as number,
        nickname: remote.nickname,
        providerMode: remote.livemode ? "live" : "test",
        active: true,
        verifiedAt: new Date(),
        createdByUserId: actor.userId,
      },
      tx,
    );
    await tx.insert(auditLogsTable).values({
      companyId: null,
      userId: actor.userId,
      userName: actor.userName,
      action: "billing.price_mapping.create",
      entityType: "plan_price",
      entityId: String(created.id),
      metadata: { planId, interval: created.interval, currency: created.currency, unitAmountMinor: created.unitAmountMinor, providerPriceRef: mask(created.providerPriceId) },
      ipAddress: actor.ipAddress,
    });
    return created;
  });
  return fullPriceView(row);
}

export async function setPriceActive(actor: AuditActor, id: number, active: boolean) {
  const row = await repo.findPlanPriceById(id);
  if (!row) throw new AppError(404, "Price mapping not found", { code: "PRICE_NOT_FOUND" });
  const updated = await db.transaction(async (tx) => {
    const u = await repo.updatePlanPrice(id, { active }, tx);
    await tx.insert(auditLogsTable).values({
      companyId: null,
      userId: actor.userId,
      userName: actor.userName,
      action: "billing.price_mapping.update",
      entityType: "plan_price",
      entityId: String(id),
      metadata: { planId: row.planId, before: { active: row.active }, after: { active } },
      ipAddress: actor.ipAddress,
    });
    return u!;
  });
  return fullPriceView(updated);
}

// ── Truthful platform metrics ────────────────────────────────────────────────

export async function subscriptionMetrics(now = new Date()) {
  const [byStatus, byPlan, bySource, trialsExpiring7d] = await Promise.all([
    repo.countsBy("status"),
    repo.countsBy("plan"),
    repo.countsBy("billingSource"),
    repo.countTrialsExpiringWithin(7, now),
  ]);
  const statusCounts: Record<string, number> = {};
  for (const s of SUBSCRIPTION_STATUSES) statusCounts[s] = 0;
  for (const r of byStatus) statusCounts[normalizeLegacyStatus(r.key) ?? r.key] = (statusCounts[normalizeLegacyStatus(r.key) ?? r.key] ?? 0) + r.count;
  return {
    byStatus: Object.entries(statusCounts).map(([status, count]) => ({ status, count })),
    byPlan: byPlan.map((r) => ({ plan: r.key, count: r.count })),
    byBillingSource: bySource.map((r) => ({ billingSource: r.key, count: r.count })),
    trialsExpiringWithin7Days: trialsExpiring7d,
  };
}

// Revenue is computed ONLY from active provider-managed subscriptions whose bound
// price is a verified mapping. Anything else is reported as unavailable — never
// an estimate, never a zero presented as truth.
export async function revenueSnapshot() {
  const stripeSubs = await repo.listStripeManaged(10_000);
  const prices = await repo.listPlanPrices({});
  const byProviderPrice = new Map(prices.map((p) => [p.providerPriceId, p]));
  const live = stripeSubs.filter((s) => (normalizeLegacyStatus(s.status) === "active" || normalizeLegacyStatus(s.status) === "trialing") && s.stripeSubscriptionId && (s.providerStatus == null || LIVE_PROVIDER_STATUSES.has(s.providerStatus)) && normalizeLegacyStatus(s.status) === "active");
  if (live.length === 0) {
    return { available: false as const, reason: prices.length === 0 ? "NO_VERIFIED_PRICES" : "NO_ACTIVE_PROVIDER_SUBSCRIPTIONS", currency: null, monthlyRecurringMinor: null, countedSubscriptions: 0, unpricedSubscriptions: 0 };
  }
  let currency: string | null = null;
  let total = 0;
  let counted = 0;
  let unpriced = 0;
  for (const s of live) {
    const p = s.stripePriceId ? byProviderPrice.get(s.stripePriceId) : undefined;
    if (!p) {
      unpriced += 1;
      continue;
    }
    if (currency && currency !== p.currency) {
      return { available: false as const, reason: "MIXED_CURRENCIES", currency: null, monthlyRecurringMinor: null, countedSubscriptions: counted, unpricedSubscriptions: unpriced };
    }
    currency = p.currency;
    const monthly = p.interval === "year" ? p.unitAmountMinor / (12 * p.intervalCount) : p.interval === "month" ? p.unitAmountMinor / p.intervalCount : p.interval === "week" ? (p.unitAmountMinor * 52) / (12 * p.intervalCount) : (p.unitAmountMinor * 365) / (12 * p.intervalCount);
    total += monthly;
    counted += 1;
  }
  if (counted === 0) return { available: false as const, reason: "UNPRICED_SUBSCRIPTIONS", currency: null, monthlyRecurringMinor: null, countedSubscriptions: 0, unpricedSubscriptions: unpriced };
  return { available: true as const, reason: unpriced > 0 ? "PARTIAL_UNPRICED" : null, currency, monthlyRecurringMinor: Math.round(total), countedSubscriptions: counted, unpricedSubscriptions: unpriced };
}

export type { SubscriptionRow };
