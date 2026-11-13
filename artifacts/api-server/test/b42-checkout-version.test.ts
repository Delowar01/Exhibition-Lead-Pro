import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, subscriptionsTable, auditLogsTable, plansTable, planVersionsTable, planPricesTable, billingCheckoutSessionsTable, billingProviderEventsTable } from "@workspace/db";
import { signFakeWebhookPayload } from "../src/lib/billing/fake-provider.js";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 42 (PB-4.3) — checkout and provider reconciliation with VERSION-BOUND
// prices against the LIVE API and the FAKE provider (offline-signed webhooks):
//   • checkout sells a version-bound price only while its version is the plan's
//     CURRENT published version (draft / superseded bindings refused);
//   • a verified webhook on a version-bound price pins the tenant to EXACTLY
//     that version; a plan-wide price of the same plan never moves a pinned
//     subscriber (grandfathering); an unknown / draft-bound price is refused
//     (PROVIDER_PRICE_UNMAPPED, nothing changes, provider retries);
//   • duplicate deliveries are no-ops; provider identifiers are preserved;
//   • a provider-managed tenant is never changed by platform manual operations.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b42co-${SUFFIX}.test`;
const PLAN = `b42q-${SUFFIX}`;
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_V1 = "price_fake_eur_4900_month";
const PRICE_V2 = "price_fake_eur_5900_month";
const PRICE_V3_DRAFT = "price_fake_eur_6900_month";
const PRICE_WIDE_YEAR = "price_fake_eur_49000_year";
const PRICE_UNKNOWN = "price_fake_eur_7900_month";
const T0 = Math.floor(Date.now() / 1000) - 120;
const SUB = `sub_fake_b42_${SUFFIX}`;

let platformToken = "";
let tokenA = "";
let companyA = 0;
let subIdA = 0;
let v1 = 0;
let v2 = 0;
let v3 = 0;
let priceV1: Record<string, any> = {};
let priceV2: Record<string, any> = {};
let priceV3: Record<string, any> = {};
let priceYear: Record<string, any> = {};
let checkoutIntentId = 0;
const priceIds: number[] = [];
const eventIds: string[] = [];
const CUS = () => `cus_fake_${companyA}`;

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
async function subRow() {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyA));
  return row;
}
async function auditRows() {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyA), eq(auditLogsTable.entityType, "subscription")));
}
function subscriptionObject(priceId: string, o: Record<string, unknown> = {}) {
  return {
    id: SUB,
    object: "subscription",
    customer: CUS(),
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: priceId }, current_period_start: T0, current_period_end: T0 + 30 * 24 * 3600 }] },
    metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(checkoutIntentId) },
    ...o,
  };
}
async function webhook(type: string, object: Record<string, unknown>, created: number, opts: { id?: string } = {}) {
  const id = opts.id ?? `evt_b42_${SUFFIX}_${eventIds.length + 1}`;
  if (!opts.id) eventIds.push(id);
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
async function registerPrice(providerPriceId: string, planVersionId?: number) {
  const res = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId, ...(planVersionId ? { planVersionId } : {}) });
  expect(res.status, res.text).toBe(201);
  priceIds.push(res.body.id);
  return res.body;
}
async function openIntent() {
  const [row] = await db.select().from(billingCheckoutSessionsTable).where(and(eq(billingCheckoutSessionsTable.companyId, companyA), eq(billingCheckoutSessionsTable.status, "open")));
  return row;
}

beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set (fake provider)").not.toBe("");
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  expect((await api("GET", "/platform/billing/status", platformToken)).body).toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true });
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `Checkout ${SUFFIX}`, limits: {}, features: {} });
  expect(created.status, created.text).toBe(201);
  v1 = created.body.draft.id;
  priceV1 = await registerPrice(PRICE_V1, v1);
  priceYear = await registerPrice(PRICE_WIDE_YEAR);
  const published = await api("POST", `/platform/plans/${PLAN}/versions/${v1}/publish`, platformToken);
  expect(published.status, published.text).toBe(200);
  const company = await api("POST", "/companies", platformToken, { name: `QA B42 Checkout ${SUFFIX}`, plan: "free" });
  expect(company.status, company.text).toBe(201);
  companyA = company.body.id;
  const user = await api("POST", "/users", platformToken, { email: `admin@${DOMAIN}`, name: "admin", role: "primary_admin", companyId: companyA, password: PW });
  expect(user.status, user.text).toBe(201);
  tokenA = await login(`admin@${DOMAIN}`);
  subIdA = (await subRow()).id;
});

afterAll(async () => {
  if (companyA) {
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, companyA));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyA));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyA)); // cascades subscription + checkout sessions
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(billingProviderEventsTable).where(like(billingProviderEventsTable.eventId, `evt_b42_${SUFFIX}%`));
  if (priceIds.length) {
    await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), inArray(auditLogsTable.entityId, priceIds.map(String))));
    await db.delete(planPricesTable).where(inArray(planPricesTable.id, priceIds));
  }
  await db.delete(planPricesTable).where(eq(planPricesTable.planId, PLAN));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, PLAN));
  await db.delete(plansTable).where(eq(plansTable.id, PLAN));
});

describe("checkout with version-bound prices", () => {
  it("sells the price bound to the CURRENT published version; the subscription stays manual until the provider confirms", async () => {
    const plans = (await api("GET", "/subscriptions/plans", tokenA)).body as any[];
    expect(plans.find((p) => p.id === PLAN).prices.map((p: any) => p.id).sort()).toEqual([priceV1.id, priceYear.id].sort());
    const res = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceV1.id });
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe("created");
    const intent = await openIntent();
    expect(intent).toMatchObject({ planPriceId: priceV1.id, planId: PLAN, providerCustomerId: CUS() });
    const row = await subRow();
    expect(row).toMatchObject({ billingSource: "manual", plan: "free", stripeSubscriptionId: null, stripeCustomerId: CUS() });
    expect((await api("GET", "/subscriptions/current", tokenA)).body.plan).toBe("free");
  });

  it("refuses a price bound to a draft and, once v2 is current, the superseded v1 price; the v2 price and the plan-wide price stay purchasable", async () => {
    const draft = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v1 });
    expect(draft.status, draft.text).toBe(201);
    v2 = draft.body.id;
    priceV2 = await registerPrice(PRICE_V2, v2);
    const notYet = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceV2.id });
    expect(notYet.status).toBe(400);
    expect(notYet.body.code).toBe("PRICE_NOT_AVAILABLE");
    expect((await api("POST", `/platform/plans/${PLAN}/versions/${v2}/publish`, platformToken)).status).toBe(200);
    const superseded = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceV1.id });
    expect(superseded.status).toBe(400);
    expect(superseded.body.code).toBe("PRICE_NOT_AVAILABLE");
    const plans = (await api("GET", "/subscriptions/plans", tokenA)).body as any[];
    expect(plans.find((p) => p.id === PLAN).prices.map((p: any) => p.id).sort()).toEqual([priceV2.id, priceYear.id].sort());
    const current = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceV2.id });
    expect(current.status, current.text).toBe(200);
    expect(current.body.status).toBe("created"); // switched away from the (now unsellable) v1 intent
    const intent = await openIntent();
    expect(intent.planPriceId).toBe(priceV2.id);
    checkoutIntentId = intent.id;
    const rows = await db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.companyId, companyA));
    expect(rows.filter((r) => r.status === "open")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "expired")).toHaveLength(1);
    expect((await subRow()).billingSource).toBe("manual"); // still nothing changed by checkout itself
  });
});

describe("provider reconciliation pins the version the price identifies", () => {
  it("customer.subscription.created on the v2-bound price binds the tenant to plan v2 (provider identifiers preserved, audit sanitized)", async () => {
    const before = (await auditRows()).length;
    const res = await webhook("customer.subscription.created", subscriptionObject(PRICE_V2), T0 + 1);
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("applied");
    const row = await subRow();
    expect(row).toMatchObject({ billingSource: "stripe", plan: PLAN, planVersionId: v2, stripeSubscriptionId: SUB, stripeCustomerId: CUS(), stripePriceId: PRICE_V2, providerStatus: "active", status: "active" });
    const sync = (await auditRows()).filter((r) => r.action === "subscription.provider_sync");
    expect(sync).toHaveLength(1);
    expect(sync[0].metadata).toMatchObject({ planChangeSource: "provider_price", priceScope: "version", pricePlanVersionId: v2, previousPlan: "free" });
    expect(JSON.stringify(sync[0].metadata)).not.toContain(PRICE_V2);
    expect((await auditRows()).length).toBe(before + 1);
    expect((await api("GET", "/subscriptions/current", tokenA)).body).toMatchObject({ plan: PLAN, planVersionId: v2 });
  });

  it("a duplicate delivery is a 200 no-op", async () => {
    const before = (await auditRows()).length;
    const dup = await webhook("customer.subscription.created", subscriptionObject(PRICE_V2), T0 + 1, { id: eventIds[eventIds.length - 1] });
    expect(dup.status).toBe(200);
    expect(dup.body.outcome).toBe("duplicate");
    expect((await auditRows()).length).toBe(before);
    expect((await subRow()).planVersionId).toBe(v2);
  });

  it("a plan-wide price of the SAME plan never moves the pinned version (grandfathering); a v1-bound price pins exactly v1", async () => {
    const wide = await webhook("customer.subscription.updated", subscriptionObject(PRICE_WIDE_YEAR), T0 + 2);
    expect(wide.status, wide.text).toBe(200);
    expect(wide.body.outcome).toBe("applied");
    let row = await subRow();
    expect(row).toMatchObject({ plan: PLAN, planVersionId: v2, stripePriceId: PRICE_WIDE_YEAR, stripeSubscriptionId: SUB });
    const back = await webhook("customer.subscription.updated", subscriptionObject(PRICE_V1), T0 + 3);
    expect(back.status, back.text).toBe(200);
    expect(back.body.outcome).toBe("applied");
    row = await subRow();
    expect(row).toMatchObject({ plan: PLAN, planVersionId: v1, stripePriceId: PRICE_V1 });
    const last = (await auditRows()).filter((r) => r.action === "subscription.provider_sync").pop()!;
    expect(last.metadata).toMatchObject({ priceScope: "version", pricePlanVersionId: v1, previousPlanVersionId: v2 });
    // Stale (older) event never rewinds.
    const stale = await webhook("customer.subscription.updated", subscriptionObject(PRICE_V2), T0 + 2);
    expect(stale.status).toBe(200);
    expect(stale.body.outcome).toBe("stale");
    expect((await subRow()).planVersionId).toBe(v1);
  });

  it("an unknown price or a price bound to an UNPUBLISHED version is refused (PROVIDER_PRICE_UNMAPPED, 500 for provider retry) and changes nothing", async () => {
    const draft = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v2 });
    expect(draft.status, draft.text).toBe(201);
    v3 = draft.body.id;
    priceV3 = await registerPrice(PRICE_V3_DRAFT, v3);
    const beforeRow = await subRow();
    const beforeAudit = (await auditRows()).length;
    for (const priceId of [PRICE_V3_DRAFT, PRICE_UNKNOWN]) {
      const res = await webhook("customer.subscription.updated", subscriptionObject(priceId), T0 + 10);
      expect(res.status, res.text).toBe(500);
      expect(res.body.outcome).toBe("failed");
      const [ev] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, res.id));
      expect(ev).toMatchObject({ outcome: "price_unmapped", failureCode: "PROVIDER_PRICE_UNMAPPED" });
    }
    const after = await subRow();
    expect(after).toMatchObject({ plan: beforeRow.plan, planVersionId: beforeRow.planVersionId, stripePriceId: beforeRow.stripePriceId, status: beforeRow.status });
    expect((await auditRows()).length).toBe(beforeAudit);
    // The draft-bound price is still not sellable through checkout either.
    expect((await api("GET", "/subscriptions/plans", tokenA)).body.find((p: any) => p.id === PLAN).prices.map((p: any) => p.id)).not.toContain(priceV3.id);
  });

  it("manual / provider separation: platform manual plan changes and tenant migrations never touch a provider-managed tenant", async () => {
    const set = await api("POST", `/platform/subscriptions/${companyA}/plan`, platformToken, { plan: PLAN, planVersionId: v2 });
    expect(set.status).toBe(409);
    expect(set.body.code).toBe("MANAGED_BY_PROVIDER");
    const preview = await api("POST", `/platform/subscriptions/${companyA}/plan/preview`, platformToken, { plan: PLAN, planVersionId: v2 });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.transition).toEqual({ ok: false, code: "MANAGED_BY_PROVIDER" });
    expect(preview.body.eligible).toBe(false);
    const dry = await api("POST", `/platform/plans/${PLAN}/versions/${v2}/migrate`, platformToken, { dryRun: true, companyIds: [companyA] });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body.rows).toEqual([expect.objectContaining({ companyId: companyA, reason: "PROVIDER_MANAGED", billingSource: "stripe", outcome: "not_attempted" })]);
    expect(dry.body.summary.eligible).toBe(0);
    expect((await subRow()).planVersionId).toBe(v1);
    // The history projection shows the provider-driven changes with their price scope.
    const history = await api("GET", `/platform/subscriptions/${companyA}/plan-history`, platformToken);
    expect(history.status, history.text).toBe(200);
    expect(history.body.current).toMatchObject({ plan: PLAN, planVersionId: v1, billingSource: "stripe" });
    const kinds = history.body.entries.map((e: any) => e.kind);
    expect(kinds[0]).toBe("created");
    expect(kinds.filter((k: string) => k === "provider_sync").length).toBeGreaterThanOrEqual(2);
    expect(history.body.entries.filter((e: any) => e.kind === "provider_sync").every((e: any) => e.source === "provider_price")).toBe(true);
  });
});
