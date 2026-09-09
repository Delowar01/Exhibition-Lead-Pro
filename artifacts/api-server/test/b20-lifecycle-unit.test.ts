import { describe, it, expect } from "vitest";
import {
  resolveEntitlement,
  resolveBillingCapabilities,
  checkTransition,
  allowedActions,
  mapProviderStatus,
  resolveUsageWindow,
  resolveEffectiveLimits,
  limitFor,
  legacyCompanyStatus,
  normalizeLegacyStatus,
  LIFECYCLE_ACTIONS,
  SUBSCRIPTION_STATUSES,
  TRANSITIONS,
} from "../src/lib/billing/lifecycle.js";
import { canonicalFromLegacy, detectConflicts } from "../src/lib/billing/repair-rules.js";
import { sanitizeReason, changedFields } from "../src/lib/billing/audit.js";
import { normalizeProviderSubscription, normalizeProviderEvent, normalizeProviderPrice } from "../src/lib/billing/stripe-provider.js";
import { FakeBillingProvider, signFakeWebhookPayload } from "../src/lib/billing/fake-provider.js";
import { resolveBillingProviderSelection } from "../src/config.js";

// Batch 20 — pure unit coverage of the lifecycle model. No database, no server,
// no network: the resolver, transition table, provider-status mapping, usage
// window arithmetic, limit precedence, repair rules, audit sanitization, Stripe
// payload normalization and the offline signature helper are all deterministic.

const NOW = new Date("2026-09-09T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("resolveEntitlement — the single access policy", () => {
  it("fails closed when the subscription row is missing", () => {
    const e = resolveEntitlement(null, NOW);
    expect(e).toMatchObject({ accessMode: "blocked", reasonCode: "SUBSCRIPTION_MISSING" });
    expect(e.message).toContain("no subscription record");
  });
  it("trialing → full before the trial end, blocked (TRIAL_ENDED) after it", () => {
    expect(resolveEntitlement({ status: "trialing", trialExpiresAt: at(day) }, NOW).accessMode).toBe("full");
    expect(resolveEntitlement({ status: "trialing", trialExpiresAt: null }, NOW).accessMode).toBe("full");
    const ended = resolveEntitlement({ status: "trialing", trialExpiresAt: at(-1) }, NOW);
    expect(ended).toMatchObject({ accessMode: "blocked", reasonCode: "TRIAL_ENDED" });
    // Boundary: an end exactly at `now` is elapsed.
    expect(resolveEntitlement({ status: "trialing", trialExpiresAt: NOW }, NOW).accessMode).toBe("blocked");
  });
  it("active → full; past_due / cancelled → read-only; expired / suspended → blocked", () => {
    expect(resolveEntitlement({ status: "active", trialExpiresAt: at(-day) }, NOW)).toEqual({ accessMode: "full", reasonCode: null, message: null });
    expect(resolveEntitlement({ status: "past_due", trialExpiresAt: null }, NOW)).toMatchObject({ accessMode: "read_only", reasonCode: "PAST_DUE" });
    expect(resolveEntitlement({ status: "cancelled", trialExpiresAt: null }, NOW)).toMatchObject({ accessMode: "read_only", reasonCode: "SUBSCRIPTION_CANCELLED" });
    expect(resolveEntitlement({ status: "expired", trialExpiresAt: null }, NOW)).toMatchObject({ accessMode: "blocked", reasonCode: "SUBSCRIPTION_EXPIRED" });
    expect(resolveEntitlement({ status: "suspended", trialExpiresAt: at(day) }, NOW)).toMatchObject({ accessMode: "blocked", reasonCode: "SUBSCRIPTION_SUSPENDED" });
  });
  it("a scheduled provider cancellation never blocks on its own", () => {
    expect(resolveEntitlement({ status: "active", trialExpiresAt: null, cancelAtPeriodEnd: true, currentPeriodEndsAt: at(-day) }, NOW).accessMode).toBe("full");
  });
  it("tolerates the legacy 'trial' spelling and blocks unknown states", () => {
    expect(normalizeLegacyStatus("trial")).toBe("trialing");
    expect(normalizeLegacyStatus("bogus")).toBeNull();
    expect(resolveEntitlement({ status: "trial", trialExpiresAt: at(day) }, NOW).accessMode).toBe("full");
    expect(resolveEntitlement({ status: "weird", trialExpiresAt: null }, NOW)).toMatchObject({ accessMode: "blocked", reasonCode: "UNKNOWN_STATUS" });
  });
  it("messages never leak provider detail", () => {
    for (const status of [...SUBSCRIPTION_STATUSES, "trial", "bogus"]) {
      const e = resolveEntitlement({ status, trialExpiresAt: at(-1) }, NOW);
      expect(JSON.stringify(e)).not.toMatch(/stripe|sk_|whsec_|cus_|sub_/i);
    }
  });
});

describe("legacyCompanyStatus — write-only compatibility mirror", () => {
  it("maps canonical states onto the legacy company column vocabulary", () => {
    expect(legacyCompanyStatus("trialing")).toBe("trial");
    expect(legacyCompanyStatus("past_due")).toBe("active");
    for (const s of ["active", "cancelled", "expired", "suspended"] as const) expect(legacyCompanyStatus(s)).toBe(s);
  });
});

describe("transition table", () => {
  const manual = (status: string, extra: Record<string, unknown> = {}) => ({ status, billingSource: "manual", ...extra });
  const stripe = (status: string, extra: Record<string, unknown> = {}) => ({ status, billingSource: "stripe", ...extra });

  it("every action has a rule and the sweep is never a platform action", () => {
    for (const a of LIFECYCLE_ACTIONS) expect(TRANSITIONS[a]).toBeDefined();
    expect(allowedActions(manual("trialing"))).not.toContain("sweep_expire_trial");
  });
  it("manual lifecycle: allowed and forbidden moves", () => {
    expect(checkTransition("activate", manual("trialing"))).toEqual({ ok: true, to: "active" });
    expect(checkTransition("activate", manual("expired"))).toEqual({ ok: true, to: "active" });
    expect(checkTransition("activate", manual("active"))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(checkTransition("mark_past_due", manual("active"))).toEqual({ ok: true, to: "past_due" });
    expect(checkTransition("mark_past_due", manual("trialing"))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(checkTransition("cancel", manual("past_due"))).toEqual({ ok: true, to: "cancelled" });
    expect(checkTransition("cancel", manual("expired"))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(checkTransition("expire", manual("cancelled"))).toEqual({ ok: true, to: "expired" });
    expect(checkTransition("start_trial", manual("expired"))).toEqual({ ok: true, to: "trialing" });
    expect(checkTransition("start_trial", manual("active"))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(checkTransition("set_plan", manual("suspended"))).toEqual({ ok: true, to: null });
    expect(checkTransition("suspend", manual("suspended"))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(checkTransition("sweep_expire_trial", manual("trialing"))).toEqual({ ok: true, to: "expired" });
    expect(checkTransition("sweep_expire_trial", manual("active"))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
  });
  it("reactivate restores the pre-suspension state and refuses without one", () => {
    expect(checkTransition("reactivate", manual("suspended", { statusBeforeSuspension: "active" }))).toEqual({ ok: true, to: "active" });
    expect(checkTransition("reactivate", manual("suspended", { statusBeforeSuspension: "trial" }))).toEqual({ ok: true, to: "trialing" });
    expect(checkTransition("reactivate", manual("suspended", { statusBeforeSuspension: null }))).toEqual({ ok: false, code: "NO_RESTORE_STATE" });
    expect(checkTransition("reactivate", manual("suspended", { statusBeforeSuspension: "suspended" }))).toEqual({ ok: false, code: "NO_RESTORE_STATE" });
    expect(checkTransition("reactivate", manual("active", { statusBeforeSuspension: "trialing" }))).toEqual({ ok: false, code: "INVALID_TRANSITION" });
  });
  it("provider-managed rows refuse manual state changes but allow suspend / limits / sync / convert", () => {
    for (const a of ["activate", "mark_past_due", "cancel", "expire", "start_trial", "set_plan"] as const) {
      expect(checkTransition(a, stripe("active"))).toEqual({ ok: false, code: "MANAGED_BY_PROVIDER" });
    }
    expect(checkTransition("suspend", stripe("active"))).toEqual({ ok: true, to: "suspended" });
    expect(checkTransition("set_limits", stripe("past_due"))).toEqual({ ok: true, to: null });
    expect(checkTransition("sync_provider", stripe("cancelled"))).toEqual({ ok: true, to: null });
    expect(checkTransition("convert_to_manual", stripe("cancelled"))).toEqual({ ok: true, to: null });
    expect(checkTransition("convert_to_manual", manual("active"))).toEqual({ ok: false, code: "NOT_PROVIDER_MANAGED" });
    expect(checkTransition("sync_provider", manual("active"))).toEqual({ ok: false, code: "NOT_PROVIDER_MANAGED" });
    // The system sweep never touches provider-managed rows.
    expect(checkTransition("sweep_expire_trial", stripe("trialing"))).toEqual({ ok: false, code: "MANAGED_BY_PROVIDER" });
  });
  it("allowedActions is exactly the set of ok transitions", () => {
    expect(allowedActions(manual("trialing")).sort()).toEqual(["cancel", "activate", "expire", "set_limits", "set_plan", "start_trial", "suspend"].sort());
    expect(allowedActions(stripe("active")).sort()).toEqual(["convert_to_manual", "set_limits", "suspend", "sync_provider"].sort());
    expect(allowedActions(manual("suspended", { statusBeforeSuspension: "active" })).sort()).toEqual(["reactivate", "set_limits", "set_plan"].sort());
  });
});

describe("mapProviderStatus — Stripe status → canonical state", () => {
  it("maps live states and read-only collection states; incomplete never changes entitlement", () => {
    expect(mapProviderStatus("trialing").status).toBe("trialing");
    expect(mapProviderStatus("active").status).toBe("active");
    expect(mapProviderStatus("past_due").status).toBe("past_due");
    expect(mapProviderStatus("unpaid").status).toBe("past_due");
    expect(mapProviderStatus("paused").status).toBe("past_due");
    expect(mapProviderStatus("canceled").status).toBe("cancelled");
    expect(mapProviderStatus("incomplete").status).toBeNull();
    expect(mapProviderStatus("incomplete_expired").status).toBeNull();
    expect(mapProviderStatus("something_new").status).toBeNull();
  });
});

describe("resolveBillingCapabilities — when Checkout / Portal are offered", () => {
  const ctx = { providerAvailable: true, checkoutEnabled: true, portalConfigured: true, hasActivePrices: true };
  const sub = (o: Partial<{ status: string; billingSource: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null }>) => ({
    status: "trialing",
    billingSource: "manual",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    ...o,
  });
  it("checkout requires provider + flag + verified prices + eligible status + no live provider subscription", () => {
    expect(resolveBillingCapabilities(sub({}), ctx)).toMatchObject({ checkoutAvailable: true, portalAvailable: false, portalUnavailableReason: "NOT_PROVIDER_MANAGED" });
    expect(resolveBillingCapabilities(sub({}), { ...ctx, providerAvailable: false }).checkoutUnavailableReason).toBe("PROVIDER_UNAVAILABLE");
    expect(resolveBillingCapabilities(sub({}), { ...ctx, checkoutEnabled: false }).checkoutUnavailableReason).toBe("CHECKOUT_DISABLED");
    expect(resolveBillingCapabilities(sub({}), { ...ctx, hasActivePrices: false }).checkoutUnavailableReason).toBe("NO_ACTIVE_PRICES");
    expect(resolveBillingCapabilities(sub({ status: "active" }), ctx).checkoutUnavailableReason).toBe("STATUS_NOT_ELIGIBLE");
    expect(resolveBillingCapabilities(sub({ status: "cancelled" }), ctx).checkoutAvailable).toBe(true);
    const live = sub({ status: "active", billingSource: "stripe", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
    expect(resolveBillingCapabilities(live, ctx, "active").checkoutUnavailableReason).toBe("LIVE_SUBSCRIPTION_EXISTS");
    // A provider subscription that Stripe already cancelled no longer blocks a new Checkout.
    expect(resolveBillingCapabilities({ ...live, status: "cancelled" }, ctx, "canceled").checkoutAvailable).toBe(true);
  });
  it("portal requires a provider-managed row with a customer and a non-terminal status", () => {
    const managed = sub({ status: "active", billingSource: "stripe", stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
    expect(resolveBillingCapabilities(managed, ctx).portalAvailable).toBe(true);
    expect(resolveBillingCapabilities({ ...managed, stripeCustomerId: null }, ctx).portalUnavailableReason).toBe("NO_PROVIDER_CUSTOMER");
    expect(resolveBillingCapabilities({ ...managed, status: "suspended" }, ctx).portalUnavailableReason).toBe("STATUS_NOT_ELIGIBLE");
    expect(resolveBillingCapabilities(managed, { ...ctx, providerAvailable: false }).portalUnavailableReason).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("resolveUsageWindow — scan consumption window", () => {
  const base = { currentPeriodStartsAt: null, currentPeriodEndsAt: null, usageAnchorAt: null, trialStartedAt: null, createdAt: new Date("2026-01-31T10:00:00.000Z") };
  it("uses the billing period when now falls inside it", () => {
    const w = resolveUsageWindow({ ...base, currentPeriodStartsAt: at(-5 * day), currentPeriodEndsAt: at(25 * day) }, NOW);
    expect(w.source).toBe("billing_period");
    expect(w.startsAt.getTime()).toBe(at(-5 * day).getTime());
  });
  it("falls back to the anchored month (anchor → trial start → created_at) and clamps month ends", () => {
    const w = resolveUsageWindow(base, NOW);
    expect(w.source).toBe("anchored_month");
    // Anchor Jan 31 10:00 → windows Jan31→Feb28→Mar31→…→Aug31→Sep30 (day clamped to month length).
    expect(w.startsAt.toISOString()).toBe("2026-08-31T10:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-09-30T10:00:00.000Z");
    expect(NOW.getTime()).toBeGreaterThanOrEqual(w.startsAt.getTime());
    expect(NOW.getTime()).toBeLessThan(w.endsAt.getTime());
    const anchored = resolveUsageWindow({ ...base, usageAnchorAt: new Date("2026-09-05T00:00:00.000Z") }, NOW);
    expect(anchored.startsAt.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(anchored.endsAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });
  it("an elapsed billing period is ignored in favour of the anchored month", () => {
    const w = resolveUsageWindow({ ...base, currentPeriodStartsAt: at(-60 * day), currentPeriodEndsAt: at(-30 * day), usageAnchorAt: new Date("2026-09-01T00:00:00.000Z") }, NOW);
    expect(w.source).toBe("anchored_month");
  });
  it("an anchor in the future yields the month ending at the anchor", () => {
    const w = resolveUsageWindow({ ...base, usageAnchorAt: at(3 * day) }, NOW);
    expect(w.endsAt.getTime()).toBe(at(3 * day).getTime());
    expect(w.startsAt.getTime()).toBeLessThan(NOW.getTime());
  });
});

describe("resolveEffectiveLimits — override ?? plan default ?? unlimited", () => {
  const plan = { contactsLimit: 100, eventsLimit: null, adminsLimit: 2, employeesLimit: 10, scansLimit: 50, storageLimitMb: null };
  it("applies precedence per resource and reports the source", () => {
    const limits = resolveEffectiveLimits(plan, { contacts: 5, scans: null });
    const by = Object.fromEntries(limits.map((l) => [l.resource, l]));
    expect(by.contacts).toMatchObject({ limit: 5, source: "override" });
    expect(by.admins).toMatchObject({ limit: 2, source: "plan" });
    expect(by.events).toMatchObject({ limit: null, source: "unlimited" });
    // an explicit null override does not "unset" the plan default; absence does
    expect(by.scans.limit).toBe(50);
    expect(limitFor(limits, "employees")).toBe(10);
    expect(limitFor(limits, "storageMb")).toBeNull();
  });
  it("a missing plan row leaves everything unlimited unless overridden", () => {
    const limits = resolveEffectiveLimits(null, { events: 3 });
    expect(limitFor(limits, "events")).toBe(3);
    expect(limitFor(limits, "contacts")).toBeNull();
    expect(limits).toHaveLength(6);
  });
});

describe("repair rules (scripts/repair-subscriptions.ts)", () => {
  const co = (status: string, trialEndsAt: Date | null, plan = "free") => ({ id: 7, plan, status, trialEndsAt });
  it("R2/R3: legacy trial with a future end stays a trial; a lapsed one stays trialing (blocked, then swept)", () => {
    expect(canonicalFromLegacy(co("trial", at(5 * day)), null, NOW)).toEqual({ status: "trialing", trialExpiresAt: at(5 * day), rule: "trial_future" });
    expect(canonicalFromLegacy(co("trial", at(-5 * day)), null, NOW)).toEqual({ status: "trialing", trialExpiresAt: at(-5 * day), rule: "trial_lapsed" });
    // company end wins; subscription end is the fallback
    expect(canonicalFromLegacy(co("trial", null), at(2 * day), NOW).rule).toBe("trial_future");
  });
  it("R2: a trial without any end date never expired before → active, no new trial invented", () => {
    expect(canonicalFromLegacy(co("trial", null), null, NOW)).toEqual({ status: "active", trialExpiresAt: null, rule: "trial_without_end_to_active" });
  });
  it("other legacy states map onto the same canonical state", () => {
    for (const s of ["active", "suspended", "expired", "cancelled"]) expect(canonicalFromLegacy(co(s, null), null, NOW).status).toBe(s);
    expect(() => canonicalFromLegacy(co("bogus", null), null, NOW)).toThrow(/unknown legacy status/);
  });
  it("R4: conflicts abort — duplicates, provider ids, unknown plan / status", () => {
    const sub = { plan: "free", status: "trial", stripeCustomerId: null, stripeSubscriptionId: null };
    expect(detectConflicts(co("trial", null), [sub])).toEqual([]);
    expect(detectConflicts(co("trial", null), [sub, sub])[0]).toMatch(/2 subscriptions/);
    expect(detectConflicts(co("trial", null, "gold"), [sub])[0]).toMatch(/plan "gold"/);
    expect(detectConflicts(co("paused", null), [sub])[0]).toMatch(/status "paused"/);
    expect(detectConflicts(co("active", null), [{ ...sub, stripeCustomerId: "cus_x" }])[0]).toMatch(/provider ids populated/);
    expect(detectConflicts(co("active", null), [{ ...sub, status: "weird" }])[0]).toMatch(/subscription status "weird"/);
  });
});

describe("audit sanitization", () => {
  it("reasons are single-line and length-capped; non-strings are dropped", () => {
    expect(sanitizeReason("  unpaid\ninvoice\t#12  ")).toBe("unpaid invoice #12");
    expect(sanitizeReason("x".repeat(500))?.length).toBe(200);
    expect(sanitizeReason("")).toBeNull();
    expect(sanitizeReason({ reason: "x" })).toBeNull();
  });
  it("changedFields lists only safe lifecycle fields (never provider ids)", () => {
    const before = { status: "trialing", plan: "free", stripeCustomerId: null, stripeSubscriptionId: null } as never;
    const after = { status: "active", plan: "free", stripeCustomerId: "cus_secret", stripeSubscriptionId: "sub_secret" } as never;
    const changed = changedFields(before, after);
    expect(changed).toContain("status");
    expect(changed).not.toContain("stripeCustomerId");
    expect(changed).not.toContain("stripeSubscriptionId");
  });
});

describe("Stripe payload normalization", () => {
  it("reads billing periods from items (new API) or the top level (old API) and expandable refs", () => {
    const fromItems = normalizeProviderSubscription({
      id: "sub_1",
      customer: { id: "cus_1" },
      status: "active",
      cancel_at_period_end: true,
      items: { data: [{ price: { id: "price_1" }, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 }] },
      metadata: { companyId: "9", ignored: 5 },
    });
    expect(fromItems).toMatchObject({ id: "sub_1", customerId: "cus_1", status: "active", priceId: "price_1", cancelAtPeriodEnd: true, metadata: { companyId: "9" } });
    expect(fromItems.currentPeriodStart?.getTime()).toBe(1_700_000_000_000);
    const topLevel = normalizeProviderSubscription({ id: "sub_2", customer: "cus_2", status: "canceled", current_period_start: 1, current_period_end: 2, canceled_at: 3, ended_at: 4 });
    expect(topLevel.currentPeriodEnd?.getTime()).toBe(2000);
    expect(topLevel.canceledAt?.getTime()).toBe(3000);
    expect(topLevel.endedAt?.getTime()).toBe(4000);
    expect(topLevel.priceId).toBeNull();
  });
  it("normalizes prices and events defensively", () => {
    const p = normalizeProviderPrice({ id: "price_x", product: "prod_x", currency: "USD", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 }, active: true, type: "recurring" });
    expect(p).toMatchObject({ currency: "usd", unitAmountMinor: 2900, recurringInterval: "month", type: "recurring" });
    expect(normalizeProviderPrice({ id: "price_y", type: "one_time" }).type).toBe("one_time");
    const e = normalizeProviderEvent({ id: "evt_1", type: "invoice.paid", created: 10, data: { object: { object: "invoice" } } });
    expect(e).toMatchObject({ id: "evt_1", type: "invoice.paid", object: { object: "invoice" } });
    expect(normalizeProviderEvent({}).id).toBe("");
  });
});

describe("offline webhook signature verification (official SDK, no network)", () => {
  const secret = "whsec_unit_test_only_not_a_real_secret";
  const provider = new FakeBillingProvider(secret);
  const payload = JSON.stringify({ id: "evt_unit_1", type: "customer.subscription.updated", created: Math.floor(NOW.getTime() / 1000), data: { object: { id: "sub_u", object: "subscription", customer: "cus_u", status: "active" } } });

  it("accepts a correctly signed payload and rejects missing / tampered / wrong-secret / stale signatures", () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = signFakeWebhookPayload(payload, secret, ts);
    expect(provider.constructEvent(Buffer.from(payload), good)).toMatchObject({ id: "evt_unit_1", type: "customer.subscription.updated" });
    expect(() => provider.constructEvent(Buffer.from(payload), undefined)).toThrow(/SIGNATURE_MISSING/);
    expect(() => provider.constructEvent(Buffer.from(payload.replace("active", "canceled")), good)).toThrow(/SIGNATURE_INVALID/);
    expect(() => provider.constructEvent(Buffer.from(payload), signFakeWebhookPayload(payload, "whsec_other", ts))).toThrow(/SIGNATURE_INVALID/);
    expect(() => provider.constructEvent(Buffer.from(payload), signFakeWebhookPayload(payload, secret, ts - 3600))).toThrow(/SIGNATURE_INVALID/);
    expect(() => provider.constructEvent(Buffer.from(payload), "t=abc,v1=zzz")).toThrow(/SIGNATURE_INVALID/);
  });
  it("remembers the newest verified subscription object for later retrieval (out-of-order safe)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const newer = JSON.stringify({ id: "evt_unit_2", type: "customer.subscription.updated", created: ts, data: { object: { id: "sub_u", object: "subscription", customer: "cus_u", status: "past_due" } } });
    const older = JSON.stringify({ id: "evt_unit_3", type: "customer.subscription.updated", created: ts - 100, data: { object: { id: "sub_u", object: "subscription", customer: "cus_u", status: "active" } } });
    provider.constructEvent(Buffer.from(newer), signFakeWebhookPayload(newer, secret, ts));
    provider.constructEvent(Buffer.from(older), signFakeWebhookPayload(older, secret, ts));
    expect((await provider.retrieveSubscription("sub_u"))?.status).toBe("past_due");
    expect(await provider.retrieveSubscription("sub_unknown")).toBeNull();
  });
  it("synthesizes prices from the id only and refuses anything else; customers/sessions are deterministic", async () => {
    const price = await provider.retrievePrice("price_fake_usd_2900_month");
    expect(price).toMatchObject({ currency: "usd", unitAmountMinor: 2900, recurringInterval: "month", active: true, type: "recurring" });
    await expect(provider.retrievePrice("price_real_looking")).rejects.toThrow(/resource_missing/);
    expect(await provider.createCustomer({ companyId: 42, companyName: "X", idempotencyKey: "k" })).toEqual({ id: "cus_fake_42" });
    const input = { customerId: "cus_fake_42", priceId: "price_fake_usd_2900_month", successUrl: "s", cancelUrl: "c", clientReferenceId: "1", metadata: {}, idempotencyKey: "checkout:abc", automaticTax: false };
    const a = await provider.createCheckoutSession(input);
    const b = await provider.createCheckoutSession(input);
    expect(a.id).toBe(b.id);
    expect(a.url).toMatch(/^https:\/\/checkout\.fake\.local\//);
    provider.__failNextCall("StripeConnectionError");
    await expect(provider.createPortalSession({ customerId: "cus_fake_42", returnUrl: "r" })).rejects.toThrow(/StripeConnectionError/);
    expect((await provider.createPortalSession({ customerId: "cus_fake_42", returnUrl: "r" })).url).toContain("cus_fake_42");
  });
});

describe("resolveBillingProviderSelection — fail-closed configuration", () => {
  it("unset / none → unavailable NOT_CONFIGURED", () => {
    expect(resolveBillingProviderSelection("production", undefined, true, true)).toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
    expect(resolveBillingProviderSelection("development", "none", true, true).reason).toBe("NOT_CONFIGURED");
  });
  it("stripe requires both secrets", () => {
    expect(resolveBillingProviderSelection("production", "stripe", false, true).reason).toBe("STRIPE_SECRET_KEY_MISSING");
    expect(resolveBillingProviderSelection("production", "stripe", true, false).reason).toBe("STRIPE_WEBHOOK_SECRET_MISSING");
    expect(resolveBillingProviderSelection("production", "stripe", true, true)).toEqual({ kind: "stripe", reason: null });
  });
  it("fake is forbidden in production and still requires a webhook secret", () => {
    expect(resolveBillingProviderSelection("production", "fake", false, true).reason).toBe("FAKE_PROVIDER_FORBIDDEN");
    expect(resolveBillingProviderSelection("development", "fake", false, false).reason).toBe("STRIPE_WEBHOOK_SECRET_MISSING");
    expect(resolveBillingProviderSelection("test", "FAKE ", false, true)).toEqual({ kind: "fake", reason: null });
    expect(resolveBillingProviderSelection("development", "paypal", true, true).reason).toBe("UNKNOWN_PROVIDER");
  });
});
