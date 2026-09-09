import { createHash, randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow, PlanPriceRow, CheckoutSessionRow } from "../repositories/subscriptions.repository.js";
import { resolveEntitlement, resolveBillingCapabilities, normalizeLegacyStatus, allowedActions } from "../lib/billing/lifecycle.js";
import { getBillingProvider, BillingProviderError, type ProviderCheckoutSession } from "../lib/billing/provider.js";
import { billingFault } from "../lib/billing/test-faults.js";
import { applyProviderState } from "./subscription-lifecycle.service.js";
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

export function providerContext(activePrices: number) {
  const provider = getBillingProvider();
  return {
    providerAvailable: provider.available,
    checkoutEnabled: config.billing.selfServiceCheckout,
    portalConfigured: provider.available,
    hasActivePrices: activePrices > 0,
    // B20 Correction 1: the trusted return URL must have passed central validation.
    returnUrlValid: config.billing.returnUrl != null,
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

// ── Checkout (B20 Correction 1 — durable intent orchestration) ───────────────
//
// Invariant: NO provider network call runs while a database transaction or row
// lock is open. The flow is a sequence of SHORT transactions around provider calls:
//
//   1. tx: lock the canonical subscription, validate eligibility + the internal
//      price mapping, find-or-create ONE durable Checkout intent (`creating`),
//      derive the provider idempotency key from the intent id, COMMIT.
//   2. provider: create/retrieve the customer with the STABLE company key.
//   3. tx: persist the customer id (conditional, idempotent).
//   4. provider: create the Checkout session with the intent-derived key
//      (a retry after a crash resolves to the SAME provider session).
//   5. tx: link the provider session id / expiry, `creating → open`, COMMIT.
//   6. return the hosted URL (never stored).
//
// Switching prices: the existing OPEN session is expired AT THE PROVIDER first
// (confirmed), then locally, and only then is a replacement intent created. A
// session the provider reports as complete is reconciled instead.
// At most one non-terminal intent per company (partial unique index).

function opaqueKey(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
const customerKey = (companyId: number) => `customer:${opaqueKey("customer", companyId)}`;
const intentKey = (companyId: number, intentId: number) => `checkout:${opaqueKey("checkout", companyId, intentId)}`;
const isTerminalSession = (status: string | null) => status === "complete" || status === "expired";

type IntentStep =
  | { kind: "retry" }
  | { kind: "switch"; intent: CheckoutSessionRow }
  | { kind: "ready"; sub: SubscriptionRow; price: PlanPriceRow; intent: CheckoutSessionRow };

async function reconcileCompletedIntent(intent: CheckoutSessionRow, remote: ProviderCheckoutSession, actor: AuditActor): Promise<void> {
  const provider = getBillingProvider();
  // Provider state is fetched OUTSIDE the transaction.
  const remoteSub = remote.subscriptionId ? await provider.retrieveSubscription(remote.subscriptionId) : null;
  await db.transaction(async (tx) => {
    const local = await repo.transitionCheckoutSession(intent.id, ["creating", "open"], { status: "completed", completedAt: new Date(), providerSubscriptionId: remote.subscriptionId, providerCustomerId: remote.customerId ?? intent.providerCustomerId }, tx);
    const sub = await repo.lockByCompanyId(intent.companyId, tx);
    if (!sub || !remoteSub) return;
    await applyProviderState(tx, sub, remoteSub, null, actor, { source: "checkout_reconcile", checkoutId: intent.id }, { checkoutId: intent.id, completedCheckout: local ?? intent });
  });
}

// Expires the intent's provider session (when it is still open) and then the
// local intent. Provider failure → nothing changes locally, no replacement.
async function retireIntent(intent: CheckoutSessionRow, actor: AuditActor): Promise<void> {
  const provider = getBillingProvider();
  if (intent.providerSessionId) {
    const remote = await provider.retrieveCheckoutSession(intent.providerSessionId);
    if (remote && remote.status === "complete") {
      await reconcileCompletedIntent(intent, remote, actor);
      throw new AppError(409, "Your previous checkout was already completed; the subscription is being confirmed.", { code: "CHECKOUT_ALREADY_COMPLETED" });
    }
    if (remote && remote.status === "open") {
      await billingFault("checkout.beforeExpire");
      let result: ProviderCheckoutSession;
      try {
        result = await provider.expireCheckoutSession(intent.providerSessionId);
      } catch (err) {
        logger.warn({ companyId: intent.companyId, checkoutId: intent.id, code: err instanceof BillingProviderError ? err.code : "unknown" }, "Provider refused to expire the open Checkout session");
        throw new AppError(502, "The payment provider could not close the previous checkout. Please try again.", { code: "PROVIDER_ERROR" });
      }
      if (result.status !== "expired") throw new AppError(502, "The payment provider did not confirm the previous checkout was closed.", { code: "PROVIDER_ERROR" });
    }
  }
  await db.transaction(async (tx) => {
    const row = await repo.transitionCheckoutSession(intent.id, ["creating", "open"], { status: "expired" }, tx);
    if (row) {
      const sub = await repo.findByCompanyId(intent.companyId, tx);
      if (sub) await writeSubscriptionAudit(tx, { action: "subscription.checkout_expired", companyId: intent.companyId, subscriptionId: sub.id, before: sub, after: sub, actor, extra: { checkoutId: intent.id, providerSessionLinked: !!intent.providerSessionId } });
    }
  });
}

export async function createCheckout(user: AuthUser, input: { planPriceId?: unknown }, actor: AuditActor): Promise<{ url: string; status: "created" | "reused" }> {
  const companyId = tenantCompanyId(user);
  const planPriceId = typeof input.planPriceId === "number" && Number.isInteger(input.planPriceId) ? input.planPriceId : null;
  if (planPriceId == null) throw new AppError(400, "planPriceId is required", { code: "INVALID_PRICE" });
  const provider = getBillingProvider();
  if (!provider.available) throw new AppError(503, "Online checkout is not available.", { code: "PROVIDER_UNAVAILABLE" });
  if (!config.billing.returnUrl) throw new AppError(503, "Online checkout is not configured.", { code: config.billing.returnUrlReason ?? "RETURN_URL_INVALID" });
  if (!config.billing.selfServiceCheckout) throw new AppError(503, "Online checkout is not enabled.", { code: "CHECKOUT_DISABLED" });
  const mode = config.billing.stripeMode ?? "test";
  const base = config.billing.returnUrl;

  for (let round = 0; round < 4; round++) {
    // ── Step 1: short transaction — validate + find-or-create the durable intent.
    const step: IntentStep = await db.transaction(async (tx) => {
      const sub = await repo.lockByCompanyId(companyId, tx);
      if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
      const price = await repo.findPlanPriceById(planPriceId, tx);
      if (!price || !price.active) throw new AppError(400, "This price is not available.", { code: "PRICE_NOT_AVAILABLE" });
      if (price.providerMode !== mode) throw new AppError(400, "This price was verified in a different provider mode.", { code: "PRICE_MODE_MISMATCH" });
      const activeCount = (await repo.listPlanPrices({ activeOnly: true }, tx)).length;
      const caps = resolveBillingCapabilities(sub, providerContext(activeCount), sub.providerStatus);
      if (!caps.checkoutAvailable) throw new AppError(409, "Checkout is not available for this subscription.", { code: caps.checkoutUnavailableReason ?? "CHECKOUT_UNAVAILABLE" });
      const current = await repo.findCurrentCheckoutIntent(companyId, tx, true);
      if (current) {
        if (current.planPriceId === price.id) return { kind: "ready", sub, price, intent: current };
        return { kind: "switch", intent: current };
      }
      const inserted = await repo.insertCheckoutIntent(
        { companyId, subscriptionId: sub.id, planPriceId: price.id, planId: price.planId, provider: "stripe", providerMode: mode, idempotencyKey: `intent:${randomUUID()}`, providerCustomerId: sub.stripeCustomerId, status: "creating", createdByUserId: user.id },
        tx,
      );
      if (!inserted) return { kind: "retry" }; // another request created the intent concurrently
      const idempotencyKey = intentKey(companyId, inserted.id);
      await repo.updateCheckoutSession(inserted.id, { idempotencyKey }, tx);
      await writeSubscriptionAudit(tx, { action: "subscription.checkout_started", companyId, subscriptionId: sub.id, before: sub, after: sub, actor, extra: { planId: price.planId, planPriceId: price.id, checkoutId: inserted.id } });
      return { kind: "ready", sub, price, intent: { ...inserted, idempotencyKey } };
    });
    if (step.kind === "retry") continue;
    if (step.kind === "switch") {
      await retireIntent(step.intent, actor);
      continue;
    }
    const { price, intent } = step;
    let sub = step.sub;

    // ── Step 2/3: provider customer (stable key) → persisted in a short transaction.
    let customerId = sub.stripeCustomerId;
    if (!customerId) {
      const company = await repo.findCompany(companyId);
      let created: { id: string };
      try {
        created = await provider.createCustomer({ companyId, companyName: company?.name ?? `Company ${companyId}`, idempotencyKey: customerKey(companyId) });
      } catch (err) {
        logger.warn({ companyId, code: err instanceof BillingProviderError ? err.code : "unknown" }, "Customer creation failed at the provider");
        throw new AppError(502, "The payment provider could not start checkout. Please try again.", { code: "PROVIDER_ERROR" });
      }
      await billingFault("checkout.afterCustomerCreate");
      customerId = created.id;
      sub = await db.transaction(async (tx) => {
        const locked = await repo.lockByCompanyId(companyId, tx);
        if (!locked) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
        if (locked.stripeCustomerId && locked.stripeCustomerId !== customerId) throw new AppError(409, "This company is already linked to a different billing account.", { code: "PROVIDER_CUSTOMER_MISMATCH" });
        if (!locked.stripeCustomerId) {
          await repo.update(locked.id, { stripeCustomerId: customerId }, tx);
          await writeSubscriptionAudit(tx, { action: "subscription.provider_customer_linked", companyId, subscriptionId: locked.id, before: locked, after: { ...locked, stripeCustomerId: customerId }, actor });
        }
        await repo.updateCheckoutSession(intent.id, { providerCustomerId: customerId }, tx);
        return (await repo.findById(locked.id, tx))!;
      });
    }

    // ── Step 4/5: provider session (intent-derived key) → linked in a short transaction.
    if (intent.status === "open" && intent.providerSessionId) {
      const remote = await provider.retrieveCheckoutSession(intent.providerSessionId);
      if (remote && remote.status === "open" && remote.url) return { url: remote.url, status: "reused" };
      if (remote && remote.status === "complete") {
        await reconcileCompletedIntent(intent, remote, actor);
        throw new AppError(409, "Your previous checkout was already completed; the subscription is being confirmed.", { code: "CHECKOUT_ALREADY_COMPLETED" });
      }
      // Expired (or unknown) at the provider: retire locally and start over.
      await db.transaction((tx) => repo.transitionCheckoutSession(intent.id, ["open"], { status: "expired" }, tx));
      continue;
    }

    let session: ProviderCheckoutSession;
    try {
      session = await provider.createCheckoutSession({
        customerId,
        priceId: price.providerPriceId,
        successUrl: `${base}/admin/subscription?checkout=success`,
        cancelUrl: `${base}/admin/subscription?checkout=cancelled`,
        clientReferenceId: String(intent.id),
        // Opaque internal identifiers only — no email, no names.
        metadata: { companyId: String(companyId), subscriptionId: String(sub.id), checkoutId: String(intent.id), planId: price.planId },
        idempotencyKey: intent.idempotencyKey,
        automaticTax: config.billing.automaticTax,
      });
    } catch (err) {
      const code = err instanceof BillingProviderError ? err.code : "unknown";
      const retryable = err instanceof BillingProviderError ? err.retryable : false;
      logger.warn({ companyId, checkoutId: intent.id, code, retryable }, "Checkout session creation failed at the provider");
      // A transient failure keeps the intent `creating` so the retry reuses the same key;
      // a definitive refusal closes it.
      if (!retryable) await db.transaction((tx) => repo.transitionCheckoutSession(intent.id, ["creating"], { status: "failed" }, tx));
      throw new AppError(502, "The payment provider could not start checkout. Please try again.", { code: "PROVIDER_ERROR" });
    }
    await billingFault("checkout.afterSessionCreate");
    if (session.livemode !== (mode === "live")) {
      await db.transaction((tx) => repo.transitionCheckoutSession(intent.id, ["creating"], { status: "failed" }, tx));
      logger.error({ companyId, checkoutId: intent.id }, "Provider Checkout session mode does not match the configured Stripe mode");
      throw new AppError(502, "The payment provider returned a session in the wrong mode.", { code: "PROVIDER_MODE_MISMATCH" });
    }
    if (isTerminalSession(session.status) || !session.url) {
      await db.transaction((tx) => repo.transitionCheckoutSession(intent.id, ["creating"], { status: session.status === "complete" ? "completed" : "expired" }, tx));
      throw new AppError(502, "The payment provider returned no usable checkout link.", { code: "PROVIDER_ERROR" });
    }
    await db.transaction(async (tx) => {
      const linked = await repo.transitionCheckoutSession(intent.id, ["creating"], { status: "open", providerSessionId: session.id, expiresAt: session.expiresAt, providerCustomerId: customerId }, tx);
      if (!linked) {
        // A concurrent request with the SAME idempotency key already linked the same
        // provider session; nothing else can have changed the row meanwhile.
        const now = await repo.findCheckoutSessionById(intent.id, tx);
        if (!now || now.providerSessionId !== session.id) throw new AppError(409, "Checkout is being prepared by another request. Please try again.", { code: "CHECKOUT_IN_PROGRESS" });
      }
    });
    logger.info({ companyId, subscriptionId: sub.id, checkoutId: intent.id, planId: price.planId }, "Checkout session linked");
    return { url: session.url, status: "created" };
  }
  throw new AppError(409, "Checkout could not be prepared. Please try again.", { code: "CHECKOUT_IN_PROGRESS" });
}

// ── Billing Portal ───────────────────────────────────────────────────────────

export async function createPortalSession(user: AuthUser, actor: AuditActor): Promise<{ url: string }> {
  const companyId = tenantCompanyId(user);
  const provider = getBillingProvider();
  if (!provider.available) throw new AppError(503, "The billing portal is not available.", { code: "PROVIDER_UNAVAILABLE" });
  if (!config.billing.returnUrl) throw new AppError(503, "The billing portal is not configured.", { code: config.billing.returnUrlReason ?? "RETURN_URL_INVALID" });
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
