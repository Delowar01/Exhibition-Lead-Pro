import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { SubscriptionRow } from "../repositories/subscriptions.repository.js";
import { getBillingProvider, BillingProviderError, type BillingProvider, type ProviderEvent, type ProviderSubscription } from "../lib/billing/provider.js";
import { normalizeProviderSubscription, normalizeProviderCheckoutSession } from "../lib/billing/stripe-provider.js";
import { applyProviderState } from "./subscription-lifecycle.service.js";
import { PROVIDER_ACTOR, writeSubscriptionAudit } from "../lib/billing/audit.js";

// Batch 20 — Stripe webhook processing.
//
//   1. signature over the UNMODIFIED raw body (official SDK) → 400 on failure
//   2. event id is unique in billing_provider_events → duplicates answer 200 with
//      no second mutation; a delivery whose earlier attempt FAILED is retried
//   3. processing is transactional: the local subscription row is locked, the
//      provider's CURRENT object is retrieved (never trusting an old payload
//      alone), stale events (older than the newest applied) are ignored, and
//      mismatched company/customer/subscription bindings change nothing
//   4. the event row's outcome is written in the same transaction as the state
//      change; a database failure rolls everything back and the handler answers
//      non-2xx so the provider retries
//   5. only sanitized metadata is persisted — never the payload
//
// Tenants are bound through server-created opaque metadata (companyId /
// subscriptionId / checkoutId) and stored unique provider ids — never by email.

export const SUPPORTED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export type WebhookOutcome = "applied" | "duplicate" | "stale" | "unbound" | "unsupported" | "mismatch" | "no_change";

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
const str = (o: Obj | undefined, k: string): string | null => (typeof o?.[k] === "string" ? (o[k] as string) : null);
const refId = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? str(v as Obj, "id") : null);
const meta = (o: Obj | undefined): Record<string, string> => {
  const m = o?.metadata;
  const out: Record<string, string> = {};
  if (m && typeof m === "object") for (const [k, v] of Object.entries(m as Obj)) if (typeof v === "string") out[k] = v;
  return out;
};
const intOrNull = (v: string | undefined): number | null => (v && /^\d{1,12}$/.test(v) ? Number(v) : null);

// Locates the local subscription for a provider object: bound provider ids first,
// then server-generated metadata. Every discovered relationship must agree.
async function resolveSubscription(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  hints: { subscriptionProviderId: string | null; customerId: string | null; metadata: Record<string, string> },
): Promise<{ sub: SubscriptionRow | null; mismatch: boolean }> {
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
  if (metaSub != null) {
    const s = await repo.findById(metaSub, tx);
    if (s) candidates.push(s);
  } else if (metaCompany != null) {
    const s = await repo.findByCompanyId(metaCompany, tx);
    if (s) candidates.push(s);
  }
  if (candidates.length === 0) return { sub: null, mismatch: false };
  const first = candidates[0];
  if (candidates.some((c) => c.id !== first.id)) return { sub: null, mismatch: true };
  if (metaCompany != null && metaCompany !== first.companyId) return { sub: null, mismatch: true };
  if (hints.customerId && first.stripeCustomerId && first.stripeCustomerId !== hints.customerId) return { sub: null, mismatch: true };
  if (hints.subscriptionProviderId && first.stripeSubscriptionId && first.stripeSubscriptionId !== hints.subscriptionProviderId) return { sub: null, mismatch: true };
  return { sub: first, mismatch: false };
}

async function retrieveOrFallback(provider: BillingProvider, id: string, payload: Obj): Promise<ProviderSubscription> {
  // Fetch the authoritative current state; fall back to the delivered object only
  // when the provider says it no longer exists (deleted subscriptions).
  const remote = await provider.retrieveSubscription(id);
  return remote ?? normalizeProviderSubscription(payload);
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

  // Fast-path duplicate check outside the transaction (the unique index is the
  // real guard inside it).
  const seen = await repo.findProviderEvent(event.id);
  if (seen && seen.status !== "failed") {
    logger.info({ eventId: event.id, eventType: event.type, outcome: "duplicate" }, "Stripe webhook duplicate delivery ignored");
    return { httpStatus: 200, outcome: "duplicate", eventId: event.id };
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // Durable idempotency record: insert (or lock the failed row for retry).
      let row = seen ? await repo.lockProviderEvent(event.id, tx) : undefined;
      if (row && row.status !== "failed") return "duplicate" as const;
      if (!row) {
        try {
          row = await repo.insertProviderEvent({ provider: provider.kind === "fake" ? "stripe" : provider.kind, eventId: event.id, eventType: event.type, providerCreatedAt: event.created, status: "received" }, tx);
        } catch (err) {
          const code = (err as { code?: string } | null)?.code;
          if (code === "23505") return "duplicate" as const; // concurrent identical delivery
          throw err;
        }
      } else {
        await repo.updateProviderEvent(row.id, { attempts: row.attempts + 1, status: "received", failureCode: null }, tx);
      }

      const finish = async (outcome: WebhookOutcome, companyId: number | null, subscriptionId: number | null) => {
        await repo.updateProviderEvent(row!.id, { status: outcome === "unsupported" || outcome === "stale" || outcome === "unbound" || outcome === "mismatch" ? "ignored" : "processed", outcome, processedAt: new Date(), companyId, subscriptionId }, tx);
        return outcome;
      };

      if (!SUPPORTED_EVENTS.has(event.type)) return finish("unsupported", null, null);
      const obj = event.object;

      if (event.type === "checkout.session.completed") {
        const session = normalizeProviderCheckoutSession(obj);
        const hints = { subscriptionProviderId: session.subscriptionId, customerId: session.customerId, metadata: session.metadata };
        const local = session.id ? await repo.findCheckoutSessionByProviderId(session.id, tx) : undefined;
        const { sub: found, mismatch } = await resolveSubscription(tx, hints);
        if (mismatch) return finish("mismatch", null, null);
        const target = found ?? (local ? await repo.findById(local.subscriptionId, tx) : undefined) ?? null;
        if (!target) return finish("unbound", null, null);
        if (local && local.subscriptionId !== target.id) return finish("mismatch", target.companyId, target.id);
        const sub = await repo.lockById(target.id, tx);
        if (!sub) return finish("unbound", null, null);
        if (session.customerId && sub.stripeCustomerId && sub.stripeCustomerId !== session.customerId) return finish("mismatch", sub.companyId, sub.id);
        if (local) await repo.updateCheckoutSession(local.id, { status: "completed", completedAt: new Date(), providerSubscriptionId: session.subscriptionId, providerCustomerId: session.customerId }, tx);
        if (!session.subscriptionId) {
          // Completed session without a subscription (should not happen in
          // subscription mode) — link the customer only, no entitlement change.
          if (session.customerId && !sub.stripeCustomerId) await repo.update(sub.id, { stripeCustomerId: session.customerId }, tx);
          return finish("no_change", sub.companyId, sub.id);
        }
        const remote = await provider.retrieveSubscription(session.subscriptionId);
        if (!remote) return finish("unbound", sub.companyId, sub.id);
        if (!sub.stripeCustomerId && session.customerId) await repo.update(sub.id, { stripeCustomerId: session.customerId }, tx);
        const locked = (await repo.findById(sub.id, tx))!;
        const result = await applyProviderState(tx, locked, remote, event.created, PROVIDER_ACTOR, { eventType: event.type, eventId: event.id });
        return finish(result.outcome, sub.companyId, sub.id);
      }

      if (event.type.startsWith("customer.subscription.")) {
        const providerSubId = str(obj, "id");
        const customerId = refId(obj.customer);
        const { sub: found, mismatch } = await resolveSubscription(tx, { subscriptionProviderId: providerSubId, customerId, metadata: meta(obj) });
        if (mismatch) return finish("mismatch", null, null);
        if (!found || !providerSubId) return finish("unbound", null, null);
        const sub = await repo.lockById(found.id, tx);
        if (!sub) return finish("unbound", null, null);
        // A different live provider subscription already bound → refuse to rebind.
        if (sub.stripeSubscriptionId && sub.stripeSubscriptionId !== providerSubId) return finish("mismatch", sub.companyId, sub.id);
        const remote = event.type === "customer.subscription.deleted" ? normalizeProviderSubscription(obj) : await retrieveOrFallback(provider, providerSubId, obj);
        const result = await applyProviderState(tx, sub, remote, event.created, PROVIDER_ACTOR, { eventType: event.type, eventId: event.id });
        return finish(result.outcome, sub.companyId, sub.id);
      }

      if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        // Invoices carry the subscription reference; the subscription object is
        // the authority for state, so re-read it from the provider.
        const providerSubId = refId(obj.subscription) ?? refId((obj.parent as Obj | undefined)?.subscription_details && (obj.parent as Obj).subscription_details && ((obj.parent as Obj).subscription_details as Obj).subscription);
        const customerId = refId(obj.customer);
        const { sub: found, mismatch } = await resolveSubscription(tx, { subscriptionProviderId: providerSubId, customerId, metadata: meta(obj) });
        if (mismatch) return finish("mismatch", null, null);
        if (!found) return finish("unbound", null, null);
        const sub = await repo.lockById(found.id, tx);
        if (!sub) return finish("unbound", null, null);
        const subId = providerSubId ?? sub.stripeSubscriptionId;
        if (!subId) return finish("unbound", sub.companyId, sub.id);
        const remote = await provider.retrieveSubscription(subId);
        if (!remote) {
          await writeSubscriptionAudit(tx, { action: `subscription.${event.type.replace(".", "_")}`, companyId: sub.companyId, subscriptionId: sub.id, before: sub, after: sub, actor: PROVIDER_ACTOR, extra: { eventType: event.type, eventId: event.id } });
          return finish("no_change", sub.companyId, sub.id);
        }
        const result = await applyProviderState(tx, sub, remote, event.created, PROVIDER_ACTOR, { eventType: event.type, eventId: event.id });
        return finish(result.outcome, sub.companyId, sub.id);
      }
      return finish("unsupported", null, null);
    });
    logger.info({ eventId: event.id, eventType: event.type, outcome }, "Stripe webhook processed");
    return { httpStatus: 200, outcome, eventId: event.id };
  } catch (err) {
    // Temporary failure (database, provider fetch): record a sanitized failure
    // code OUTSIDE the rolled-back transaction and answer 500 so Stripe retries.
    const code = err instanceof BillingProviderError ? err.code : err instanceof Error ? err.constructor.name : "Error";
    logger.error({ eventId: event.id, eventType: event.type, failureCode: code }, "Stripe webhook processing failed; provider will retry");
    try {
      const existing = await repo.findProviderEvent(event.id);
      if (existing) await repo.updateProviderEvent(existing.id, { status: "failed", failureCode: code.slice(0, 64), attempts: existing.attempts });
      else await repo.insertProviderEvent({ provider: "stripe", eventId: event.id, eventType: event.type, providerCreatedAt: event.created, status: "failed", failureCode: code.slice(0, 64) });
    } catch (recordErr) {
      logger.error({ eventId: event.id, err: recordErr instanceof Error ? recordErr.constructor.name : "Error" }, "Could not record webhook failure");
    }
    return { httpStatus: 500, outcome: "failed", eventId: event.id };
  }
}
