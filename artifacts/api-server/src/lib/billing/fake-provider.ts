import { createHash } from "node:crypto";
import Stripe from "stripe";
import {
  BillingProviderError,
  type BillingProvider,
  type CreateCheckoutInput,
  type CreateCustomerInput,
  type CreatePortalInput,
  type ProviderCheckoutSession,
  type ProviderEvent,
  type ProviderPrice,
  type ProviderSubscription,
} from "./provider.js";
import { normalizeProviderCheckoutSession, normalizeProviderEvent, normalizeProviderSubscription } from "./stripe-provider.js";

// Batch 20 — deterministic FAKE provider for automated tests and local
// development. NEVER selectable in production (config guard). No network:
//   • prices are synthesized from the id itself:  price_fake_<currency>_<minor>_<interval>
//     (e.g. price_fake_usd_2900_month); any other id is "resource_missing".
//   • one customer per company (cus_fake_<companyId>) — creating it twice is idempotent.
//   • a Checkout session is derived from the idempotency key (same key → same session).
//   • webhook signatures are verified with the OFFICIAL Stripe SDK against the
//     configured webhook secret, exactly like the real provider. Every verified
//     subscription / checkout object is remembered (newest `created` wins) so a later
//     retrieveSubscription() returns the provider's most recent state — which is how
//     out-of-order deliveries are exercised without a network.

type Obj = Record<string, unknown>;

const PRICE_RE = /^price_fake_([a-z]{3})_(\d{1,9})_(month|year|week|day)$/;

export class FakeBillingProvider implements BillingProvider {
  readonly kind = "fake" as const;
  readonly available = true;
  readonly unavailableReason = null;
  private readonly signer: Stripe;
  private readonly webhookSecret: string;
  private readonly subscriptions = new Map<string, { created: number; object: Obj }>();
  private readonly checkoutSessions = new Map<string, ProviderCheckoutSession>();
  private failNext: string | null = null;

  constructor(webhookSecret: string) {
    // Placeholder key: used only for the SDK's offline webhook-signature helpers.
    this.signer = new Stripe("sk_test_fake_provider_placeholder", { maxNetworkRetries: 0 });
    this.webhookSecret = webhookSecret;
  }

  // Test hook: the next provider call fails with the given sanitized code.
  __failNextCall(code: string | null): void {
    this.failNext = code;
  }
  private maybeFail(): void {
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      throw new BillingProviderError(code, { providerStatus: 503, retryable: true });
    }
  }

  async retrievePrice(priceId: string): Promise<ProviderPrice> {
    this.maybeFail();
    const m = priceId.match(PRICE_RE);
    if (!m) throw new BillingProviderError("StripeInvalidRequestError:resource_missing", { providerStatus: 404 });
    return {
      id: priceId,
      productId: `prod_fake_${m[1]}`,
      currency: m[1],
      unitAmountMinor: Number(m[2]),
      recurringInterval: m[3],
      recurringIntervalCount: 1,
      active: true,
      nickname: null,
      type: "recurring",
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
    this.maybeFail();
    return { id: `cus_fake_${input.companyId}` };
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<ProviderCheckoutSession> {
    this.maybeFail();
    const id = `cs_fake_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`;
    const existing = this.checkoutSessions.get(id);
    if (existing) return existing;
    const session: ProviderCheckoutSession = {
      id,
      url: `https://checkout.fake.local/c/${id}`,
      status: "open",
      customerId: input.customerId,
      subscriptionId: null,
      clientReferenceId: input.clientReferenceId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      metadata: { ...input.metadata },
    };
    this.checkoutSessions.set(id, session);
    return session;
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession | null> {
    this.maybeFail();
    return this.checkoutSessions.get(sessionId) ?? null;
  }

  async createPortalSession(input: CreatePortalInput): Promise<{ url: string }> {
    this.maybeFail();
    return { url: `https://billing.fake.local/p/${input.customerId}` };
  }

  async retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    this.maybeFail();
    const rec = this.subscriptions.get(subscriptionId);
    return rec ? normalizeProviderSubscription(rec.object) : null;
  }

  // Remembers the newest version of a provider object (by event `created`).
  recordObject(objectType: string, object: Obj, created: number): void {
    const id = typeof object.id === "string" ? object.id : null;
    if (!id) return;
    if (objectType === "subscription") {
      const prev = this.subscriptions.get(id);
      if (!prev || prev.created <= created) this.subscriptions.set(id, { created, object });
    } else if (objectType === "checkout.session") {
      const s = normalizeProviderCheckoutSession(object);
      const prev = this.checkoutSessions.get(id);
      this.checkoutSessions.set(id, { ...(prev ?? s), ...s, url: prev?.url ?? s.url });
    }
  }

  constructEvent(rawBody: Buffer, signatureHeader: string | undefined): ProviderEvent {
    if (!signatureHeader) throw new BillingProviderError("SIGNATURE_MISSING");
    let raw: Obj;
    try {
      raw = this.signer.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret) as unknown as Obj;
    } catch {
      throw new BillingProviderError("SIGNATURE_INVALID");
    }
    const event = normalizeProviderEvent(raw);
    const objectType = typeof event.object.object === "string" ? (event.object.object as string) : "";
    this.recordObject(objectType, event.object, event.created.getTime() / 1000);
    return event;
  }

  // Test helper: produce a valid `Stripe-Signature` header for a payload (same
  // scheme the real provider verifies).
  signPayload(payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
    return this.signer.webhooks.generateTestHeaderString({ payload, secret: this.webhookSecret, timestamp });
  }
}

// Shared helper for tests that sign synthetic fixtures without an instance.
export function signFakeWebhookPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const s = new Stripe("sk_test_fake_provider_placeholder", { maxNetworkRetries: 0 });
  return s.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}
