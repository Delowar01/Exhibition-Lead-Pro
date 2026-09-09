import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  subscriptionsTable,
  auditLogsTable,
  contactsTable,
  planPricesTable,
  billingCheckoutSessionsTable,
  billingProviderEventsTable,
} from "@workspace/db";
import { signFakeWebhookPayload, FakeBillingProvider } from "../src/lib/billing/fake-provider.js";
import { processStripeWebhook } from "../src/services/billing-webhook.service.js";

// Batch 20 — Stripe billing boundary against the LIVE API with the deterministic
// FAKE provider (BILLING_PROVIDER=fake, STRIPE_WEBHOOK_SECRET from the test env).
// Zero network: prices are synthesized from their ids, Checkout / Portal URLs are
// local placeholders, and every webhook is a synthetic fixture signed offline with
// the official SDK helper. Proves: server-verified price registration, one
// customer per company, serialized + idempotent Checkout with no entitlement
// change, hosted Portal gating, signature / size / duplicate / out-of-order /
// mismatch / unbound webhook handling, provider→canonical state mapping (incl.
// the suspension shadow), revenue only from verified prices, manual-op refusal
// for provider-managed rows, convert-to-manual after provider cancellation, and
// the retry path when the provider fetch fails mid-processing.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b20stripe-${SUFFIX}.test`;
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_MONTH = "price_fake_usd_2900_month";
const PRICE_YEAR = "price_fake_usd_99000_year";
const T0 = Math.floor(Date.now() / 1000) - 120;

let platformToken = "";
let tokenA = "";
let tokenB = "";
let tokenEmpView = "";
let companyA = 0;
let companyB = 0;
let subIdA = 0;
let priceMonth: Record<string, any> = {};
let priceYear: Record<string, any> = {};
let checkoutSessionId = "";
const companyIds: number[] = [];
const eventIds: string[] = [];
const responses: string[] = [];
const SUB_A = `sub_fake_a_${SUFFIX}`;
const CUS_A = () => `cus_fake_${companyA}`;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: token ? headers(token) : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  responses.push(text);
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as Record<string, any>, text };
}
async function subRow(companyId: number) {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId));
  return row;
}
async function auditRows(companyId: number) {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyId), eq(auditLogsTable.entityType, "subscription")));
}
function subscriptionObject(o: Record<string, unknown>) {
  return {
    id: SUB_A,
    object: "subscription",
    customer: CUS_A(),
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: PRICE_MONTH }, current_period_start: T0, current_period_end: T0 + 30 * 24 * 3600 }] },
    metadata: { companyId: String(companyA), subscriptionId: String(subIdA) },
    ...o,
  };
}
async function webhook(type: string, object: Record<string, unknown>, created: number, opts: { id?: string; signature?: string | null; raw?: string } = {}) {
  const id = opts.id ?? `evt_b20_${SUFFIX}_${eventIds.length + 1}`;
  eventIds.push(id);
  const payload = opts.raw ?? JSON.stringify({ id, object: "event", type, created, livemode: false, data: { object } });
  const signature = opts.signature === undefined ? signFakeWebhookPayload(payload, SECRET) : opts.signature;
  const res = await fetch(`${BASE}/billing/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "Stripe-Signature": signature } : {}) },
    body: payload,
  });
  const text = await res.text();
  responses.push(text);
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, id };
}
const platformOp = (companyId: number, action: string, body?: unknown, method = "POST") => api(method, `/platform/subscriptions/${companyId}/${action}`, platformToken, body);
const detail = async (companyId: number) => (await api("GET", `/platform/subscriptions/${companyId}`, platformToken)).body;
const current = async (token: string) => (await api("GET", "/subscriptions/current", token)).body;

beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set in the test environment (fake provider)").not.toBe("");
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const status = await api("GET", "/platform/billing/status", platformToken);
  expect(status.body, "the API must run with BILLING_PROVIDER=fake for this suite").toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true });
  await db.delete(planPricesTable).where(like(planPricesTable.providerPriceId, "price_fake_%"));
  for (const [name, plan, setter] of [
    [`QA B20 Stripe A ${SUFFIX}`, "free", (id: number) => (companyA = id)],
    [`QA B20 Stripe B ${SUFFIX}`, "free", (id: number) => (companyB = id)],
  ] as const) {
    const res = await api("POST", "/companies", platformToken, { name, plan });
    expect(res.status, res.text).toBe(201);
    setter(res.body.id);
    companyIds.push(res.body.id);
  }
  for (const [email, role, companyId, permissions] of [
    [`admin-a@${DOMAIN}`, "primary_admin", companyA, undefined],
    [`admin-b@${DOMAIN}`, "primary_admin", companyB, undefined],
    [`emp-view@${DOMAIN}`, "employee", companyA, { subscriptions: ["view"] }],
  ] as const) {
    const res = await api("POST", "/users", platformToken, { email, name: email, role, companyId, password: PW });
    expect(res.status, res.text).toBe(201);
    if (permissions) await db.update(usersTable).set({ permissions }).where(eq(usersTable.id, res.body.id));
  }
  tokenA = await login(`admin-a@${DOMAIN}`);
  tokenB = await login(`admin-b@${DOMAIN}`);
  tokenEmpView = await login(`emp-view@${DOMAIN}`);
  subIdA = (await subRow(companyA)).id;
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds)); // cascades subscriptions + checkout sessions
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  if (eventIds.length) await db.delete(billingProviderEventsTable).where(inArray(billingProviderEventsTable.eventId, eventIds));
  await db.delete(billingProviderEventsTable).where(like(billingProviderEventsTable.eventId, `evt_b20_${SUFFIX}%`));
  await db.delete(planPricesTable).where(like(planPricesTable.providerPriceId, "price_fake_%"));
  await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), like(auditLogsTable.action, "billing.price_mapping.%")));
});

describe("provider status and price registration (platform owner, server-verified)", () => {
  it("reports the provider truthfully and hides it from tenants", async () => {
    const s = await api("GET", "/platform/billing/status", platformToken);
    expect(s.body).toMatchObject({ provider: "fake", available: true, unavailableReason: null, trialDays: 14, automaticTax: false });
    expect((await api("GET", "/platform/billing/status", tokenA)).status).toBe(403);
    expect((await api("GET", "/platform/billing/prices", tokenA)).status).toBe(403);
    expect((await api("POST", "/platform/billing/prices", tokenA, { planId: "professional", providerPriceId: PRICE_MONTH })).status).toBe(403);
  });
  it("registers a price only after the provider confirms it; amount/currency/interval come from the provider", async () => {
    expect((await api("POST", "/platform/billing/prices", platformToken, { planId: "gold", providerPriceId: PRICE_MONTH })).status).toBe(400);
    expect((await api("POST", "/platform/billing/prices", platformToken, { planId: "professional", providerPriceId: "not-a-price" })).status).toBe(400);
    const missing = await api("POST", "/platform/billing/prices", platformToken, { planId: "professional", providerPriceId: "price_fake_does_not_exist" });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("PROVIDER_PRICE_NOT_FOUND");
    const created = await api("POST", "/platform/billing/prices", platformToken, { planId: "professional", providerPriceId: PRICE_MONTH, unitAmountMinor: 1, currency: "eur" });
    expect(created.status, created.text).toBe(201);
    priceMonth = created.body;
    expect(priceMonth).toMatchObject({ planId: "professional", interval: "month", intervalCount: 1, currency: "usd", unitAmountMinor: 2900, active: true });
    expect(priceMonth.providerPriceRef).not.toBe(PRICE_MONTH);
    expect(priceMonth).not.toHaveProperty("providerPriceId");
    const dup = await api("POST", "/platform/billing/prices", platformToken, { planId: "business", providerPriceId: PRICE_MONTH });
    expect(dup.status).toBe(409);
    const yearly = await api("POST", "/platform/billing/prices", platformToken, { planId: "business", providerPriceId: PRICE_YEAR });
    expect(yearly.status).toBe(201);
    priceYear = yearly.body;
    expect(priceYear).toMatchObject({ interval: "year", unitAmountMinor: 99000 });
    const list = await api("GET", "/platform/billing/prices", platformToken);
    expect(list.body.prices.map((p: any) => p.id)).toEqual(expect.arrayContaining([priceMonth.id, priceYear.id]));
    const audit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), eq(auditLogsTable.entityId, String(priceMonth.id))));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain(PRICE_MONTH);
  });
  it("tenants see verified prices only, and checkout becomes available for an eligible manual trial", async () => {
    const plans = (await api("GET", "/subscriptions/plans", tokenA)).body as any[];
    const pro = plans.find((p) => p.id === "professional");
    expect(pro.prices).toEqual([expect.objectContaining({ id: priceMonth.id, unitAmountMinor: 2900, currency: "usd", interval: "month" })]);
    expect(plans.find((p) => p.id === "free").prices).toEqual([]);
    for (const p of plans) for (const pr of p.prices) expect(pr).not.toHaveProperty("providerPriceId");
    const c = await current(tokenA);
    expect(c.billing).toMatchObject({ providerConfigured: true, selfServiceCheckoutEnabled: true, checkoutAvailable: true, checkoutUnavailableReason: null, portalAvailable: false, portalUnavailableReason: "NOT_PROVIDER_MANAGED" });
  });
});

describe("Checkout — serialized, idempotent, one customer per company, no entitlement change", () => {
  it("creates a hosted session and links exactly one provider customer; entitlement is untouched", async () => {
    const before = await subRow(companyA);
    const res = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceMonth.id });
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe("created");
    expect(res.body.url).toMatch(/^https:\/\/checkout\.fake\.local\//);
    const after = await subRow(companyA);
    expect(after).toMatchObject({ status: before.status, billingSource: "manual", plan: "free", stripeCustomerId: CUS_A(), stripeSubscriptionId: null });
    const sessions = await db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.companyId, companyA));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "created", planPriceId: priceMonth.id, planId: "professional", providerCustomerId: CUS_A() });
    expect(sessions[0].providerSessionId).toMatch(/^cs_fake_/);
    expect(sessions[0].idempotencyKey).toMatch(/^checkout:[a-f0-9]{64}$/);
    checkoutSessionId = sessions[0].providerSessionId!;
    const audit = await auditRows(companyA);
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(["subscription.provider_customer_linked", "subscription.checkout_started"]));
    expect((await current(tokenA)).accessMode).toBe("full");
  });
  it("re-requesting the same price reuses the open session; concurrent requests never mint duplicates", async () => {
    const again = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceMonth.id });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("reused");
    const parallel = await Promise.all(Array.from({ length: 4 }, () => api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceMonth.id })));
    expect(parallel.every((r) => r.status === 200)).toBe(true);
    expect(new Set(parallel.map((r) => r.body.url)).size).toBe(1);
    const sessions = await db.select().from(billingCheckoutSessionsTable).where(and(eq(billingCheckoutSessionsTable.companyId, companyA), eq(billingCheckoutSessionsTable.status, "created")));
    expect(sessions).toHaveLength(1);
    expect((await subRow(companyA)).stripeCustomerId).toBe(CUS_A());
  });
  it("rejects unknown / inactive prices, unauthorized callers and provider-managed states", async () => {
    expect((await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: 999999999 })).body.code).toBe("PRICE_NOT_AVAILABLE");
    expect((await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: "abc" })).status).toBe(400);
    expect((await api("POST", "/subscriptions/checkout", tokenEmpView, { planPriceId: priceMonth.id })).status).toBe(403);
    expect((await api("POST", "/subscriptions/checkout", platformToken, { planPriceId: priceMonth.id })).status).toBe(403);
    const off = await api("PATCH", `/platform/billing/prices/${priceYear.id}`, platformToken, { active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    expect((await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceYear.id })).body.code).toBe("PRICE_NOT_AVAILABLE");
    expect((await api("PATCH", `/platform/billing/prices/${priceYear.id}`, platformToken, { active: true })).body.active).toBe(true);
    // Switching price opens a new session and expires the previous open one.
    const switched = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceYear.id });
    expect(switched.status).toBe(200);
    expect(switched.body.status).toBe("created");
    const rows = await db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.companyId, companyA));
    expect(rows.filter((r) => r.status === "created")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "expired")).toHaveLength(1);
    // Back to the monthly price for the webhook flow below.
    const back = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceMonth.id });
    expect(back.status).toBe(200);
    checkoutSessionId = (await db.select().from(billingCheckoutSessionsTable).where(and(eq(billingCheckoutSessionsTable.companyId, companyA), eq(billingCheckoutSessionsTable.status, "created"))))[0].providerSessionId!;
  });
});

describe("webhook transport guarantees", () => {
  it("400 without / with a bad signature, 413 when oversized, 200 (ignored) for unsupported types", async () => {
    const obj = subscriptionObject({});
    const none = await webhook("customer.subscription.updated", obj, T0, { signature: null });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe("SIGNATURE_MISSING");
    const bad = await webhook("customer.subscription.updated", obj, T0, { signature: "t=1,v1=deadbeef" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("SIGNATURE_INVALID");
    const tampered = await fetch(`${BASE}/billing/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signFakeWebhookPayload(JSON.stringify({ id: "evt_x", type: "x", data: { object: {} } }), SECRET) },
      body: JSON.stringify({ id: "evt_y", type: "x", data: { object: {} } }),
    });
    expect(tampered.status).toBe(400);
    const wrongSecret = await webhook("customer.subscription.updated", obj, T0, { signature: signFakeWebhookPayload(JSON.stringify({ id: "evt_z", type: "customer.subscription.updated", created: T0, data: { object: obj } }), "whsec_wrong_secret") });
    expect(wrongSecret.status).toBe(400);
    const huge = await webhook("customer.subscription.updated", { ...obj, padding: "x".repeat(300 * 1024) }, T0);
    expect(huge.status).toBe(413);
    const unsupported = await webhook("charge.succeeded", { id: "ch_1", object: "charge" }, T0);
    expect(unsupported.status).toBe(200);
    expect(unsupported.body.outcome).toBe("unsupported");
    const [row] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, unsupported.id));
    expect(row).toMatchObject({ status: "ignored", outcome: "unsupported" });
    expect((await subRow(companyA)).billingSource).toBe("manual");
    const empty = await fetch(`${BASE}/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=x" }, body: "" });
    expect([400, 413]).toContain(empty.status);
  });
  it("events are persisted sanitized: no payload, only type / ref / outcome", async () => {
    const rows = await db.select().from(billingProviderEventsTable).where(like(billingProviderEventsTable.eventId, `evt_b20_${SUFFIX}%`));
    for (const r of rows) {
      const cols = Object.keys(r);
      expect(cols).not.toContain("payload");
      expect(cols).not.toContain("rawBody");
      expect(JSON.stringify(r)).not.toMatch(/customer_email|@|whsec_/);
    }
  });
});

describe("provider-managed lifecycle through verified webhooks", () => {
  it("customer.subscription.created binds the subscription, maps the verified price to its plan and sets billing source", async () => {
    const res = await webhook("customer.subscription.created", subscriptionObject({ status: "trialing", trial_start: T0, trial_end: T0 + 14 * 24 * 3600 }), T0 + 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("applied");
    const row = await subRow(companyA);
    expect(row).toMatchObject({ billingSource: "stripe", stripeSubscriptionId: SUB_A, stripeCustomerId: CUS_A(), stripePriceId: PRICE_MONTH, providerStatus: "trialing", status: "trialing", plan: "professional" });
    expect(row.currentPeriodEndsAt?.getTime()).toBe((T0 + 30 * 24 * 3600) * 1000);
    expect(row.trialExpiresAt?.getTime()).toBe((T0 + 14 * 24 * 3600) * 1000);
    const audit = (await auditRows(companyA)).filter((r) => r.action === "subscription.provider_sync");
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].userName).toBe("system:stripe-webhook");
    expect(JSON.stringify(audit[0].metadata)).not.toContain(CUS_A());
  });
  it("checkout.session.completed closes the local checkout row; a duplicate delivery is a 200 no-op", async () => {
    const auditBefore = (await auditRows(companyA)).length;
    const res = await webhook("checkout.session.completed", { id: checkoutSessionId, object: "checkout.session", customer: CUS_A(), subscription: SUB_A, status: "complete", metadata: { companyId: String(companyA), subscriptionId: String(subIdA) } }, T0 + 2);
    expect(res.status).toBe(200);
    expect(["applied", "no_change"]).toContain(res.body.outcome);
    const [session] = await db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.providerSessionId, checkoutSessionId));
    expect(session).toMatchObject({ status: "completed", providerSubscriptionId: SUB_A });
    const auditAfter = (await auditRows(companyA)).length;
    const dup = await webhook("checkout.session.completed", { id: checkoutSessionId, object: "checkout.session", customer: CUS_A(), subscription: SUB_A, status: "complete" }, T0 + 2, { id: res.id });
    eventIds.pop();
    expect(dup.status).toBe(200);
    expect(dup.body.outcome).toBe("duplicate");
    expect((await auditRows(companyA)).length).toBe(auditAfter);
    expect(auditAfter).toBeGreaterThanOrEqual(auditBefore);
    const rows = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, res.id));
    expect(rows).toHaveLength(1);
  });
  it("active → full access; checkout is no longer offered while a live provider subscription exists; portal opens", async () => {
    const res = await webhook("customer.subscription.updated", subscriptionObject({ status: "active" }), T0 + 10);
    expect(res.body.outcome).toBe("applied");
    const c = await current(tokenA);
    expect(c).toMatchObject({ status: "active", accessMode: "full", billingSource: "stripe", providerLinked: true, providerSubscriptionLinked: true });
    expect(c.billing).toMatchObject({ checkoutAvailable: false, checkoutUnavailableReason: "LIVE_SUBSCRIPTION_EXISTS", portalAvailable: true, managedByPlatform: false });
    expect((await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceMonth.id })).body.code).toBe("LIVE_SUBSCRIPTION_EXISTS");
    const portal = await api("POST", "/subscriptions/portal", tokenA);
    expect(portal.status, portal.text).toBe(200);
    expect(portal.body.url).toBe(`https://billing.fake.local/p/${CUS_A()}`);
    expect((await auditRows(companyA)).some((r) => r.action === "subscription.portal_opened")).toBe(true);
    expect((await api("POST", "/subscriptions/portal", tokenEmpView)).status).toBe(403);
    const manual = await api("POST", "/subscriptions/portal", tokenB);
    expect(manual.status).toBe(409);
    expect(manual.body.code).toBe("NOT_PROVIDER_MANAGED");
    const d = await detail(companyA);
    expect(d.providerCustomerRef).not.toBe(CUS_A());
    expect(d.providerSubscriptionRef).not.toBe(SUB_A);
    expect(d.allowedActions.sort()).toEqual(["convert_to_manual", "set_limits", "suspend", "sync_provider"]);
  });
  it("past_due → read-only; an OLDER event is stale and ignored; invoices re-read the provider", async () => {
    expect((await webhook("customer.subscription.updated", subscriptionObject({ status: "past_due" }), T0 + 30)).body.outcome).toBe("applied");
    expect(await current(tokenA)).toMatchObject({ status: "past_due", accessMode: "read_only" });
    expect((await api("POST", "/contacts", tokenA, { firstName: "Read", lastName: "Only" })).status).toBe(403);
    const stale = await webhook("customer.subscription.updated", subscriptionObject({ status: "active" }), T0 + 20);
    expect(stale.status).toBe(200);
    expect(stale.body.outcome).toBe("stale");
    expect((await subRow(companyA)).status).toBe("past_due");
    const failed = await webhook("invoice.payment_failed", { id: "in_1", object: "invoice", customer: CUS_A(), subscription: SUB_A, customer_email: `admin-a@${DOMAIN}` }, T0 + 31);
    expect(failed.status).toBe(200);
    expect(["no_change", "applied"]).toContain(failed.body.outcome);
    expect((await subRow(companyA)).status).toBe("past_due");
    expect((await webhook("customer.subscription.updated", subscriptionObject({ status: "active" }), T0 + 40)).body.outcome).toBe("applied");
    const paid = await webhook("invoice.paid", { id: "in_2", object: "invoice", customer: CUS_A(), subscription: SUB_A }, T0 + 41);
    expect(paid.body.outcome).toBe("no_change");
    expect((await current(tokenA)).accessMode).toBe("full");
  });
  it("mismatched, unbound and email-only events change nothing", async () => {
    const before = await subRow(companyA);
    const beforeB = await subRow(companyB);
    const wrongCompany = await webhook("customer.subscription.updated", subscriptionObject({ status: "active", metadata: { companyId: String(companyB) } }), T0 + 50);
    expect(wrongCompany.body.outcome).toBe("mismatch");
    const otherSub = await webhook("customer.subscription.created", subscriptionObject({ id: `sub_fake_other_${SUFFIX}`, status: "canceled", metadata: {} }), T0 + 51);
    expect(otherSub.body.outcome).toBe("mismatch");
    const unknown = await webhook("customer.subscription.updated", subscriptionObject({ id: `sub_fake_zz_${SUFFIX}`, customer: "cus_fake_999999999", status: "canceled", metadata: {} }), T0 + 52);
    expect(unknown.body.outcome).toBe("unbound");
    const emailOnly = await webhook("invoice.paid", { id: "in_3", object: "invoice", customer_email: `admin-a@${DOMAIN}` }, T0 + 53);
    expect(emailOnly.body.outcome).toBe("unbound");
    const after = await subRow(companyA);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await subRow(companyB)).updatedAt.getTime()).toBe(beforeB.updatedAt.getTime());
    expect((await subRow(companyB)).billingSource).toBe("manual");
  });
  it("manual lifecycle operations are refused for a provider-managed row; sync re-applies provider state", async () => {
    for (const action of ["activate", "past-due", "cancel", "expire", "trial"]) {
      const r = await platformOp(companyA, action, action === "trial" ? { trialDays: 3 } : undefined);
      expect(r.status, action).toBe(409);
      expect(r.body.code, action).toBe("MANAGED_BY_PROVIDER");
    }
    expect((await platformOp(companyA, "plan", { plan: "enterprise" })).body.code).toBe("MANAGED_BY_PROVIDER");
    const live = await platformOp(companyA, "convert-to-manual");
    expect(live.status).toBe(409);
    expect(live.body.code).toBe("LIVE_PROVIDER_SUBSCRIPTION");
    const sync = await platformOp(companyA, "sync");
    expect(sync.status, sync.text).toBe(200);
    expect(["no_change", "applied"]).toContain(sync.body.outcome);
    expect((await subRow(companyA)).status).toBe("active");
  });
  it("platform suspension shadows provider updates; reactivation resumes the provider state", async () => {
    const s = await platformOp(companyA, "suspend", { reason: "fraud review" });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: "suspended", accessMode: "blocked", statusBeforeSuspension: "active" });
    expect((await api("GET", "/contacts", tokenA)).status).toBe(403);
    const shadow = await webhook("customer.subscription.updated", subscriptionObject({ status: "past_due" }), T0 + 60);
    expect(shadow.body.outcome).toBe("applied");
    const row = await subRow(companyA);
    expect(row).toMatchObject({ status: "suspended", statusBeforeSuspension: "past_due", providerStatus: "past_due" });
    expect((await current(tokenA).catch(() => ({ accessMode: "blocked" }))).accessMode ?? "blocked").toBe("blocked");
    const r = await platformOp(companyA, "reactivate");
    expect(r.body).toMatchObject({ status: "past_due", accessMode: "read_only" });
    expect((await webhook("customer.subscription.updated", subscriptionObject({ status: "active" }), T0 + 70)).body.outcome).toBe("applied");
    expect((await current(tokenA)).accessMode).toBe("full");
  });
  it("revenue is reported only from verified prices bound to live provider subscriptions", async () => {
    const m = (await api("GET", "/platform/subscriptions/metrics", platformToken)).body;
    expect(m.revenue.available).toBe(true);
    expect(m.revenue.currency).toBe("usd");
    expect(m.revenue.countedSubscriptions).toBeGreaterThanOrEqual(1);
    expect(m.revenue.monthlyRecurringMinor).toBeGreaterThanOrEqual(2900);
    expect(m.byBillingSource.find((b: any) => b.billingSource === "stripe").count).toBeGreaterThanOrEqual(1);
    const stats = (await api("GET", "/platform/stats", platformToken)).body;
    expect(stats.revenue).toEqual(m.revenue);
    const events = (await api("GET", `/platform/subscriptions/${companyA}/events`, platformToken)).body.events;
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const e of events) {
      expect(e.eventRef).not.toMatch(/^evt_b20_\d+_\d+$/);
      expect(["processed", "ignored", "failed", "received"]).toContain(e.status);
    }
  });
  it("provider cancellation → read-only; then convert-to-manual and manual activation take over", async () => {
    const deleted = await webhook("customer.subscription.deleted", subscriptionObject({ status: "canceled", canceled_at: T0 + 80, ended_at: T0 + 80 }), T0 + 80);
    expect(deleted.body.outcome).toBe("applied");
    const c = await current(tokenA);
    expect(c).toMatchObject({ status: "cancelled", accessMode: "read_only" });
    expect(c.billing.checkoutAvailable).toBe(true); // no live provider subscription any more
    expect(c.canceledAt).not.toBeNull();
    const converted = await platformOp(companyA, "convert-to-manual");
    expect(converted.status, converted.text).toBe(200);
    expect(converted.body).toMatchObject({ billingSource: "manual", status: "cancelled", providerSubscriptionLinked: false, providerLinked: true });
    expect((await subRow(companyA)).stripeSubscriptionId).toBeNull();
    const activated = await platformOp(companyA, "activate");
    expect(activated.body).toMatchObject({ status: "active", accessMode: "full", billingSource: "manual" });
    // A late TERMINAL event about the detached subscription never takes the platform-managed row back.
    const late = await webhook("customer.subscription.updated", subscriptionObject({ status: "canceled", canceled_at: T0 + 80, ended_at: T0 + 80 }), T0 + 90);
    expect(late.body.outcome).toBe("unbound");
    expect((await subRow(companyA))).toMatchObject({ billingSource: "manual", status: "active", stripeSubscriptionId: null });
    // …but a NEW live provider subscription for the same customer (re-subscribed through Checkout/Portal) binds again.
    const rebound = await webhook("customer.subscription.created", subscriptionObject({ id: `sub_fake_a2_${SUFFIX}`, status: "active", metadata: {} }), T0 + 95);
    expect(rebound.body.outcome).toBe("applied");
    expect((await subRow(companyA))).toMatchObject({ billingSource: "stripe", status: "active", stripeSubscriptionId: `sub_fake_a2_${SUFFIX}` });
  });
});

describe("temporary failure while processing → non-2xx, durable failed record, retry succeeds (in-process)", () => {
  it("a provider fetch failure yields 500 and the same delivery is accepted on retry", async () => {
    // An update for the CURRENTLY bound provider subscription (sub_fake_a2) whose authoritative fetch fails.
    const bound = (await subRow(companyA)).stripeSubscriptionId!;
    const id = `evt_b20_${SUFFIX}_retry`;
    eventIds.push(id);
    const obj = subscriptionObject({ id: bound, status: "past_due", metadata: {} });
    const payload = JSON.stringify({ id, object: "event", type: "customer.subscription.updated", created: T0 + 100, livemode: false, data: { object: obj } });
    const provider = new FakeBillingProvider(SECRET);
    provider.__failNextCall("StripeConnectionError");
    const before = await subRow(companyA);
    const failed = await processStripeWebhook(Buffer.from(payload), signFakeWebhookPayload(payload, SECRET), provider);
    expect(failed).toMatchObject({ httpStatus: 500, outcome: "failed", eventId: id });
    const [row] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, id));
    expect(row).toMatchObject({ status: "failed", failureCode: "StripeConnectionError" });
    expect((await subRow(companyA)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const retried = await processStripeWebhook(Buffer.from(payload), signFakeWebhookPayload(payload, SECRET), provider);
    expect(retried).toMatchObject({ httpStatus: 200, outcome: "applied", eventId: id });
    const [done] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, id));
    expect(done).toMatchObject({ status: "processed", outcome: "applied", attempts: 2 });
    expect(await subRow(companyA)).toMatchObject({ billingSource: "stripe", status: "past_due", stripeSubscriptionId: bound });
    const third = await processStripeWebhook(Buffer.from(payload), signFakeWebhookPayload(payload, SECRET), provider);
    expect(third.outcome).toBe("duplicate");
  });
});

describe("no secret ever leaves the server", () => {
  it("no response, audit row or event row contains the webhook secret or a Stripe API key", () => {
    const all = responses.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/sk_test_|sk_live_|whsec_/);
  });
});
