// Batch 20 — billing provider boundary. The application talks to a payment
// provider ONLY through this small interface. Implementations:
//   StripeBillingProvider      official Stripe SDK (lib/billing/stripe-provider.ts)
//   FakeBillingProvider        deterministic in-memory provider for tests (never in production)
//   UnavailableBillingProvider fail-closed stand-in when nothing is configured
// Selection is decided once from config (resolveBillingProviderSelection) and
// can be overridden in-process by tests via __setBillingProviderForTests.
//
// Nothing here ever logs, audits or returns a secret key, a webhook secret, a
// raw provider response or a full webhook body.
import { config } from "../../config.js";
import { logger } from "../logger.js";

export type ProviderKind = "stripe" | "fake" | "unavailable";

export interface ProviderPrice {
  id: string;
  productId: string | null;
  currency: string; // lowercase ISO-4217 as the provider reports it
  unitAmountMinor: number | null;
  recurringInterval: string | null; // month | year | week | day
  recurringIntervalCount: number;
  active: boolean;
  nickname: string | null;
  type: "recurring" | "one_time";
}

export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: string; // raw provider status
  priceId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  trialStart: Date | null;
  trialEnd: Date | null;
  created: Date;
  metadata: Record<string, string>;
}

export interface ProviderCheckoutSession {
  id: string;
  url: string | null;
  status: string | null; // open | complete | expired
  customerId: string | null;
  subscriptionId: string | null;
  clientReferenceId: string | null;
  expiresAt: Date | null;
  metadata: Record<string, string>;
}

export interface ProviderEvent {
  id: string;
  type: string;
  created: Date;
  livemode: boolean;
  // The event's primary object (already parsed). Consumers read only the fields
  // they need and never persist it.
  object: Record<string, unknown>;
}

export interface CreateCustomerInput {
  companyId: number;
  companyName: string;
  idempotencyKey: string;
}

export interface CreateCheckoutInput {
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  metadata: Record<string, string>; // opaque internal ids only
  idempotencyKey: string;
  automaticTax: boolean;
}

export interface CreatePortalInput {
  customerId: string;
  returnUrl: string;
  configurationId?: string;
}

export class BillingProviderError extends Error {
  readonly code: string; // sanitized: provider error class / status, never the message
  readonly providerStatus: number | null;
  readonly retryable: boolean;
  constructor(code: string, opts: { providerStatus?: number | null; retryable?: boolean } = {}) {
    super(`Billing provider error (${code})`);
    this.name = "BillingProviderError";
    this.code = code;
    this.providerStatus = opts.providerStatus ?? null;
    this.retryable = opts.retryable ?? false;
    Object.setPrototypeOf(this, BillingProviderError.prototype);
  }
}

export interface BillingProvider {
  readonly kind: ProviderKind;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  retrievePrice(priceId: string): Promise<ProviderPrice>;
  createCustomer(input: CreateCustomerInput): Promise<{ id: string }>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<ProviderCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession | null>;
  createPortalSession(input: CreatePortalInput): Promise<{ url: string }>;
  retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;
  // Verifies the signature over the UNMODIFIED raw body and parses the event.
  // Throws BillingProviderError("SIGNATURE_INVALID") on any verification failure.
  constructEvent(rawBody: Buffer, signatureHeader: string | undefined): ProviderEvent;
}

export class UnavailableBillingProvider implements BillingProvider {
  readonly kind = "unavailable" as const;
  readonly available = false;
  constructor(readonly unavailableReason: string) {}
  private deny(): never {
    throw new BillingProviderError("PROVIDER_UNAVAILABLE", { providerStatus: null, retryable: false });
  }
  retrievePrice(): Promise<ProviderPrice> {
    return Promise.reject(new BillingProviderError("PROVIDER_UNAVAILABLE"));
  }
  createCustomer(): Promise<{ id: string }> {
    return Promise.reject(new BillingProviderError("PROVIDER_UNAVAILABLE"));
  }
  createCheckoutSession(): Promise<ProviderCheckoutSession> {
    return Promise.reject(new BillingProviderError("PROVIDER_UNAVAILABLE"));
  }
  retrieveCheckoutSession(): Promise<ProviderCheckoutSession | null> {
    return Promise.reject(new BillingProviderError("PROVIDER_UNAVAILABLE"));
  }
  createPortalSession(): Promise<{ url: string }> {
    return Promise.reject(new BillingProviderError("PROVIDER_UNAVAILABLE"));
  }
  retrieveSubscription(): Promise<ProviderSubscription | null> {
    return Promise.reject(new BillingProviderError("PROVIDER_UNAVAILABLE"));
  }
  constructEvent(): ProviderEvent {
    return this.deny();
  }
}

let instance: BillingProvider | null = null;
let testOverride: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (testOverride) return testOverride;
  if (instance) return instance;
  const sel = config.billing.providerSelection;
  switch (sel.kind) {
    case "stripe": {
      // Lazy import keeps the SDK out of the boot path when billing is not configured.
      const { StripeBillingProvider } = requireStripeProvider();
      instance = new StripeBillingProvider(config.billing.stripeSecretKey as string, config.billing.stripeWebhookSecret as string);
      logger.info({ provider: "stripe" }, "Billing provider selected");
      break;
    }
    case "fake": {
      const { FakeBillingProvider } = requireFakeProvider();
      instance = new FakeBillingProvider(config.billing.stripeWebhookSecret as string);
      logger.warn({ provider: "fake" }, "Billing provider selected: deterministic FAKE provider (non-production only)");
      break;
    }
    default:
      instance = new UnavailableBillingProvider(sel.reason ?? "NOT_CONFIGURED");
      logger.info({ provider: "unavailable", reason: sel.reason }, "Billing provider not configured — manual billing only");
  }
  return instance;
}

// Tests inject a provider without touching config; `null` restores the configured one.
export function __setBillingProviderForTests(p: BillingProvider | null): void {
  testOverride = p;
}

// Resolved through static imports so the bundler includes both implementations;
// the indirection only keeps this module free of a top-level Stripe import cycle.
import * as stripeProviderModule from "./stripe-provider.js";
import * as fakeProviderModule from "./fake-provider.js";
function requireStripeProvider() {
  return stripeProviderModule;
}
function requireFakeProvider() {
  return fakeProviderModule;
}

// Maps any thrown provider error to a BillingProviderError with a sanitized code.
export function toProviderError(err: unknown): BillingProviderError {
  if (err instanceof BillingProviderError) return err;
  const e = err as { type?: unknown; code?: unknown; statusCode?: unknown; rawType?: unknown } | null;
  const type = typeof e?.type === "string" ? e.type : e instanceof Error ? e.constructor.name : "Error";
  const status = typeof e?.statusCode === "number" ? e.statusCode : null;
  const code = typeof e?.code === "string" && e.code.length <= 64 ? `${type}:${e.code}` : type;
  // Rate limits, connection problems and 5xx are retryable; validation/auth errors are not.
  const retryable = type === "StripeConnectionError" || type === "StripeAPIError" || type === "StripeRateLimitError" || (status != null && status >= 500);
  return new BillingProviderError(code.replace(/[^A-Za-z0-9_:.-]/g, "_"), { providerStatus: status, retryable });
}
