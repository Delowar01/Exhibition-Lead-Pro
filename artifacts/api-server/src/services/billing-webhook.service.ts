import { db } from "@workspace/db";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow, CheckoutSessionRow } from "../repositories/subscriptions.repository.js";
import { getBillingProvider, BillingProviderError, type BillingProvider, type ProviderEvent, type ProviderSubscription, type ProviderCheckoutSession } from "../lib/billing/provider.js";
import { normalizeProviderSubscription, normalizeProviderCheckoutSession } from "../lib/billing/stripe-provider.js";
import { applyProviderState, ProviderPriceUnmappedError, type ProviderLinkage, ProviderModeMismatchError } from "./subscription-lifecycle.service.js";
import { PROVIDER_ACTOR, writeSubscriptionAudit } from "../lib/billing/audit.js";
import { billingFault } from "../lib/billing/test-faults.js";

// Batch 20 (+ Correction 1) — Stripe webhook processing.
//
//   1. signature over the UNMODIFIED raw body (official SDK) → 400 on failure;
//      the event's livemode must equal the configured Stripe mode → 400
//      LIVEMODE_MISMATCH (deterministic, non-mutating, not recorded).
//   2. fast duplicate check (read only).
//   3. every provider fetch the event needs happens HERE, OUTSIDE any database
//      transaction or row lock (no network wait while holding locks).
//   4. one short transaction: the event row is CLAIMED with
//      INSERT … ON CONFLICT (event_id) DO NOTHING (never a raw 23505 inside the
//      transaction); an existing row is locked and processed only when it is
//      `failed` (retry) — otherwise `duplicate`. The canonical subscription is
//      locked, the state applied and the event outcome written atomically.
//   5. a failure rolls everything back; the failure is recorded OUTSIDE the
//      transaction with a CONDITIONAL upsert that only creates a `failed` row or
//      bumps an already-`failed` one (a concurrently processed / ignored row is
//      never downgraded); the handler answers 500 so Stripe retries.
//   6. only sanitized metadata is persisted — never the payload.
//
// Tenants are bound through server-generated metadata (companyId /
// subscriptionId / checkoutId), local Checkout intents and stored unique provider
// ids — never by email, never by customer id alone.

export const SUPPORTED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export type WebhookOutcome = "applied" | "duplicate" | "stale" | "unbound" | "unsupported" | "mismatch" | "no_change" | "conflict";

export interface WebhookResult {
  httpStatus: number;
  outcome: WebhookOutcome | "failed";
  eventId: string;
}

export class WebhookRejected extends Error {
  constructor(readonly httpStatus: number, readonly code: string) {
    super(code);
    this.name = "WebhookRejected";
  }
}

type Obj = Record<string, unknown>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const str = (o: Obj | undefined, k: string): string | null => (typeof o?.[k] === "string" ? (o[k] as string) : null);
const refId = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? str(v as Obj, "id") : null);
const meta = (o: Obj | undefined): Record<string, string> => {
  const m = o?.metadata;
  const out: Record<string, string> = {};
  if (m && typeof m === "object") for (const [k, v] of Object.entries(m as Obj)) if (typeof v === "string") out[k] = v;
  return out;
};
const intOrNull = (v: string | undefined): number | null => (v && /^\d{1,12}$/.test(v) ? Number(v) : null);
const IGNORED: ReadonlySet<string> = new Set(["unsupported", "stale", "unbound", "mismatch", "conflict"]);

interface Hints {
  subscriptionProviderId: string | null;
  customerId: string | null;
  metadata: Record<string, string>;
  localCheckout?: CheckoutSessionRow | null;
}

// Locates the local subscription for a provider object: bound provider ids first,
// then server-generated metadata / the local Checkout intent. Every discovered
// relationship must agree on the SAME row (customer and company included);
// whether a differing bound subscription id is a replacement, a conflict or a
// late event is decided by applyProviderState.
async function resolveSubscription(tx: Tx, hints: Hints): Promise<{ sub: SubscriptionRow | null; mismatch: boolean }> {
  const candidates: SubscriptionRow[] = [];
  if (hints.subscriptionProviderId) {
    const s = await repo.findByStripeSubscriptionId(hints.subscriptionProviderId, tx);
    if (s) candidates.push(s);
  }
  if (hints.customerId) {
    const s = await repo.findByStripeCustomerId(hints.customerId, tx);
    if (s) candidates.push(s);
  }
  const metaCompany = intOrNull(hints.metadata.companyId);
  const metaSub = intOrNull(hints.metadata.subscriptionId);
  const metaCheckout = intOrNull(hints.metadata.checkoutId);
  if (metaSub != null) {
    const s = await repo.findById(metaSub, tx);
    if (s) candidates.push(s);
  } else if (metaCompany != null) {
    const s = await repo.findByCompanyId(metaCompany, tx);
    if (s) candidates.push(s);
  }
  const localCheckout = hints.localCheckout ?? (metaCheckout != null ? await repo.findCheckoutSessionById(metaCheckout, tx) : undefined);
  if (localCheckout) {
    const s = await repo.findById(localCheckout.subscriptionId, tx);
    if (s) candidates.push(s);
  }
  if (candidates.length === 0) return { sub: null, mismatch: false };
  const first = candidates[0];
  if (candidates.some((c) => c.id !== first.id)) return { sub: null, mismatch: true };
  if (metaCompany != null && metaCompany !== first.companyId) return { sub: null, mismatch: true };
  if (localCheckout && localCheckout.companyId !== first.companyId) return { sub: null, mismatch: true };
  if (hints.customerId && first.stripeCustomerId && first.stripeCustomerId !== hints.customerId) return { sub: null, mismatch: true };
  return { sub: first, mismatch: false };
}

// Everything the event needs from the provider, fetched BEFORE the transaction.
interface Prefetch {
  session?: ProviderCheckoutSession;
  remote?: ProviderSubscription | null;
  providerSubId?: string | null;
}

async function prefetchProviderState(provider: BillingProvider, event: ProviderEvent): Promise<Prefetch> {
  const obj = event.object;
  if (event.type === "checkout.session.completed") {
    const session = normalizeProviderCheckoutSession(obj);
    const remote = session.subscriptionId ? await provider.retrieveSubscription(session.subscriptionId) : null;
    return { session, remote, providerSubId: session.subscriptionId };
  }
  if (event.type === "customer.subscription.deleted") {
    // The provider no longer holds it: the delivered object is the final state.
    return { remote: normalizeProviderSubscription(obj), providerSubId: str(obj, "id") };
  }
  if (event.type.startsWith("customer.subscription.")) {
    const id = str(obj, "id");
    const remote = id ? ((await provider.retrieveSubscription(id)) ?? normalizeProviderSubscription(obj)) : null;
    return { remote, providerSubId: id };
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const parent = obj.parent as Obj | undefined;
    const details = parent?.subscription_details as Obj | undefined;
    const providerSubId = refId(obj.subscription) ?? refId(details?.subscription);
    const remote = providerSubId ? await provider.retrieveSubscription(providerSubId) : null;
    return { remote, providerSubId };
  }
  return {};
}

function failureCodeOf(err: unknown): string {
  if (err instanceof ProviderPriceUnmappedError) return err.code;
  if (err instanceof ProviderModeMismatchError) return err.code;
  if (err instanceof BillingProviderError) return err.code;
  if (err instanceof Error) return err.constructor.name;
  return "Error";
}

type FailureScope = { companyId: number; subscriptionId: number } | null;

async function recordFailure(event: ProviderEvent, providerMode: string, err: unknown, scope: FailureScope = null): Promise<void> {
  const code = failureCodeOf(err).slice(0, 64);
  logger.error({ eventId: event.id, eventType: event.type, failureCode: code, companyId: scope?.companyId ?? null }, "Stripe webhook processing failed; provider will retry");
  try {
    await repo.recordProviderEventFailure({
      provider: "stripe",
      providerMode,
      eventId: event.id,
      eventType: event.type,
      providerCreatedAt: event.created,
      failureCode: code,
      outcome: err instanceof ProviderPriceUnmappedError ? "price_unmapped" : null,
      companyId: scope?.companyId ?? null,
      subscriptionId: scope?.subscriptionId ?? null,
    });
  } catch (recordErr) {
    logger.error({ eventId: event.id, err: recordErr instanceof Error ? recordErr.constructor.name : "Error" }, "Could not record webhook failure");
  }
}

export async function processStripeWebhook(rawBody: Buffer, signature: string | undefined, provider: BillingProvider = getBillingProvider()): Promise<WebhookResult> {
  if (!provider.available) throw new WebhookRejected(503, "PROVIDER_UNAVAILABLE");
  let event: ProviderEvent;
  try {
    event = provider.constructEvent(rawBody, signature);
  } catch (err) {
    const code = err instanceof BillingProviderError ? err.code : "SIGNATURE_INVALID";
    throw new WebhookRejected(400, code);
  }
  if (!event.id || !event.type) throw new WebhookRejected(400, "EVENT_MALFORMED");

  // B20 Correction 1 — explicit mode enforcement: an event from the other Stripe
  // mode is rejected deterministically, mutates nothing and is not recorded.
  const expectedLive = (config.billing.stripeMode ?? "test") === "live";
  const objectLivemode = typeof event.object.livemode === "boolean" ? (event.object.livemode as boolean) : null;
  if (event.livemode !== expectedLive || (objectLivemode != null && objectLivemode !== expectedLive)) {
    logger.warn({ eventId: event.id, eventType: event.type, eventLivemode: event.livemode, expectedLive }, "Stripe webhook rejected: livemode does not match the configured mode");
    throw new WebhookRejected(400, "LIVEMODE_MISMATCH");
  }
  const providerMode = expectedLive ? "live" : "test";

  // Fast-path duplicate check (read only; the durable claim below is the real guard).
  const seen = await repo.findProviderEvent(event.id);
  if (seen && seen.status !== "failed") {
    logger.info({ eventId: event.id, eventType: event.type, outcome: "duplicate" }, "Stripe webhook duplicate delivery ignored");
    return { httpStatus: 200, outcome: "duplicate", eventId: event.id };
  }

  // Provider state, OUTSIDE any transaction / lock.
  let pre: Prefetch;
  try {
    pre = SUPPORTED_EVENTS.has(event.type) ? await prefetchProviderState(provider, event) : {};
  } catch (err) {
    await recordFailure(event, providerMode, err);
    return { httpStatus: 500, outcome: "failed", eventId: event.id };
  }
  await billingFault("webhook.beforeClaim");

  // Tenant scope resolved inside the transaction — kept for the failure record
  // (platform diagnostics such as an unregistered price are per company).
  let scope: FailureScope = null;
  try {
    const outcome = await db.transaction(async (tx) => {
      // Durable, race-safe claim.
      let row = await repo.claimProviderEvent({ provider: "stripe", providerMode, eventId: event.id, eventType: event.type, providerCreatedAt: event.created, status: "received", attempts: 1 }, tx);
      if (!row) {
        const existing = await repo.lockProviderEvent(event.id, tx);
        if (!existing) throw new Error("ProviderEventClaimLost");
        if (existing.status !== "failed") return "duplicate" as const;
        await repo.updateProviderEvent(existing.id, { attempts: existing.attempts + 1, status: "received", failureCode: null }, tx);
        row = { ...existing, attempts: existing.attempts + 1 };
      }
      const claimed = row;
      const finish = async (outcome: WebhookOutcome, companyId: number | null, subscriptionId: number | null) => {
        await repo.updateProviderEvent(claimed.id, { status: IGNORED.has(outcome) ? "ignored" : "processed", outcome, processedAt: new Date(), companyId, subscriptionId, failureCode: null }, tx);
        await billingFault("webhook.beforeCommit");
        return outcome;
      };
      const conflict = async (sub: SubscriptionRow, providerSubId: string | null) => {
        await writeSubscriptionAudit(tx, { action: "subscription.provider_conflict", companyId: sub.companyId, subscriptionId: sub.id, before: sub, after: sub, actor: PROVIDER_ACTOR, extra: { eventType: event.type, eventId: event.id, providerSubscriptionRef: mask(providerSubId) } });
        logger.error({ companyId: sub.companyId, subscriptionId: sub.id, eventId: event.id }, "Two live provider subscriptions for one company — recorded as a conflict");
        return finish("conflict", sub.companyId, sub.id);
      };

      if (!SUPPORTED_EVENTS.has(event.type)) return finish("unsupported", null, null);
      const obj = event.object;

      if (event.type === "checkout.session.completed") {
        const session = pre.session!;
        // B20 Correction 2 — locate the local intent by its recorded provider session
        // id, or (crash before the id was saved) by a VALIDATED checkout id: metadata
        // `checkoutId` and `client_reference_id` must agree, the intent must be
        // non-terminal, carry no other session, and match customer + mode; the session
        // id is then attached atomically before completion. Any disagreement → mismatch.
        const metaCheckout = intOrNull(session.metadata.checkoutId);
        const refCheckout = intOrNull(session.clientReferenceId ?? undefined);
        if (metaCheckout != null && refCheckout != null && metaCheckout !== refCheckout) return finish("mismatch", null, null);
        const checkoutId = metaCheckout ?? refCheckout;
        let local = session.id ? await repo.findCheckoutSessionByProviderId(session.id, tx) : undefined;
        let candidate: CheckoutSessionRow | undefined;
        if (!local && session.id && checkoutId != null) {
          candidate = await repo.findCheckoutSessionById(checkoutId, tx);
          if (candidate) {
            const nonTerminal = candidate.status === "creating" || candidate.status === "open";
            const sameCustomer = !session.customerId || !candidate.providerCustomerId || candidate.providerCustomerId === session.customerId;
            if (!nonTerminal || candidate.providerSessionId || !sameCustomer || candidate.providerMode !== providerMode) return finish("mismatch", null, null);
          }
        }
        if (local && checkoutId != null && local.id !== checkoutId) return finish("mismatch", null, null);
        const { sub: found, mismatch } = await resolveSubscription(tx, { subscriptionProviderId: session.subscriptionId, customerId: session.customerId, metadata: session.metadata, localCheckout: local ?? candidate ?? null });
        if (mismatch) return finish("mismatch", null, null);
        if (!found) return finish("unbound", null, null);
        const sub = await repo.lockById(found.id, tx);
        if (!sub) return finish("unbound", null, null);
        scope = { companyId: sub.companyId, subscriptionId: sub.id };
        if (session.customerId && sub.stripeCustomerId && sub.stripeCustomerId !== session.customerId) return finish("mismatch", sub.companyId, sub.id);
        if (!local && candidate && session.id) {
          // The session id is attached ONLY after the resolved tenant is proven to own the
          // candidate intent (company + canonical subscription + customer agree).
          if (candidate.companyId !== sub.companyId || candidate.subscriptionId !== sub.id) return finish("mismatch", sub.companyId, sub.id);
          local = await repo.attachProviderSession(candidate.id, session.id, {}, tx);
          if (!local) return finish("mismatch", sub.companyId, sub.id);
        }
        let completed: CheckoutSessionRow | null = local ?? null;
        if (local) {
          completed = (await repo.transitionCheckoutSession(local.id, ["creating", "open"], { status: "completed", completedAt: new Date(), providerSubscriptionId: session.subscriptionId, providerCustomerId: session.customerId ?? local.providerCustomerId }, tx)) ?? local;
          if (completed.status === "completed" && !completed.providerSubscriptionId && session.subscriptionId) {
            await repo.updateCheckoutSession(local.id, { providerSubscriptionId: session.subscriptionId }, tx);
            completed = { ...completed, providerSubscriptionId: session.subscriptionId };
          }
        }
        if (!sub.stripeCustomerId && session.customerId) await repo.update(sub.id, { stripeCustomerId: session.customerId }, tx);
        if (!session.subscriptionId) return finish("no_change", sub.companyId, sub.id); // no subscription in this session
        if (!pre.remote) return finish("unbound", sub.companyId, sub.id); // provider does not (yet) hold the subscription
        const locked = (await repo.findById(sub.id, tx))!;
        const result = await applyProviderState(tx, locked, pre.remote, event.created, PROVIDER_ACTOR, { eventType: event.type, eventId: event.id }, { checkoutId: local?.id ?? null, completedCheckout: completed, sessionId: session.id });
        if (result.outcome === "conflict") return conflict(locked, session.subscriptionId);
        return finish(result.outcome, sub.companyId, sub.id);
      }

      if (event.type.startsWith("customer.subscription.")) {
        const providerSubId = pre.providerSubId ?? str(obj, "id");
        const customerId = refId(obj.customer);
        const { sub: found, mismatch } = await resolveSubscription(tx, { subscriptionProviderId: providerSubId, customerId, metadata: meta(obj) });
        if (mismatch) return finish("mismatch", null, null);
        if (!found || !providerSubId || !pre.remote) return finish("unbound", null, null);
        const sub = await repo.lockById(found.id, tx);
        if (!sub) return finish("unbound", null, null);
        scope = { companyId: sub.companyId, subscriptionId: sub.id };
        const result = await applyProviderState(tx, sub, pre.remote, event.created, PROVIDER_ACTOR, { eventType: event.type, eventId: event.id });
        if (result.outcome === "conflict") return conflict(sub, providerSubId);
        return finish(result.outcome, sub.companyId, sub.id);
      }

      if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        const customerId = refId(obj.customer);
        const { sub: found, mismatch } = await resolveSubscription(tx, { subscriptionProviderId: pre.providerSubId ?? null, customerId, metadata: meta(obj) });
        if (mismatch) return finish("mismatch", null, null);
        if (!found) return finish("unbound", null, null);
        const sub = await repo.lockById(found.id, tx);
        if (!sub) return finish("unbound", null, null);
        scope = { companyId: sub.companyId, subscriptionId: sub.id };
        if (!pre.providerSubId && !sub.stripeSubscriptionId) return finish("unbound", sub.companyId, sub.id);
        if (!pre.remote) {
          await writeSubscriptionAudit(tx, { action: `subscription.${event.type.replace(".", "_")}`, companyId: sub.companyId, subscriptionId: sub.id, before: sub, after: sub, actor: PROVIDER_ACTOR, extra: { eventType: event.type, eventId: event.id } });
          return finish("no_change", sub.companyId, sub.id);
        }
        const result = await applyProviderState(tx, sub, pre.remote, event.created, PROVIDER_ACTOR, { eventType: event.type, eventId: event.id });
        if (result.outcome === "conflict") return conflict(sub, pre.providerSubId ?? null);
        return finish(result.outcome, sub.companyId, sub.id);
      }
      return finish("unsupported", null, null);
    });
    logger.info({ eventId: event.id, eventType: event.type, outcome }, "Stripe webhook processed");
    return { httpStatus: 200, outcome, eventId: event.id };
  } catch (err) {
    // Temporary failure (database, unknown price …): the transaction rolled back;
    // record a sanitized failure OUTSIDE it (conditional) and answer 500 so Stripe retries.
    await recordFailure(event, providerMode, err, scope);
    return { httpStatus: 500, outcome: "failed", eventId: event.id };
  }
}

function mask(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 6 ? "…" : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export type { ProviderLinkage };
