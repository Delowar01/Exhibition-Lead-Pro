import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, subscriptionsTable, auditLogsTable, plansTable, planVersionsTable, planPricesTable, billingCheckoutSessionsTable, billingProviderEventsTable } from "@workspace/db";
import { signFakeWebhookPayload } from "../src/lib/billing/fake-provider.js";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Release correction M2 — provider reconciliation survives plan archival.
//
// Against the LIVE API and the FAKE provider (offline-signed webhooks, no real
// payment-provider operation):
//   • a plan cannot be archived while a checkout for it is still in progress;
//   • if a plan IS archived while a provider subscription, a registered price
//     or a checkout still references it, the provider event reconciles instead
//     of failing on every retry: the purchase is honoured on the plan's
//     published version and recorded for the operator (planArchived: true);
//   • later events of that provider subscription (status changes, the terminal
//     cancellation) keep reconciling;
//   • every ORDINARY assignment path stays strict: an archived plan cannot be
//     assigned by the platform, bought through a new checkout or listed;
//   • a price of a never-published plan stays unmapped (nothing was ever sold).

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b44arc-${SUFFIX}.test`;
const PLAN = `b44-arc-${SUFFIX}`; // published, then archived while still referenced
const DRAFT_PLAN = `b44-draft-${SUFFIX}`; // never published
const FREE_PLAN = `b44-free-${SUFFIX}`; // published, unreferenced: archives normally
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_BOUND = "price_fake_gbp_3100_month"; // bound to PLAN v1
const PRICE_WIDE = "price_fake_gbp_33000_year"; // plan-wide on PLAN
const PRICE_DRAFT = "price_fake_gbp_3400_month"; // bound to DRAFT_PLAN's draft
const PRICE_DRAFT_WIDE = "price_fake_gbp_35000_year"; // plan-wide on DRAFT_PLAN
const ABANDONED_PLAN = `b44-abn-${SUFFIX}`; // published; its only checkout was abandoned
const PRICE_ABANDONED = "price_fake_gbp_36000_year";
const T0 = Math.floor(Date.now() / 1000) - 600;

let platformToken = "";
let v1 = 0;
let boundPrice: Record<string, any> = {};
let widePrice: Record<string, any> = {};
const priceIds: number[] = [];
const eventIds: string[] = [];
interface Tenant {
  companyId: number;
  subId: number;
  token: string;
  intentId: number;
  providerSub: string;
}
const A = { companyId: 0, subId: 0, token: "", intentId: 0, providerSub: `sub_fake_b44a_${SUFFIX}` } as Tenant; // checkout on the version-bound price
const B = { companyId: 0, subId: 0, token: "", intentId: 0, providerSub: `sub_fake_b44b_${SUFFIX}` } as Tenant; // checkout on the plan-wide price
const C = { companyId: 0, subId: 0, token: "", intentId: 0, providerSub: `sub_fake_b44c_${SUFFIX}` } as Tenant; // abandons its checkout

function headers(token: string | null) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as Record<string, any>, text };
}
const subRow = async (t: Tenant) => (await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, t.companyId)))[0];
const auditRows = (t: Tenant) => db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, t.companyId), eq(auditLogsTable.entityType, "subscription")));
const planRow = async (id: string) => (await db.select().from(plansTable).where(eq(plansTable.id, id)))[0];
function subscriptionObject(t: Tenant, priceId: string, o: Record<string, unknown> = {}) {
  return {
    id: t.providerSub,
    object: "subscription",
    customer: `cus_fake_${t.companyId}`,
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: priceId }, current_period_start: T0, current_period_end: T0 + 30 * 24 * 3600 }] },
    metadata: { companyId: String(t.companyId), subscriptionId: String(t.subId), checkoutId: String(t.intentId) },
    ...o,
  };
}
async function webhook(type: string, object: Record<string, unknown>, created: number) {
  const id = `evt_b44_${SUFFIX}_${eventIds.length + 1}`;
  eventIds.push(id);
  const payload = JSON.stringify({ id, object: "event", type, created, livemode: false, data: { object } });
  const res = await fetch(`${BASE}/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signFakeWebhookPayload(payload, SECRET) }, body: payload });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, id, text };
}
async function registerPrice(planId: string, providerPriceId: string, planVersionId?: number) {
  const res = await api("POST", "/platform/billing/prices", platformToken, { planId, providerPriceId, ...(planVersionId ? { planVersionId } : {}) });
  expect(res.status, res.text).toBe(201);
  priceIds.push(res.body.id);
  return res.body;
}
async function createTenant(t: Tenant, label: string) {
  const company = await api("POST", "/companies", platformToken, { name: `QA B44 Archive ${label} ${SUFFIX}`, plan: "free" });
  expect(company.status, company.text).toBe(201);
  t.companyId = company.body.id;
  const email = `${label.toLowerCase()}@${DOMAIN}`;
  const user = await api("POST", "/users", platformToken, { email, name: label, role: "primary_admin", companyId: t.companyId, password: PW });
  expect(user.status, user.text).toBe(201);
  t.token = await login(email);
  t.subId = (await subRow(t)).id;
}
async function openCheckout(t: Tenant, planPriceId: number, planId: string = PLAN) {
  const res = await api("POST", "/subscriptions/checkout", t.token, { planPriceId });
  expect(res.status, res.text).toBe(200);
  const [intent] = await db.select().from(billingCheckoutSessionsTable).where(and(eq(billingCheckoutSessionsTable.companyId, t.companyId), eq(billingCheckoutSessionsTable.status, "open")));
  expect(intent).toMatchObject({ planPriceId, planId });
  t.intentId = intent.id;
}

beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set (fake provider)").not.toBe("");
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  expect((await api("GET", "/platform/billing/status", platformToken)).body).toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true });
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");

  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `Archive ${SUFFIX}`, limits: {}, features: {} });
  expect(created.status, created.text).toBe(201);
  v1 = created.body.draft.id;
  boundPrice = await registerPrice(PLAN, PRICE_BOUND, v1);
  widePrice = await registerPrice(PLAN, PRICE_WIDE);
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v1}/publish`, platformToken)).status).toBe(200);

  const draft = await api("POST", "/platform/plans", platformToken, { id: DRAFT_PLAN, name: `Draft ${SUFFIX}`, limits: {}, features: {} });
  expect(draft.status, draft.text).toBe(201);
  await registerPrice(DRAFT_PLAN, PRICE_DRAFT, draft.body.draft.id);
  await registerPrice(DRAFT_PLAN, PRICE_DRAFT_WIDE);

  const abandoned = await api("POST", "/platform/plans", platformToken, { id: ABANDONED_PLAN, name: `Abandoned ${SUFFIX}`, limits: {}, features: {} });
  expect(abandoned.status, abandoned.text).toBe(201);
  const abandonedPrice = await registerPrice(ABANDONED_PLAN, PRICE_ABANDONED);
  expect((await api("POST", `/platform/plans/${ABANDONED_PLAN}/versions/${abandoned.body.draft.id}/publish`, platformToken)).status).toBe(200);

  const free = await api("POST", "/platform/plans", platformToken, { id: FREE_PLAN, name: `Unreferenced ${SUFFIX}`, limits: {}, features: {} });
  expect(free.status, free.text).toBe(201);
  expect((await api("POST", `/platform/plans/${FREE_PLAN}/versions/${free.body.draft.id}/publish`, platformToken)).status).toBe(200);

  await createTenant(A, "A");
  await createTenant(B, "B");
  // Both tenants start a checkout while the plan is published and sellable.
  await openCheckout(A, boundPrice.id);
  await openCheckout(B, widePrice.id);
  await createTenant(C, "C");
  await openCheckout(C, abandonedPrice.id, ABANDONED_PLAN);
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* best-effort teardown on a disposable database */
    }
  };
  for (const t of [A, B, C]) {
    if (!t.companyId) continue;
    await quiet(() => db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, t.companyId)));
    await quiet(() => db.delete(usersTable).where(eq(usersTable.companyId, t.companyId)));
    await quiet(() => db.delete(companiesTable).where(eq(companiesTable.id, t.companyId))); // cascades subscription + checkout sessions
  }
  await quiet(() => db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`)));
  await quiet(() => db.delete(billingProviderEventsTable).where(like(billingProviderEventsTable.eventId, `evt_b44_${SUFFIX}%`)));
  if (priceIds.length) {
    await quiet(() => db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), inArray(auditLogsTable.entityId, priceIds.map(String)))));
    await quiet(() => db.delete(planPricesTable).where(inArray(planPricesTable.id, priceIds)));
  }
  await quiet(() => db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [PLAN, DRAFT_PLAN, FREE_PLAN, ABANDONED_PLAN])));
  await quiet(() => db.delete(plansTable).where(inArray(plansTable.id, [PLAN, DRAFT_PLAN, FREE_PLAN, ABANDONED_PLAN])));
});

describe("archiving a plan that is still referenced", () => {
  it("is refused while a checkout for the plan is in progress — nothing changes", async () => {
    const res = await api("POST", `/platform/plans/${PLAN}/archive`, platformToken);
    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe("PLAN_HAS_OPEN_CHECKOUTS");
    expect(res.body.context).toEqual({ count: 2 });
    expect(await planRow(PLAN)).toMatchObject({ status: "published", isActive: true });
  });

  it("an ABANDONED checkout never blocks a plan forever: it stops counting once it is past its expiry", async () => {
    const live = await api("POST", `/platform/plans/${ABANDONED_PLAN}/archive`, platformToken);
    expect(live.status, live.text).toBe(409);
    expect(live.body.code).toBe("PLAN_HAS_OPEN_CHECKOUTS");
    expect(live.body.context).toEqual({ count: 1 });
    // The tenant walked away; nothing ever closes the intent row. Time passes beyond the session's expiry.
    await db.update(billingCheckoutSessionsTable).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(billingCheckoutSessionsTable.id, C.intentId));
    const [row] = await db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.id, C.intentId));
    expect(row.status).toBe("open"); // still non-terminal in the table
    const res = await api("POST", `/platform/plans/${ABANDONED_PLAN}/archive`, platformToken);
    expect(res.status, res.text).toBe(200);
    expect(await planRow(ABANDONED_PLAN)).toMatchObject({ status: "archived", isActive: false });
    // An intent without a recorded expiry counts for 24 hours after its creation, then no longer.
    await db.update(plansTable).set({ status: "published", isActive: true }).where(eq(plansTable.id, ABANDONED_PLAN));
    await db.update(billingCheckoutSessionsTable).set({ expiresAt: null, createdAt: new Date(Date.now() - 23 * 3600_000) }).where(eq(billingCheckoutSessionsTable.id, C.intentId));
    expect((await api("POST", `/platform/plans/${ABANDONED_PLAN}/archive`, platformToken)).status).toBe(409);
    await db.update(billingCheckoutSessionsTable).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(billingCheckoutSessionsTable.id, C.intentId));
    expect((await api("POST", `/platform/plans/${ABANDONED_PLAN}/archive`, platformToken)).status).toBe(200);
  });

  it("an unreferenced published plan still archives normally", async () => {
    const res = await api("POST", `/platform/plans/${FREE_PLAN}/archive`, platformToken);
    expect(res.status, res.text).toBe(200);
    expect(await planRow(FREE_PLAN)).toMatchObject({ status: "archived", isActive: false });
  });
});

describe("provider events that arrive after the plan was archived", () => {
  beforeAll(async () => {
    // The state the guard cannot always prevent (a provider-side price change, an
    // archive racing a completing checkout): the plan is archived while tenants
    // are still mid-purchase. Set directly — the API refuses to create it.
    await db.update(plansTable).set({ status: "archived", isActive: false }).where(eq(plansTable.id, PLAN));
  });

  it("ordinary assignment paths stay strict: the archived plan cannot be assigned, bought or listed", async () => {
    const set = await api("POST", `/platform/subscriptions/${A.companyId}/plan`, platformToken, { plan: PLAN });
    expect(set.status, set.text).toBe(400);
    expect(set.body.code).toBe("INVALID_PLAN");
    const plans = (await api("GET", "/subscriptions/plans", A.token)).body as Array<{ id: string }>;
    expect(plans.map((p) => p.id)).not.toContain(PLAN);
    expect(await subRow(A)).toMatchObject({ plan: "free", billingSource: "manual", stripeSubscriptionId: null });
  });

  it("a checkout completed on the VERSION-BOUND price reconciles: the tenant gets exactly the version it bought, flagged for the operator", async () => {
    const res = await webhook("customer.subscription.created", subscriptionObject(A, PRICE_BOUND), T0 + 1);
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("applied");
    expect(await subRow(A)).toMatchObject({ billingSource: "stripe", plan: PLAN, planVersionId: v1, stripeSubscriptionId: A.providerSub, stripePriceId: PRICE_BOUND, providerStatus: "active", status: "active" });
    const sync = (await auditRows(A)).filter((r) => r.action === "subscription.provider_sync");
    expect(sync).toHaveLength(1);
    expect(sync[0].metadata).toMatchObject({ planChangeSource: "provider_price", priceScope: "version", pricePlanVersionId: v1, previousPlan: "free", planArchived: true });
    const [ev] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, res.id));
    expect(ev.failureCode).toBeNull();
    // The tenant signs in and works on the plan it paid for.
    const me = await api("GET", "/auth/me", A.token);
    expect(me.status).toBe(200);
    expect(me.body.entitlements.planVersionId).toBe(v1);
    expect((await api("GET", "/subscriptions/current", A.token)).body).toMatchObject({ plan: PLAN, planVersionId: v1 });
  });

  it("a checkout completed on the PLAN-WIDE price reconciles onto the plan's published version", async () => {
    const res = await webhook("customer.subscription.created", subscriptionObject(B, PRICE_WIDE), T0 + 2);
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("applied");
    expect(await subRow(B)).toMatchObject({ billingSource: "stripe", plan: PLAN, planVersionId: v1, stripeSubscriptionId: B.providerSub, stripePriceId: PRICE_WIDE, status: "active" });
    const sync = (await auditRows(B)).filter((r) => r.action === "subscription.provider_sync");
    expect(sync[0].metadata).toMatchObject({ planChangeSource: "provider_price", priceScope: "plan", previousPlan: "free", planArchived: true });
  });

  it("the pin written by reconciliation is consistent (the version belongs to the plan and is published)", async () => {
    for (const t of [A, B]) {
      const row = await subRow(t);
      const [version] = await db.select().from(planVersionsTable).where(eq(planVersionsTable.id, row.planVersionId!));
      expect(version.planId).toBe(row.plan);
      expect(version.publishedAt).not.toBeNull();
    }
  });

  it("later events of an existing provider subscription on the archived plan keep reconciling (status change, then the terminal cancellation)", async () => {
    const pastDue = await webhook("customer.subscription.updated", subscriptionObject(A, PRICE_BOUND, { status: "past_due" }), T0 + 10);
    expect(pastDue.status, pastDue.text).toBe(200);
    expect(pastDue.body.outcome).toBe("applied");
    expect(await subRow(A)).toMatchObject({ plan: PLAN, planVersionId: v1, providerStatus: "past_due" });
    const active = await webhook("customer.subscription.updated", subscriptionObject(A, PRICE_BOUND, { status: "active" }), T0 + 20);
    expect(active.status, active.text).toBe(200);
    expect(await subRow(A)).toMatchObject({ plan: PLAN, planVersionId: v1, providerStatus: "active", status: "active" });
    const cancelled = await webhook("customer.subscription.deleted", subscriptionObject(B, PRICE_WIDE, { status: "canceled" }), T0 + 30);
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.body.outcome).toBe("applied");
    expect(await subRow(B)).toMatchObject({ plan: PLAN, planVersionId: v1, providerStatus: "canceled" });
  });

  it("a price of a NEVER-PUBLISHED plan stays unmapped: refused for provider retry, nothing changes", async () => {
    const before = await subRow(A);
    const beforeAudit = (await auditRows(A)).length;
    // version-bound to the draft, and plan-wide on the never-published plan
    for (const [priceId, at] of [[PRICE_DRAFT, T0 + 40], [PRICE_DRAFT_WIDE, T0 + 41]] as const) {
      const res = await webhook("customer.subscription.updated", subscriptionObject(A, priceId), at);
      expect(res.status, `${priceId}: ${res.text}`).toBe(500);
      expect(res.body.outcome).toBe("failed");
      const [ev] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, res.id));
      expect(ev).toMatchObject({ outcome: "price_unmapped", failureCode: "PROVIDER_PRICE_UNMAPPED" });
    }
    expect(await subRow(A)).toMatchObject({ plan: before.plan, planVersionId: before.planVersionId, stripePriceId: before.stripePriceId, status: before.status });
    expect((await auditRows(A)).length).toBe(beforeAudit);
  });

  it("the operator sees the subscribers of the archived plan and it stays un-archivable-again / un-publishable", async () => {
    const detail = await api("GET", `/platform/plans/${PLAN}`, platformToken);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.status ?? detail.body.plan?.status).toBe("archived");
    const again = await api("POST", `/platform/plans/${PLAN}/archive`, platformToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PLAN_ARCHIVED");
    const rows = await db.select({ id: subscriptionsTable.id }).from(subscriptionsTable).where(eq(subscriptionsTable.plan, PLAN));
    expect(rows).toHaveLength(2);
  });
});
