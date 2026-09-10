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
//     (e.g. price_fake_usd_2900_month); `price_fake_live_…` synthesizes a LIVE-mode price
//     (mode-mismatch tests); any other id is "resource_missing".
//   • one customer per company (cus_fake_<companyId>) — creating it twice is idempotent
//     (the idempotency key → customer id is remembered, like the real provider).
//   • a Checkout session is derived from the idempotency key (same key → same session);
//     the remote session registry can be inspected, expired and counted by tests
//     (B20 Correction 1: provider-side expiration is a real state change here).
//   • B20 Correction 2 — idempotency fidelity: the same key with IDENTICAL parameters
//     replays the ORIGINAL creation response (as Stripe does — a replay never reflects
//     a later expiration/completion; callers must retrieve to learn the current state);
//     the same key with DIFFERENT parameters is a deterministic sanitized idempotency
//     error. Current and peak open-session counts are inspectable.
//   • webhook signatures are verified with the OFFICIAL Stripe SDK against the
//     configured webhook secret, exactly like the real provider. Every verified
//     subscription / checkout object is remembered (newest `created` wins) so a later
//     retrieveSubscription() returns the provider's most recent state — which is how
//     out-of-order deliveries are exercised without a network.
//   • every object it produces is TEST mode (livemode=false).

type Obj = Record<string, unknown>;

// Deterministic serialization (keys sorted at EVERY level) for parameter fingerprints.
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Obj;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const PRICE_RE = /^price_fake_(live_)?([a-z]{3})_(\d{1,9})_(month|year|week|day)$/;

export type FakeProviderMethod =
  | "retrievePrice"
  | "createCustomer"
  | "createCheckoutSession"
  | "retrieveCheckoutSession"
  | "expireCheckoutSession"
  | "createPortalSession"
  | "retrieveSubscription";

export class FakeBillingProvider implements BillingProvider {
  readonly kind = "fake" as const;
  readonly available = true;
  readonly unavailableReason = null;
  private readonly signer: Stripe;
  private readonly webhookSecret: string;
  private readonly subscriptions = new Map<string, { created: number; object: Obj }>();
  private readonly checkoutSessions = new Map<string, ProviderCheckoutSession>();
  // idempotency key → { parameter fingerprint, original response snapshot }
  private readonly checkoutByKey = new Map<string, { fingerprint: string; response: ProviderCheckoutSession }>();
  private readonly customersByKey = new Map<string, string>();
  private readonly peakOpen = new Map<string, number>(); // customer id ("*" = all) → high-water mark
  private failNext: { code: string; method: FakeProviderMethod | null } | null = null;
  private observer: ((method: FakeProviderMethod) => void) | null = null;
  // Inspectable counters (tests): how many times each remote operation ran.
  readonly calls: Record<FakeProviderMethod, number> = {
    retrievePrice: 0,
    createCustomer: 0,
    createCheckoutSession: 0,
    retrieveCheckoutSession: 0,
    expireCheckoutSession: 0,
    createPortalSession: 0,
    retrieveSubscription: 0,
  };

  constructor(webhookSecret: string) {
    // Placeholder key: used only for the SDK's offline webhook-signature helpers.
    this.signer = new Stripe("sk_test_fake_provider_placeholder", { maxNetworkRetries: 0 });
    this.webhookSecret = webhookSecret;
  }

  // Test hook: the next provider call (optionally only the named method) fails
  // with the given sanitized code. `null` clears it.
  __failNextCall(code: string | null, method: FakeProviderMethod | null = null): void {
    this.failNext = code ? { code, method } : null;
  }
  // Test hook: observe every remote call (e.g. to prove none runs inside a transaction).
  __setCallObserverForTests(fn: ((method: FakeProviderMethod) => void) | null): void {
    this.observer = fn;
  }
  private maybeFail(method: FakeProviderMethod): void {
    this.calls[method] += 1;
    this.observer?.(method);
    if (this.failNext && (this.failNext.method === null || this.failNext.method === method)) {
      const code = this.failNext.code;
      this.failNext = null;
      throw new BillingProviderError(code, { providerStatus: 503, retryable: true });
    }
  }

  // ── inspection helpers (tests) ────────────────────────────────────────────
  remoteSessions(): ProviderCheckoutSession[] {
    return [...this.checkoutSessions.values()];
  }
  remoteSession(id: string): ProviderCheckoutSession | undefined {
    return this.checkoutSessions.get(id);
  }
  remoteOpenSessionCount(customerId?: string): number {
    return this.remoteSessions().filter((s) => s.status === "open" && (!customerId || s.customerId === customerId)).length;
  }
  // Highest number of simultaneously open sessions observed since the last reset.
  remoteMaxOpenSessionCount(customerId?: string): number {
    return this.peakOpen.get(customerId ?? "*") ?? 0;
  }
  private trackOpen(): void {
    const all = this.remoteSessions().filter((s) => s.status === "open");
    const bump = (k: string, n: number) => this.peakOpen.set(k, Math.max(this.peakOpen.get(k) ?? 0, n));
    bump("*", all.length);
    const byCustomer = new Map<string, number>();
    for (const s of all) if (s.customerId) byCustomer.set(s.customerId, (byCustomer.get(s.customerId) ?? 0) + 1);
    for (const [k, n] of byCustomer) bump(k, n);
  }
  // Seeds a provider-side subscription object without a webhook (simulates an
  // object Stripe already holds, e.g. "completed" arriving before "created").
  __seedSubscription(object: Obj, created = Math.floor(Date.now() / 1000)): void {
    this.recordObject("subscription", object, created);
  }
  __resetCounters(): void {
    for (const k of Object.keys(this.calls) as FakeProviderMethod[]) this.calls[k] = 0;
    this.peakOpen.clear();
    this.trackOpen();
  }

  async retrievePrice(priceId: string): Promise<ProviderPrice> {
    this.maybeFail("retrievePrice");
    const m = priceId.match(PRICE_RE);
    if (!m) throw new BillingProviderError("StripeInvalidRequestError:resource_missing", { providerStatus: 404 });
    return {
      id: priceId,
      livemode: m[1] === "live_",
      productId: `prod_fake_${m[2]}`,
      currency: m[2],
      unitAmountMinor: Number(m[3]),
      recurringInterval: m[4],
      recurringIntervalCount: 1,
      active: true,
      nickname: null,
      type: "recurring",
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
    this.maybeFail("createCustomer");
    const existing = this.customersByKey.get(input.idempotencyKey);
    if (existing) return { id: existing };
    const id = `cus_fake_${input.companyId}`;
    this.customersByKey.set(input.idempotencyKey, id);
    return { id };
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<ProviderCheckoutSession> {
    this.maybeFail("createCheckoutSession");
    const { idempotencyKey, ...params } = input;
    const fingerprint = createHash("sha256").update(canonicalJson(params)).digest("hex");
    const prior = this.checkoutByKey.get(idempotencyKey);
    if (prior) {
      // Stripe semantics: same key + same parameters → the ORIGINAL response is replayed
      // (never the current state); same key + different parameters → idempotency error.
      if (prior.fingerprint !== fingerprint) throw new BillingProviderError("StripeIdempotencyError:idempotency_key_parameters_mismatch", { providerStatus: 400, retryable: false });
      return { ...prior.response, metadata: { ...prior.response.metadata } };
    }
    const id = `cs_fake_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;
    const session: ProviderCheckoutSession = {
      id,
      livemode: false,
      url: `https://checkout.fake.local/c/${id}`,
      status: "open",
      customerId: input.customerId,
      subscriptionId: null,
      clientReferenceId: input.clientReferenceId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      metadata: { ...input.metadata },
    };
    this.checkoutSessions.set(id, session);
    this.checkoutByKey.set(idempotencyKey, { fingerprint, response: { ...session, metadata: { ...session.metadata } } });
    this.trackOpen();
    return { ...session, metadata: { ...session.metadata } };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession | null> {
    this.maybeFail("retrieveCheckoutSession");
    return this.checkoutSessions.get(sessionId) ?? null;
  }

  // Provider-side expiration: only an OPEN session can be expired (Stripe answers
  // 400 invalid_request for any other state).
  async expireCheckoutSession(sessionId: string): Promise<ProviderCheckoutSession> {
    this.maybeFail("expireCheckoutSession");
    const s = this.checkoutSessions.get(sessionId);
    if (!s) throw new BillingProviderError("StripeInvalidRequestError:resource_missing", { providerStatus: 404 });
    if (s.status !== "open") throw new BillingProviderError("StripeInvalidRequestError:checkout_session_not_open", { providerStatus: 400 });
    const expired = { ...s, status: "expired", url: null };
    this.checkoutSessions.set(sessionId, expired);
    this.trackOpen();
    return expired;
  }

  async createPortalSession(input: CreatePortalInput): Promise<{ url: string }> {
    this.maybeFail("createPortalSession");
    return { url: `https://billing.fake.local/p/${input.customerId}` };
  }

  async retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    this.maybeFail("retrieveSubscription");
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
      this.checkoutSessions.set(id, { ...(prev ?? s), ...s, url: prev?.url ?? s.url, livemode: prev?.livemode ?? s.livemode });
      this.trackOpen();
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
