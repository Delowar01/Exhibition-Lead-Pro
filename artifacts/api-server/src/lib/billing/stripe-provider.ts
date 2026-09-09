import Stripe from "stripe";
import {
  BillingProviderError,
  toProviderError,
  type BillingProvider,
  type CreateCheckoutInput,
  type CreateCustomerInput,
  type CreatePortalInput,
  type ProviderCheckoutSession,
  type ProviderEvent,
  type ProviderPrice,
  type ProviderSubscription,
} from "./provider.js";

// Batch 20 — the ONLY place the official Stripe SDK is used for API calls.
// Secrets arrive through the constructor (from config) and are never logged,
// audited, returned or otherwise copied. Every SDK error is converted to a
// BillingProviderError carrying a sanitized code (class + Stripe error code,
// never the message). Raw provider responses never leave this module: callers
// receive the normalized shapes declared in provider.ts.

type Obj = Record<string, unknown>;

function str(o: Obj | null | undefined, k: string): string | null {
  const v = o?.[k];
  return typeof v === "string" ? v : null;
}
function num(o: Obj | null | undefined, k: string): number | null {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(o: Obj | null | undefined, k: string): boolean {
  return o?.[k] === true;
}
function unix(o: Obj | null | undefined, k: string): Date | null {
  const n = num(o, k);
  return n == null ? null : new Date(n * 1000);
}
// Stripe returns expandable references either as ids or as objects.
function refId(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return str(v as Obj, "id");
  return null;
}
function metadata(o: Obj | null | undefined): Record<string, string> {
  const m = o?.metadata;
  const out: Record<string, string> = {};
  if (m && typeof m === "object") {
    for (const [k, v] of Object.entries(m as Obj)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

// Normalizes a Stripe Subscription object (SDK object OR raw webhook payload
// object). Billing periods moved from the subscription to its items in newer
// Stripe API versions; both shapes are read.
export function normalizeProviderSubscription(o: Obj): ProviderSubscription {
  const items = o.items as Obj | undefined;
  const data = Array.isArray(items?.data) ? (items!.data as Obj[]) : [];
  const first = data[0];
  const price = first?.price;
  return {
    id: str(o, "id") ?? "",
    livemode: bool(o, "livemode"),
    customerId: refId(o.customer) ?? "",
    status: str(o, "status") ?? "unknown",
    priceId: refId(price),
    currentPeriodStart: unix(first, "current_period_start") ?? unix(o, "current_period_start"),
    currentPeriodEnd: unix(first, "current_period_end") ?? unix(o, "current_period_end"),
    cancelAtPeriodEnd: bool(o, "cancel_at_period_end"),
    canceledAt: unix(o, "canceled_at"),
    endedAt: unix(o, "ended_at"),
    trialStart: unix(o, "trial_start"),
    trialEnd: unix(o, "trial_end"),
    created: unix(o, "created") ?? new Date(0),
    metadata: metadata(o),
  };
}

export function normalizeProviderCheckoutSession(o: Obj): ProviderCheckoutSession {
  return {
    id: str(o, "id") ?? "",
    livemode: bool(o, "livemode"),
    url: str(o, "url"),
    status: str(o, "status"),
    customerId: refId(o.customer),
    subscriptionId: refId(o.subscription),
    clientReferenceId: str(o, "client_reference_id"),
    expiresAt: unix(o, "expires_at"),
    metadata: metadata(o),
  };
}

export function normalizeProviderPrice(o: Obj): ProviderPrice {
  const recurring = (o.recurring as Obj | null | undefined) ?? null;
  return {
    id: str(o, "id") ?? "",
    livemode: bool(o, "livemode"),
    productId: refId(o.product),
    currency: (str(o, "currency") ?? "").toLowerCase(),
    unitAmountMinor: num(o, "unit_amount"),
    recurringInterval: str(recurring, "interval"),
    recurringIntervalCount: num(recurring, "interval_count") ?? 1,
    active: bool(o, "active"),
    nickname: str(o, "nickname"),
    type: str(o, "type") === "recurring" ? "recurring" : "one_time",
  };
}

export function normalizeProviderEvent(e: Obj): ProviderEvent {
  const data = e.data as Obj | undefined;
  const object = (data?.object as Obj | undefined) ?? {};
  return {
    id: str(e, "id") ?? "",
    type: str(e, "type") ?? "",
    created: unix(e, "created") ?? new Date(0),
    livemode: bool(e, "livemode"),
    object,
  };
}

export class StripeBillingProvider implements BillingProvider {
  readonly kind = "stripe" as const;
  readonly available = true;
  readonly unavailableReason = null;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "lead-capture-pro" } });
    this.webhookSecret = webhookSecret;
  }

  async retrievePrice(priceId: string): Promise<ProviderPrice> {
    try {
      const p = await this.stripe.prices.retrieve(priceId);
      return normalizeProviderPrice(p as unknown as Obj);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
    try {
      // Name + opaque internal id only — no email or other PII is sent.
      const c = await this.stripe.customers.create(
        { name: input.companyName, metadata: { companyId: String(input.companyId) } },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: c.id };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<ProviderCheckoutSession> {
    try {
      const s = await this.stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: input.customerId,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.clientReferenceId,
          metadata: input.metadata,
          subscription_data: { metadata: input.metadata },
          automatic_tax: { enabled: input.automaticTax },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return normalizeProviderCheckoutSession(s as unknown as Obj);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession | null> {
    try {
      const s = await this.stripe.checkout.sessions.retrieve(sessionId);
      return normalizeProviderCheckoutSession(s as unknown as Obj);
    } catch (err) {
      const e = toProviderError(err);
      if (e.providerStatus === 404) return null;
      throw e;
    }
  }

  async expireCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession> {
    try {
      const s = await this.stripe.checkout.sessions.expire(sessionId);
      return normalizeProviderCheckoutSession(s as unknown as Obj);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async createPortalSession(input: CreatePortalInput): Promise<{ url: string }> {
    try {
      const s = await this.stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
        ...(input.configurationId ? { configuration: input.configurationId } : {}),
      });
      return { url: s.url };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    try {
      const s = await this.stripe.subscriptions.retrieve(subscriptionId);
      return normalizeProviderSubscription(s as unknown as Obj);
    } catch (err) {
      const e = toProviderError(err);
      if (e.providerStatus === 404) return null;
      throw e;
    }
  }

  constructEvent(rawBody: Buffer, signatureHeader: string | undefined): ProviderEvent {
    if (!signatureHeader) throw new BillingProviderError("SIGNATURE_MISSING");
    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
      return normalizeProviderEvent(event as unknown as Obj);
    } catch {
      throw new BillingProviderError("SIGNATURE_INVALID");
    }
  }
}
