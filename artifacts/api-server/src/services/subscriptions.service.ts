import { createHash, randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow, PlanPriceRow } from "../repositories/subscriptions.repository.js";
import { resolveEntitlement, resolveBillingCapabilities, normalizeLegacyStatus, allowedActions } from "../lib/billing/lifecycle.js";
import { getBillingProvider, BillingProviderError } from "../lib/billing/provider.js";
import { writeSubscriptionAudit, type AuditActor } from "../lib/billing/audit.js";
import { effectiveLimitsFor, usageReport } from "./entitlements.service.js";

// Batch 20 — tenant-facing subscription service. READS never write (no lazy
// insert); the only mutations are provider-side session creation (Checkout,
// Portal), which never change local entitlement — a verified webhook does.

function tenantCompanyId(user: AuthUser): number {
  // The company is derived from the authenticated tenant context only; platform
  // operators are rejected by requireTenantUser before reaching here.
  if (user.role === "platform_owner" || !user.companyId) throw new AppError(403, "Tenant context required", { code: "TENANT_CONTEXT_REQUIRED" });
  return user.companyId;
}

async function loadTenantSubscription(companyId: number): Promise<SubscriptionRow> {
  const sub = await repo.findByCompanyId(companyId);
  if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  return sub;
}

function providerContext(activePrices: number) {
  const provider = getBillingProvider();
  return {
    providerAvailable: provider.available,
    checkoutEnabled: config.billing.selfServiceCheckout,
    portalConfigured: provider.available,
    hasActivePrices: activePrices > 0,
  };
}

export function priceView(p: PlanPriceRow) {
  return {
    id: p.id,
    planId: p.planId,
    interval: p.interval,
    intervalCount: p.intervalCount,
    currency: p.currency,
    unitAmountMinor: p.unitAmountMinor,
    nickname: p.nickname,
    active: p.active,
  };
}

// Stable projection returned to tenants (and reused by the platform detail view).
export async function projectSubscription(sub: SubscriptionRow, now = new Date()) {
  const entitlement = resolveEntitlement(sub, now);
  const activePrices = await repo.listPlanPrices({ activeOnly: true });
  const caps = resolveBillingCapabilities(sub, providerContext(activePrices.length), sub.providerStatus);
  const limits = await effectiveLimitsFor(sub);
  const usage = await usageReport(sub.companyId, sub, now);
  const provider = getBillingProvider();
  return {
    id: sub.id,
    companyId: sub.companyId,
    plan: sub.plan,
    status: normalizeLegacyStatus(sub.status) ?? sub.status,
    billingSource: sub.billingSource,
    accessMode: entitlement.accessMode,
    accessReasonCode: entitlement.reasonCode,
    accessMessage: entitlement.message,
    trialStartedAt: sub.trialStartedAt?.toISOString() ?? null,
    trialExpiresAt: sub.trialExpiresAt?.toISOString() ?? null,
    currentPeriodStartsAt: sub.currentPeriodStartsAt?.toISOString() ?? null,
    currentPeriodEndsAt: sub.currentPeriodEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt?.toISOString() ?? null,
    endedAt: sub.endedAt?.toISOString() ?? null,
    suspendedAt: sub.suspendedAt?.toISOString() ?? null,
    statusChangedAt: sub.statusChangedAt.toISOString(),
    providerLinked: !!sub.stripeCustomerId,
    providerSubscriptionLinked: !!sub.stripeSubscriptionId,
    billing: {
      providerConfigured: provider.available,
      selfServiceCheckoutEnabled: config.billing.selfServiceCheckout,
      checkoutAvailable: caps.checkoutAvailable,
      checkoutUnavailableReason: caps.checkoutUnavailableReason,
      portalAvailable: caps.portalAvailable,
      portalUnavailableReason: caps.portalUnavailableReason,
      managedByPlatform: sub.billingSource === "manual",
    },
    limits: limits.map((l) => ({ resource: l.resource, limit: l.limit, source: l.source })),
    usage,
  };
}

export async function getCurrentSubscription(user: AuthUser) {
  const companyId = tenantCompanyId(user);
  const sub = await loadTenantSubscription(companyId);
  return projectSubscription(sub);
}

export async function getUsage(user: AuthUser) {
  const companyId = tenantCompanyId(user);
  const sub = await loadTenantSubscription(companyId);
  return usageReport(companyId, sub);
}

// Plans + ONLY their active, provider-verified prices. No invented amounts.
export async function listPlans() {
  const plans = await repo.listPlans(true);
  const prices = await repo.listPlanPrices({ activeOnly: true });
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    trialDays: p.trialDays,
    sortOrder: p.sortOrder,
    limits: {
      contacts: p.contactsLimit,
      events: p.eventsLimit,
      admins: p.adminsLimit,
      employees: p.employeesLimit,
      scans: p.scansLimit,
      storageMb: p.storageLimitMb,
    },
    prices: prices.filter((pr) => pr.planId === p.id).map(priceView),
  }));
}

// ── Checkout ─────────────────────────────────────────────────────────────────

function opaqueKey(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export async function createCheckout(user: AuthUser, input: { planPriceId?: unknown }, actor: AuditActor): Promise<{ url: string; status: "created" | "reused" }> {
  const companyId = tenantCompanyId(user);
  const planPriceId = typeof input.planPriceId === "number" && Number.isInteger(input.planPriceId) ? input.planPriceId : null;
  if (planPriceId == null) throw new AppError(400, "planPriceId is required", { code: "INVALID_PRICE" });
  const provider = getBillingProvider();
  if (!provider.available) throw new AppError(503, "Online checkout is not available.", { code: "PROVIDER_UNAVAILABLE" });
  if (!config.billing.selfServiceCheckout) throw new AppError(503, "Online checkout is not enabled.", { code: "CHECKOUT_DISABLED" });

  // Serialize Checkout creation per company: the row lock is held for the
  // provider call so two concurrent requests cannot create two live sessions.
  const { url, status } = await db.transaction(async (tx) => {
    const sub = await repo.lockByCompanyId(companyId, tx);
    if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
    const price = await repo.findPlanPriceById(planPriceId, tx);
    if (!price || !price.active) throw new AppError(400, "This price is not available.", { code: "PRICE_NOT_AVAILABLE" });
    const activeCount = (await repo.listPlanPrices({ activeOnly: true }, tx)).length;
    const caps = resolveBillingCapabilities(sub, providerContext(activeCount), sub.providerStatus);
    if (!caps.checkoutAvailable) {
      throw new AppError(409, "Checkout is not available for this subscription.", { code: caps.checkoutUnavailableReason ?? "CHECKOUT_UNAVAILABLE" });
    }
    const now = new Date();
    // Reuse an open, unexpired session for the same price instead of minting another.
    const open = await repo.findOpenCheckoutSession(companyId, now, tx);
    if (open && open.planPriceId === price.id && open.providerSessionId) {
      const remote = await provider.retrieveCheckoutSession(open.providerSessionId).catch(() => null);
      if (remote?.url && remote.status === "open") return { url: remote.url, status: "reused" as const };
      await repo.updateCheckoutSession(open.id, { status: "expired" }, tx);
    }

    // Exactly one provider customer per company (created under the lock, idempotent).
    let customerId = sub.stripeCustomerId;
    if (!customerId) {
      const company = await repo.findCompany(companyId, tx);
      const created = await provider.createCustomer({ companyId, companyName: company?.name ?? `Company ${companyId}`, idempotencyKey: `customer:${opaqueKey("customer", companyId)}` });
      customerId = created.id;
      await repo.update(sub.id, { stripeCustomerId: customerId }, tx);
      await writeSubscriptionAudit(tx, { action: "subscription.provider_customer_linked", companyId, subscriptionId: sub.id, before: sub, after: { ...sub, stripeCustomerId: customerId }, actor });
    }

    const attempt = randomUUID();
    const idempotencyKey = `checkout:${opaqueKey("checkout", companyId, price.id, attempt)}`;
    const local = await repo.insertCheckoutSession(
      { companyId, subscriptionId: sub.id, planPriceId: price.id, planId: price.planId, idempotencyKey, providerCustomerId: customerId, status: "created", createdByUserId: user.id },
      tx,
    );
    await repo.expireOpenCheckoutSessions(companyId, local.id, tx);
    const base = config.billing.returnUrl;
    let session;
    try {
      session = await provider.createCheckoutSession({
        customerId,
        priceId: price.providerPriceId,
        successUrl: `${base}/admin/subscription?checkout=success`,
        cancelUrl: `${base}/admin/subscription?checkout=cancelled`,
        clientReferenceId: String(local.id),
        // Opaque internal identifiers only — no email, no names.
        metadata: { companyId: String(companyId), subscriptionId: String(sub.id), checkoutId: String(local.id), planId: price.planId },
        idempotencyKey,
        automaticTax: config.billing.automaticTax,
      });
    } catch (err) {
      // Provider failure: the transaction rolls back (no local session row, no
      // customer link beyond what already existed) and entitlement is untouched.
      logger.warn({ companyId, code: err instanceof BillingProviderError ? err.code : "unknown" }, "Checkout session creation failed at the provider");
      throw new AppError(502, "The payment provider could not start checkout. Please try again.", { code: "PROVIDER_ERROR" });
    }
    if (!session.url) throw new AppError(502, "The payment provider returned no checkout link.", { code: "PROVIDER_ERROR" });
    await repo.updateCheckoutSession(local.id, { providerSessionId: session.id, expiresAt: session.expiresAt }, tx);
    await writeSubscriptionAudit(tx, { action: "subscription.checkout_started", companyId, subscriptionId: sub.id, before: sub, after: sub, actor, extra: { planId: price.planId, planPriceId: price.id } });
    logger.info({ companyId, subscriptionId: sub.id, checkoutId: local.id, planId: price.planId }, "Checkout session created");
    return { url: session.url, status: "created" as const };
  });
  return { url, status };
}

// ── Billing Portal ───────────────────────────────────────────────────────────

export async function createPortalSession(user: AuthUser, actor: AuditActor): Promise<{ url: string }> {
  const companyId = tenantCompanyId(user);
  const provider = getBillingProvider();
  if (!provider.available) throw new AppError(503, "The billing portal is not available.", { code: "PROVIDER_UNAVAILABLE" });
  const sub = await loadTenantSubscription(companyId);
  const activeCount = (await repo.listPlanPrices({ activeOnly: true })).length;
  const caps = resolveBillingCapabilities(sub, providerContext(activeCount), sub.providerStatus);
  if (!caps.portalAvailable || !sub.stripeCustomerId) {
    throw new AppError(409, "The billing portal is not available for this subscription.", { code: caps.portalUnavailableReason ?? "PORTAL_UNAVAILABLE" });
  }
  let url: string;
  try {
    ({ url } = await provider.createPortalSession({ customerId: sub.stripeCustomerId, returnUrl: `${config.billing.returnUrl}/admin/subscription`, configurationId: config.billing.stripePortalConfigurationId || undefined }));
  } catch (err) {
    logger.warn({ companyId, code: err instanceof BillingProviderError ? err.code : "unknown" }, "Portal session creation failed at the provider");
    throw new AppError(502, "The payment provider could not open the billing portal. Please try again.", { code: "PROVIDER_ERROR" });
  }
  await db.transaction((tx) => writeSubscriptionAudit(tx, { action: "subscription.portal_opened", companyId, subscriptionId: sub.id, before: sub, after: sub, actor }));
  return { url };
}

export { allowedActions };
