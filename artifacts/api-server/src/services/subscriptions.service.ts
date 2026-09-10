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
import { applyProviderState, ProviderModeMismatchError, ProviderPriceUnmappedError } from "./subscription-lifecycle.service.js";
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

type IntentStep =
  | { kind: "retry" }
  | { kind: "switch"; intent: CheckoutSessionRow }
  | { kind: "ready"; sub: SubscriptionRow; price: PlanPriceRow; intent: CheckoutSessionRow };

// Sanitized provider failure (never the provider payload) — the caller's intent
// stays current, the tenant may retry.
function providerFailure(companyId: number, checkoutId: number, err: unknown, what: string): AppError {
  logger.warn({ companyId, checkoutId, code: err instanceof BillingProviderError ? err.code : "unknown", retryable: err instanceof BillingProviderError ? err.retryable : false }, what);
  return new AppError(502, "The payment provider could not complete the checkout step. Please try again.", { code: "PROVIDER_ERROR" });
}
const ambiguous = () => new AppError(502, "The payment provider could not confirm the state of the previous checkout. Please try again.", { code: "PROVIDER_ERROR" });
const alreadyCompleted = () => new AppError(409, "Your previous checkout was already completed; the subscription is being confirmed.", { code: "CHECKOUT_ALREADY_COMPLETED" });
const inProgress = () => new AppError(409, "Checkout is being prepared by another request. Please try again.", { code: "CHECKOUT_IN_PROGRESS" });

async function retrieveSession(intent: CheckoutSessionRow, sessionId: string): Promise<ProviderCheckoutSession | null> {
  try {
    return await getBillingProvider().retrieveCheckoutSession(sessionId);
  } catch (err) {
    throw providerFailure(intent.companyId, intent.id, err, "Checkout session retrieval failed at the provider");
  }
}

async function reconcileCompletedIntent(intent: CheckoutSessionRow, remote: ProviderCheckoutSession, actor: AuditActor): Promise<void> {
  const provider = getBillingProvider();
  // Provider state is fetched OUTSIDE the transaction.
  const remoteSub = remote.subscriptionId ? await provider.retrieveSubscription(remote.subscriptionId) : null;
  try {
    await db.transaction(async (tx) => {
      const local = await repo.transitionCheckoutSession(intent.id, ["creating", "open"], { status: "completed", completedAt: new Date(), providerSessionId: remote.id, providerSubscriptionId: remote.subscriptionId, providerCustomerId: remote.customerId ?? intent.providerCustomerId }, tx);
      const sub = await repo.lockByCompanyId(intent.companyId, tx);
      if (!sub || !remoteSub) return;
      await applyProviderState(tx, sub, remoteSub, null, actor, { source: "checkout_reconcile", checkoutId: intent.id }, { checkoutId: intent.id, completedCheckout: local ?? intent, sessionId: remote.id });
    });
  } catch (err) {
    // The transaction rolled back: subscription, Checkout row, mirror and audit untouched.
    if (err instanceof ProviderModeMismatchError) {
      logger.error({ companyId: intent.companyId, checkoutId: intent.id }, "Completed Checkout references a subscription from the other Stripe mode");
      throw new AppError(502, "The payment provider returned a subscription in the wrong mode.", { code: "PROVIDER_MODE_MISMATCH" });
    }
    if (err instanceof ProviderPriceUnmappedError) throw new AppError(409, "The completed checkout uses a price that is not registered on this platform.", { code: "PROVIDER_PRICE_UNMAPPED" });
    throw err;
  }
}

// B20 Correction 2 — replays the ORIGINAL Checkout creation for an intent whose
// provider session id was never persisted (crash between the provider call and
// the link). Same idempotency key + identical parameters → the provider answers
// with the same session (or creates it now if the original request never reached
// it). The reply is used ONLY to learn the session id; the current state is
// retrieved afterwards. Parameters are rebuilt from the durable intent and the
// server configuration (no URL / secret / PII is stored); a parameter mismatch
// (configuration changed since) is a provider error → the intent stays current.
async function recoverIntentSession(intent: CheckoutSessionRow): Promise<string> {
  const price = intent.planPriceId != null ? await repo.findPlanPriceById(intent.planPriceId) : undefined;
  const base = config.billing.returnUrl;
  if (!price || !base || !intent.providerCustomerId) throw new AppError(503, "The previous checkout cannot be recovered right now. Please try again later.", { code: "CHECKOUT_RECOVERY_UNAVAILABLE" });
  try {
    const replay = await getBillingProvider().createCheckoutSession({
      customerId: intent.providerCustomerId,
      priceId: price.providerPriceId,
      successUrl: `${base}/admin/subscription?checkout=success`,
      cancelUrl: `${base}/admin/subscription?checkout=cancelled`,
      clientReferenceId: String(intent.id),
      metadata: { companyId: String(intent.companyId), subscriptionId: String(intent.subscriptionId), checkoutId: String(intent.id), planId: intent.planId },
      idempotencyKey: intent.idempotencyKey,
      automaticTax: config.billing.automaticTax,
    });
    return replay.id;
  } catch (err) {
    throw providerFailure(intent.companyId, intent.id, err, "Checkout recovery replay failed at the provider");
  }
}

// Local closure of an intent (audited). Idempotent: only a non-terminal row moves.
async function expireIntentLocally(intent: CheckoutSessionRow, actor: AuditActor, providerClosed: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await repo.transitionCheckoutSession(intent.id, ["creating", "open"], { status: "expired" }, tx);
    if (!row) return;
    const sub = await repo.findByCompanyId(intent.companyId, tx);
    if (sub) await writeSubscriptionAudit(tx, { action: "subscription.checkout_expired", companyId: intent.companyId, subscriptionId: sub.id, before: sub, after: sub, actor, extra: { checkoutId: intent.id, providerSessionLinked: !!row.providerSessionId, providerClosed } });
  });
}

// Authoritative closure of a KNOWN provider session (no cached reply is trusted):
// retrieve → `open`: expire at the provider and confirm → `expired`. `complete` →
// reconcile and refuse a replacement. Missing / unknown / failed → ambiguous: the
// intent stays current and the tenant gets a retryable failure. Concurrent closers
// are tolerated: a "not open" answer is re-checked against the retrieved state.
async function settleRemoteSession(intent: CheckoutSessionRow, sessionId: string, actor: AuditActor): Promise<void> {
  const provider = getBillingProvider();
  let remote = await retrieveSession(intent, sessionId);
  if (!remote) throw ambiguous();
  if (remote.status === "open") {
    await billingFault("checkout.beforeExpire");
    let confirmed = false;
    try {
      confirmed = (await provider.expireCheckoutSession(sessionId)).status === "expired";
    } catch (err) {
      logger.warn({ companyId: intent.companyId, checkoutId: intent.id, code: err instanceof BillingProviderError ? err.code : "unknown" }, "Provider did not expire the open Checkout session");
    }
    if (confirmed) {
      await billingFault("checkout.afterExpire");
      return;
    }
    remote = await retrieveSession(intent, sessionId);
    if (!remote) throw ambiguous();
  }
  if (remote.status === "complete") {
    await reconcileCompletedIntent(intent, remote, actor);
    throw alreadyCompleted();
  }
  if (remote.status !== "expired") throw ambiguous();
}

// B20 Correction 2 — closes the company's current intent so a different-price
// intent may follow. Invariant: a `creating` intent whose provider session id was
// never stored is NEVER retired or replaced until the remote state behind its
// stable idempotency key has been resolved authoritatively:
//   1. recover the session id by replaying the original creation (same key);
//   2. persist it with a compare-and-set while keeping the intent non-terminal;
//   3. retrieve the session and settle it (expire + confirm / reconcile / expired);
//   4. only then move the local intent to `expired`.
// No provider call runs inside a transaction or under a row lock.
async function closeIntent(intent: CheckoutSessionRow, actor: AuditActor): Promise<void> {
  let sessionId = intent.providerSessionId;
  if (!sessionId) {
    if (!intent.providerCustomerId) {
      // The session creation needs the linked customer; without one it never ran —
      // there is nothing remote to close.
      await expireIntentLocally(intent, actor, false);
      return;
    }
    sessionId = await recoverIntentSession(intent);
    await billingFault("checkout.afterRecover");
    const recovered = sessionId;
    const persisted = await db.transaction((tx) => repo.attachProviderSession(intent.id, recovered, {}, tx));
    if (!persisted) {
      const now = await repo.findCheckoutSessionById(intent.id);
      if (!now || now.providerSessionId !== recovered) throw inProgress(); // changed concurrently: the other request owns it
      if (now.status !== "creating" && now.status !== "open") return; // already closed by a concurrent request
    }
  }
  await settleRemoteSession(intent, sessionId, actor);
  await expireIntentLocally(intent, actor, true);
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
      // Different price: the previous remote session is closed AUTHORITATIVELY first
      // (recovered through its stable key when its id was never saved); only a proven
      // closure lets the loop insert the replacement intent.
      await closeIntent(step.intent, actor);
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

    // ── Step 4: a KNOWN provider session is resolved authoritatively — never from a
    // cached reply. (An `open` intent, or a `creating` one whose id a previous request
    // recovered before failing.)
    if (intent.providerSessionId) {
      const remote = await retrieveSession(intent, intent.providerSessionId);
      if (!remote) throw ambiguous(); // unknown at the provider: the intent stays current
      if (remote.status === "open" && remote.url) {
        if (intent.status !== "open") await db.transaction((tx) => repo.attachProviderSession(intent.id, remote.id, { status: "open", expiresAt: remote.expiresAt, providerCustomerId: customerId }, tx));
        return { url: remote.url, status: "reused" };
      }
      if (remote.status === "complete") {
        await reconcileCompletedIntent(intent, remote, actor);
        throw alreadyCompleted();
      }
      if (remote.status === "expired") {
        await expireIntentLocally(intent, actor, true); // proven closed at the provider: start over
        continue;
      }
      throw ambiguous();
    }

    // ── Step 5: provider session with the intent-derived key (outside any transaction).
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

    // ── Step 6: persist the session id (compare-and-set, intent stays non-terminal) so a
    // later request can resolve it without another replay …
    const attached = await db.transaction((tx) => repo.attachProviderSession(intent.id, session.id, { providerCustomerId: customerId }, tx));
    if (!attached) {
      const now = await repo.findCheckoutSessionById(intent.id);
      if (!now || now.providerSessionId !== session.id) throw inProgress();
      if (now.status !== "creating" && now.status !== "open") continue; // closed concurrently (proven at the provider by that request)
    }
    // … then trust ONLY the provider's current state: the creation reply may be an
    // idempotent replay of a session that has since expired or completed.
    const current = await retrieveSession(intent, session.id);
    if (!current) throw ambiguous();
    if (current.status === "complete") {
      await reconcileCompletedIntent(intent, current, actor);
      throw alreadyCompleted();
    }
    if (current.status === "expired") {
      await expireIntentLocally(intent, actor, true);
      continue;
    }
    if (current.status !== "open" || !current.url) throw ambiguous();

    // ── Step 7: link (`creating → open`). A concurrent request that linked the SAME
    // session is tolerated; anything else (closed meanwhile) must not hand out its URL.
    const linked = await db.transaction((tx) => repo.attachProviderSession(intent.id, session.id, { status: "open", expiresAt: current.expiresAt, providerCustomerId: customerId }, tx));
    if (!linked) {
      const now = await repo.findCheckoutSessionById(intent.id);
      if (!now || now.providerSessionId !== session.id || now.status !== "open") throw inProgress();
    }
    logger.info({ companyId, subscriptionId: sub.id, checkoutId: intent.id, planId: price.planId }, "Checkout session linked");
    return { url: current.url, status: "created" };
  }
  throw inProgress();
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
