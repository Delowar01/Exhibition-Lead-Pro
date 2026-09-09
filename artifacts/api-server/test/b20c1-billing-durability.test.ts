import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq, and, inArray, like, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  subscriptionsTable,
  auditLogsTable,
  contactsTable,
  leadsTable,
  tasksTable,
  notificationsTable,
  planPricesTable,
  billingCheckoutSessionsTable,
  billingProviderEventsTable,
  subscriptionUsageReservationsTable,
  workflowRunsTable,
  workflowActionRunsTable,
  workflowDefinitionsTable,
} from "@workspace/db";
import { FakeBillingProvider } from "../src/lib/billing/fake-provider.js";
import { __setBillingProviderForTests } from "../src/lib/billing/provider.js";
import { __setBillingFaultsForTests } from "../src/lib/billing/test-faults.js";
import { processStripeWebhook } from "../src/services/billing-webhook.service.js";
import { createCheckout } from "../src/services/subscriptions.service.js";
import { assertCapacity, reserveScans, usageReport, effectiveLimitsFor } from "../src/services/entitlements.service.js";
import * as repo from "../src/repositories/subscriptions.repository.js";
import { loadAuthUserById } from "../src/middlewares/requireAuth.js";
import { dispatchWorkflowEvents } from "../src/lib/workflows/dispatch.js";
import { executeRun } from "../src/lib/workflows/engine.js";
import { leadCreatedEvent } from "../src/lib/workflows/events.js";
import type { JobQueue } from "../src/lib/jobs/types.js";
import { AppError } from "../src/middlewares/errorHandler.js";

// =============================================================================
// Batch 20 — Correction 1: Stripe durability, webhook concurrency and canonical
// integrity. Runs against the LIVE API (tenant / platform setup over HTTP) and
// IN-PROCESS against the same PostgreSQL database for the orchestration seams
// that need fault injection or a real concurrency barrier:
//   • Checkout: durable intent, stable customer / session keys, retry after a
//     local failure reuses the same remote objects, concurrent same-price → one
//     remote session, price switch expires the old session AT THE PROVIDER first,
//     provider expiry failure → no replacement.
//   • Cancelled provider subscription self-recovers through Checkout (order
//     independent); a stray subscription of the same customer never takes over;
//     a late event for the old subscription changes nothing; two live
//     subscriptions → deterministic recorded conflict.
//   • Unknown price cannot change entitlement (sanitized failure, retry after
//     registration); mode mismatch cannot change data.
//   • Webhook concurrency: two simultaneous deliveries → one mutation; a
//     duplicate never downgrades processed → failed; retry after a genuine failure
//     succeeds exactly once; rollback leaves entitlement untouched and retryable.
//   • Fail-closed entitlement services; workflow execution refuses read-only /
//     blocked tenants with no side effect; final DB constraints reject invalid
//     direct writes.
// The fake provider is TEST mode; no network, no real Stripe / email / Gemini.
// Test-only fault hooks are reset after EVERY test.
// =============================================================================

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b20c1-${SUFFIX}.test`;
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_M = "price_fake_usd_3100_month"; // professional
const PRICE_Y = "price_fake_usd_120000_year"; // business
const PRICE_UNKNOWN = "price_fake_usd_777_month"; // provider knows it, platform never registered it
const PRICE_LIVE = "price_fake_live_usd_3100_month"; // LIVE-mode price (fake synthesizes livemode=true)
const T0 = Math.floor(Date.now() / 1000) - 600;

let platformToken = "";
let tokenA = "";
let companyA = 0;
let companyB = 0;
let companyC = 0;
let adminAId = 0;
let subIdA = 0;
let priceM: Record<string, any> = {};
let priceY: Record<string, any> = {};
const companyIds: number[] = [];
const eventIds: string[] = [];
let fake: FakeBillingProvider;
let eventSeq = 0;

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
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as Record<string, any>, text };
}
const platformOp = (companyId: number, action: string, body?: unknown) => api("POST", `/platform/subscriptions/${companyId}/${action}`, platformToken, body);
const detail = async (companyId: number) => (await api("GET", `/platform/subscriptions/${companyId}`, platformToken)).body;
const current = async (token: string) => (await api("GET", "/subscriptions/current", token)).body;

async function subRow(companyId: number) {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId));
  return row;
}
async function checkoutRows(companyId: number) {
  return db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.companyId, companyId)).orderBy(billingCheckoutSessionsTable.id);
}
async function eventRow(eventId: string) {
  const [row] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, eventId));
  return row;
}
async function auditRows(companyId: number, action?: string) {
  const rows = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyId), eq(auditLogsTable.entityType, "subscription"))).orderBy(auditLogsTable.id);
  return action ? rows.filter((r) => r.action === action) : rows;
}
const actor = () => ({ userId: adminAId, userName: `admin-a@${DOMAIN}`, ipAddress: null });
async function checkoutAs(planPriceId: number) {
  const user = await loadAuthUserById(adminAId);
  if (!user) throw new Error("admin A missing");
  return createCheckout(user, { planPriceId }, actor());
}
async function expectAppError(p: Promise<unknown>, code: string, status?: number) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${code}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status) expect((err as AppError).statusCode).toBe(status);
  return err as AppError;
}

function subscriptionObject(o: Record<string, unknown>) {
  return {
    id: `sub_fake_c1_${SUFFIX}`,
    object: "subscription",
    customer: CUS_A(),
    status: "active",
    livemode: false,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: PRICE_M }, current_period_start: T0, current_period_end: T0 + 30 * 24 * 3600 }] },
    metadata: { companyId: String(companyA), subscriptionId: String(subIdA) },
    ...o,
  };
}
function eventPayload(type: string, object: Record<string, unknown>, created: number, id?: string) {
  const eventId = id ?? `evt_b20c1_${SUFFIX}_${++eventSeq}`;
  if (!eventIds.includes(eventId)) eventIds.push(eventId);
  return { id: eventId, payload: JSON.stringify({ id: eventId, object: "event", type, created, livemode: false, data: { object } }) };
}
// In-process delivery (same DB as the API; this process' fake provider instance).
async function deliver(type: string, object: Record<string, unknown>, created: number, opts: { id?: string; raw?: string } = {}) {
  const { id, payload } = opts.raw ? { id: opts.id!, payload: opts.raw } : eventPayload(type, object, created, opts.id);
  const res = await processStripeWebhook(Buffer.from(payload), fake.signPayload(payload), fake);
  return { ...res, id, payload };
}

function fakeQueue(): JobQueue {
  return { driver: "fake", register: () => undefined, enqueue: async () => undefined, start: () => undefined, stop: async () => undefined, stats: () => ({ pending: 0, active: 0, enqueued: 0, completed: 0, failed: 0, deadLettered: 0 }) };
}

beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set (fake provider)").not.toBe("");
  fake = new FakeBillingProvider(SECRET);
  __setBillingProviderForTests(fake);
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const status = await api("GET", "/platform/billing/status", platformToken);
  expect(status.body, "the API must run with BILLING_PROVIDER=fake").toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true, stripeMode: "test", returnUrlConfigured: true, returnUrlReason: null });
  await db.delete(planPricesTable).where(inArray(planPricesTable.providerPriceId, [PRICE_M, PRICE_Y, PRICE_UNKNOWN, PRICE_LIVE]));
  for (const [name, setter] of [
    [`QA B20C1 A ${SUFFIX}`, (id: number) => (companyA = id)],
    [`QA B20C1 B ${SUFFIX}`, (id: number) => (companyB = id)],
    [`QA B20C1 C ${SUFFIX}`, (id: number) => (companyC = id)],
  ] as const) {
    const res = await api("POST", "/companies", platformToken, { name, plan: "free" });
    expect(res.status, res.text).toBe(201);
    setter(res.body.id);
    companyIds.push(res.body.id);
  }
  const u = await api("POST", "/users", platformToken, { email: `admin-a@${DOMAIN}`, name: "Admin A", role: "primary_admin", companyId: companyA, password: PW });
  expect(u.status, u.text).toBe(201);
  adminAId = u.body.id;
  tokenA = await login(`admin-a@${DOMAIN}`);
  subIdA = (await subRow(companyA)).id;
  for (const [planId, providerPriceId, setter] of [
    ["professional", PRICE_M, (p: any) => (priceM = p)],
    ["business", PRICE_Y, (p: any) => (priceY = p)],
  ] as const) {
    const res = await api("POST", "/platform/billing/prices", platformToken, { planId, providerPriceId });
    expect(res.status, res.text).toBe(201);
    setter(res.body);
  }
});

afterEach(() => {
  // Test-only fault hooks and provider fault switches never leak between tests.
  __setBillingFaultsForTests({});
  fake.__failNextCall(null);
});

afterAll(async () => {
  __setBillingFaultsForTests({});
  __setBillingProviderForTests(null);
  if (companyIds.length) {
    await db.delete(workflowRunsTable).where(inArray(workflowRunsTable.companyId, companyIds));
    await db.delete(workflowDefinitionsTable).where(inArray(workflowDefinitionsTable.companyId, companyIds));
    await db.delete(tasksTable).where(inArray(tasksTable.companyId, companyIds));
    await db.delete(notificationsTable).where(inArray(notificationsTable.companyId, companyIds));
    await db.delete(leadsTable).where(inArray(leadsTable.companyId, companyIds));
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(subscriptionUsageReservationsTable).where(inArray(subscriptionUsageReservationsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(billingProviderEventsTable).where(like(billingProviderEventsTable.eventId, `evt_b20c1_${SUFFIX}%`));
  await db.delete(planPricesTable).where(inArray(planPricesTable.providerPriceId, [PRICE_M, PRICE_Y, PRICE_UNKNOWN, PRICE_LIVE]));
  await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), like(auditLogsTable.action, "billing.price_mapping.%")));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§2 durable Checkout — stable keys, retries, concurrency, provider-side expiration", () => {
  it("customer creation retry after a local failure reuses the SAME provider customer (stable key)", async () => {
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterCustomerCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated local failure after provider customer creation");
      },
    });
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated local failure");
    // The intent is durable (creating), the customer is NOT linked locally yet.
    let rows = await checkoutRows(companyA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "creating", providerSessionId: null, planPriceId: priceM.id, providerMode: "test" });
    expect(rows[0].idempotencyKey).toMatch(/^checkout:[a-f0-9]{64}$/);
    expect((await subRow(companyA)).stripeCustomerId).toBeNull();
    expect(fake.calls.createCustomer).toBe(1);
    // Retry: same durable intent, same customer key → same customer id; one session.
    const out = await checkoutAs(priceM.id);
    expect(out.status).toBe("created");
    expect(out.url).toMatch(/^https:\/\/checkout\.fake\.local\//);
    expect(fake.calls.createCustomer).toBe(2);
    expect((await subRow(companyA)).stripeCustomerId).toBe(CUS_A());
    rows = await checkoutRows(companyA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: rows[0].id, status: "open", providerCustomerId: CUS_A() });
    expect(rows[0].providerSessionId).toMatch(/^cs_fake_/);
    expect(rows[0].expiresAt).not.toBeNull();
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    expect(fake.remoteSession(rows[0].providerSessionId!)!.metadata).toMatchObject({ companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(rows[0].id), planId: "professional" });
    // Entitlement untouched; the hosted URL is never stored.
    expect(await subRow(companyA)).toMatchObject({ plan: "free", billingSource: "manual", stripeSubscriptionId: null });
    expect(JSON.stringify(rows)).not.toContain("checkout.fake.local");
  });

  it("session creation retry after a local failure (process-style) reuses the SAME remote session; no orphan", async () => {
    // Retire the open intent by expiring it at the provider (tested on its own below), then start over.
    const open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    await fake.expireCheckoutSession(open.providerSessionId!);
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash after provider session creation");
      },
    });
    fake.__resetCounters();
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated crash");
    let rows = await checkoutRows(companyA);
    expect(rows.map((r) => r.status)).toEqual(["expired", "creating"]);
    expect(rows[1].providerSessionId).toBeNull();
    expect(fake.calls.createCheckoutSession).toBe(1);
    const remoteBefore = fake.remoteSessions().filter((s) => s.status === "open");
    expect(remoteBefore).toHaveLength(1);
    // "New process": nothing in memory but the durable intent + the provider's state.
    __setBillingFaultsForTests({});
    const out = await checkoutAs(priceM.id);
    expect(out.status).toBe("created");
    expect(fake.calls.createCheckoutSession).toBe(2); // same idempotency key → same session
    rows = await checkoutRows(companyA);
    expect(rows.map((r) => r.status)).toEqual(["expired", "open"]);
    expect(rows[1].providerSessionId).toBe(remoteBefore[0].id);
    expect(fake.remoteSessions().filter((s) => s.status === "open")).toHaveLength(1);
    // Third call: reused.
    expect((await checkoutAs(priceM.id)).status).toBe("reused");
  });

  it("concurrent same-price requests produce exactly ONE remote session and one open intent", async () => {
    const open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    await fake.expireCheckoutSession(open.providerSessionId!);
    fake.__resetCounters();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => checkoutAs(priceM.id)));
    const ok = results.filter((r): r is PromiseFulfilledResult<{ url: string; status: string }> => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failed) expect((f.reason as AppError).code, String(f.reason)).toBe("CHECKOUT_IN_PROGRESS");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.url)).size).toBe(1);
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    const rows = await checkoutRows(companyA);
    expect(rows.filter((r) => r.status === "open" || r.status === "creating")).toHaveLength(1);
    // Every remote call carried the same key: the fake minted a single session.
    expect(fake.remoteSessions().filter((s) => s.customerId === CUS_A() && s.status === "open")).toHaveLength(1);
  });

  it("switching price expires the old session AT THE PROVIDER, confirms, marks it expired locally, then creates the replacement", async () => {
    const before = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    fake.__resetCounters();
    const out = await checkoutAs(priceY.id);
    expect(out.status).toBe("created");
    expect(fake.calls.expireCheckoutSession).toBe(1);
    expect(fake.remoteSession(before.providerSessionId!)!.status).toBe("expired");
    const rows = await checkoutRows(companyA);
    const old = rows.find((r) => r.id === before.id)!;
    expect(old.status).toBe("expired");
    const fresh = rows.find((r) => r.status === "open")!;
    expect(fresh).toMatchObject({ planPriceId: priceY.id, planId: "business" });
    expect(fresh.id).toBeGreaterThan(before.id);
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    expect((await auditRows(companyA, "subscription.checkout_expired")).length).toBeGreaterThanOrEqual(1);
  });

  it("when the provider refuses to expire the old session: no local change, no replacement; retry succeeds", async () => {
    const before = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    fake.__failNextCall("StripeAPIError", "expireCheckoutSession");
    fake.__resetCounters();
    await expectAppError(checkoutAs(priceM.id), "PROVIDER_ERROR", 502);
    expect(fake.calls.expireCheckoutSession).toBe(1);
    expect(fake.calls.createCheckoutSession).toBe(0);
    expect(fake.remoteSession(before.providerSessionId!)!.status).toBe("open");
    const rows = await checkoutRows(companyA);
    expect(rows.find((r) => r.id === before.id)!.status).toBe("open");
    expect(rows.filter((r) => r.status === "open" || r.status === "creating")).toHaveLength(1);
    expect(rows.filter((r) => r.planPriceId === priceM.id && r.id > before.id)).toHaveLength(0);
    // Provider recovered → the switch completes.
    const out = await checkoutAs(priceM.id);
    expect(out.status).toBe("created");
    expect(fake.remoteSession(before.providerSessionId!)!.status).toBe("expired");
    expect((await checkoutRows(companyA)).filter((r) => r.status === "open")).toHaveLength(1);
  });

  it("the tenant HTTP route exposes only open|reused and the durable intent states are constrained", async () => {
    const res = await api("POST", "/subscriptions/checkout", tokenA, { planPriceId: priceM.id });
    // The API process holds its own fake registry: it retrieves this process' session id
    // and finds nothing → retires the intent and mints its own (still one open intent).
    expect([200, 409]).toContain(res.status);
    const rows = await checkoutRows(companyA);
    expect(rows.filter((r) => r.status === "open" || r.status === "creating")).toHaveLength(1);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set([...new Set(rows.map((r) => r.status))].filter((s) => ["creating", "open", "completed", "expired", "failed"].includes(s))));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§3 cancelled provider subscription self-recovers through Checkout; ownership rules", () => {
  const SUB1 = `sub_fake_c1_${SUFFIX}`;
  const SUB2 = `sub_fake_c1_second_${SUFFIX}`;
  const STRAY = `sub_fake_c1_stray_${SUFFIX}`;
  let intent1: number;
  let intent2: number;

  it("binds the first subscription through checkout.session.completed (session → subscription linkage)", async () => {
    // Make sure THIS process' fake holds the current open intent's session (re-mint if the API process created it).
    let open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    if (!fake.remoteSession(open.providerSessionId!)) {
      await db.transaction((tx) => repo.transitionCheckoutSession(open.id, ["open"], { status: "expired" }, tx));
      await checkoutAs(priceM.id);
      open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    }
    intent1 = open.id;
    fake.__seedSubscription(subscriptionObject({ id: SUB1, metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(open.id) } }), T0 + 10);
    const done = await deliver("checkout.session.completed", { id: open.providerSessionId, object: "checkout.session", livemode: false, status: "complete", customer: CUS_A(), subscription: SUB1, client_reference_id: String(open.id), metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(open.id) } }, T0 + 11);
    expect(done.outcome).toBe("applied");
    expect(await subRow(companyA)).toMatchObject({ billingSource: "stripe", status: "active", plan: "professional", stripeSubscriptionId: SUB1, stripeCustomerId: CUS_A(), stripePriceId: PRICE_M });
    const rows = await checkoutRows(companyA);
    expect(rows.find((r) => r.id === open.id)).toMatchObject({ status: "completed", providerSubscriptionId: SUB1 });
    expect((await current(tokenA))).toMatchObject({ accessMode: "full", billing: { checkoutAvailable: false, checkoutUnavailableReason: "LIVE_SUBSCRIPTION_EXISTS", portalAvailable: true } });
  });

  it("a stray LIVE subscription of the same customer is a recorded conflict; the bound row is untouched", async () => {
    const before = await subRow(companyA);
    const stray = await deliver("customer.subscription.created", subscriptionObject({ id: STRAY, metadata: {} }), T0 + 20);
    expect(stray.outcome).toBe("conflict");
    expect(await eventRow(stray.id)).toMatchObject({ status: "ignored", outcome: "conflict", companyId: companyA, attempts: 1 });
    const after = await subRow(companyA);
    expect(after.stripeSubscriptionId).toBe(SUB1);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const d = await detail(companyA);
    expect(d.providerConflict).toMatchObject({ eventType: "customer.subscription.created" });
    expect(d.providerConflict.eventRef).not.toBe(stray.id);
    expect((await auditRows(companyA, "subscription.provider_conflict")).length).toBe(1);
    // Even a stray subscription that carries this tenant's metadata cannot displace a LIVE binding.
    const forged = await deliver("customer.subscription.created", subscriptionObject({ id: `${STRAY}_meta` }), T0 + 21);
    expect(forged.outcome).toBe("conflict");
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB1);
  });

  it("provider cancellation → read-only, Checkout available again, history preserved", async () => {
    const deleted = await deliver("customer.subscription.deleted", subscriptionObject({ id: SUB1, status: "canceled", canceled_at: T0 + 30, ended_at: T0 + 30 }), T0 + 30);
    expect(deleted.outcome).toBe("applied");
    const c = await current(tokenA);
    expect(c).toMatchObject({ status: "cancelled", accessMode: "read_only", billingSource: "stripe", providerSubscriptionLinked: true });
    expect(c.billing.checkoutAvailable).toBe(true);
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB1); // the terminal binding is kept (history), not deleted
  });

  it("a random subscription for the same customer cannot take over the cancelled binding (no linkage)", async () => {
    const before = await subRow(companyA);
    const r = await deliver("customer.subscription.created", subscriptionObject({ id: `${STRAY}_after`, metadata: {} }), T0 + 40);
    expect(r.outcome).toBe("unbound");
    const after = await subRow(companyA);
    expect(after).toMatchObject({ status: "cancelled", stripeSubscriptionId: SUB1 });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("re-subscribing through Checkout replaces the terminal binding — created BEFORE completed (order independent)", async () => {
    const out = await checkoutAs(priceY.id);
    expect(out.status).toBe("created");
    const open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    intent2 = open.id;
    expect(intent2).toBeGreaterThan(intent1);
    const meta = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(open.id) };
    // 1) customer.subscription.created arrives first (Stripe copies subscription_data.metadata).
    const created = await deliver("customer.subscription.created", subscriptionObject({ id: SUB2, metadata: meta, items: { data: [{ price: { id: PRICE_Y }, current_period_start: T0 + 50, current_period_end: T0 + 400 * 24 * 3600 }] } }), T0 + 50);
    expect(created.outcome).toBe("applied");
    let row = await subRow(companyA);
    expect(row).toMatchObject({ status: "active", billingSource: "stripe", plan: "business", stripeSubscriptionId: SUB2, stripePriceId: PRICE_Y, stripeCustomerId: CUS_A() });
    const replaced = await auditRows(companyA, "subscription.provider_replaced");
    expect(replaced).toHaveLength(1);
    expect(JSON.stringify(replaced[0].metadata)).not.toContain(SUB1);
    // 2) checkout.session.completed arrives later: completes the intent, changes nothing else.
    const done = await deliver("checkout.session.completed", { id: open.providerSessionId, object: "checkout.session", livemode: false, status: "complete", customer: CUS_A(), subscription: SUB2, client_reference_id: String(open.id), metadata: meta }, T0 + 51);
    expect(["applied", "no_change"]).toContain(done.outcome);
    expect((await checkoutRows(companyA)).find((r) => r.id === open.id)).toMatchObject({ status: "completed", providerSubscriptionId: SUB2 });
    row = await subRow(companyA);
    expect(row.stripeSubscriptionId).toBe(SUB2);
    expect((await current(tokenA)).accessMode).toBe("full");
  });

  it("a late event for the OLD subscription never overwrites the new binding", async () => {
    const before = await subRow(companyA);
    const late = await deliver("customer.subscription.updated", subscriptionObject({ id: SUB1, status: "canceled", canceled_at: T0 + 30, ended_at: T0 + 30 }), T0 + 60);
    expect(late.outcome).toBe("unbound");
    const after = await subRow(companyA);
    expect(after).toMatchObject({ status: "active", stripeSubscriptionId: SUB2 });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("recovery also works when completed arrives BEFORE created, and company/customer/intent must agree", async () => {
    // Cancel SUB2, re-checkout, then deliver completed first with the provider already holding SUB3.
    expect((await deliver("customer.subscription.deleted", subscriptionObject({ id: SUB2, status: "canceled", canceled_at: T0 + 70, ended_at: T0 + 70 }), T0 + 70)).outcome).toBe("applied");
    expect((await current(tokenA)).status).toBe("cancelled");
    expect((await checkoutAs(priceM.id)).status).toBe("created");
    const open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    const SUB3 = `sub_fake_c1_third_${SUFFIX}`;
    const meta = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(open.id) };
    // Wrong tenant metadata on the session → mismatch, nothing changes.
    const wrong = await deliver("checkout.session.completed", { id: open.providerSessionId, object: "checkout.session", livemode: false, status: "complete", customer: CUS_A(), subscription: SUB3, metadata: { companyId: String(companyB), subscriptionId: String(subIdA), checkoutId: String(open.id) } }, T0 + 80);
    expect(wrong.outcome).toBe("mismatch");
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB2);
    // Provider holds SUB3 (seeded); completed arrives before created.
    fake.__seedSubscription(subscriptionObject({ id: SUB3, metadata: meta }), T0 + 81);
    const done = await deliver("checkout.session.completed", { id: open.providerSessionId, object: "checkout.session", livemode: false, status: "complete", customer: CUS_A(), subscription: SUB3, client_reference_id: String(open.id), metadata: meta }, T0 + 82);
    expect(done.outcome).toBe("applied");
    expect(await subRow(companyA)).toMatchObject({ status: "active", plan: "professional", stripeSubscriptionId: SUB3 });
    const created = await deliver("customer.subscription.created", subscriptionObject({ id: SUB3, metadata: meta }), T0 + 83);
    expect(["applied", "no_change"]).toContain(created.outcome);
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB3);
    expect((await auditRows(companyA, "subscription.provider_replaced")).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§5/§6 verified price requirement and explicit Stripe mode", () => {
  it("a Portal price change to an UNREGISTERED price cannot change entitlement; sanitized failure; retry after registration applies", async () => {
    const bound = (await subRow(companyA)).stripeSubscriptionId!;
    const before = await subRow(companyA);
    const obj = subscriptionObject({ id: bound, items: { data: [{ price: { id: PRICE_UNKNOWN }, current_period_start: T0 + 90, current_period_end: T0 + 120 * 24 * 3600 }] } });
    const first = await deliver("customer.subscription.updated", obj, T0 + 90);
    expect(first).toMatchObject({ httpStatus: 500, outcome: "failed" });
    const row = await eventRow(first.id);
    expect(row).toMatchObject({ status: "failed", outcome: "price_unmapped", failureCode: "PROVIDER_PRICE_UNMAPPED", attempts: 1 });
    expect(JSON.stringify(row)).not.toContain(PRICE_UNKNOWN);
    const after = await subRow(companyA);
    expect(after).toMatchObject({ plan: before.plan, stripePriceId: before.stripePriceId, status: before.status });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const d = await detail(companyA);
    expect(d.providerPriceUnmapped).toMatchObject({ eventType: "customer.subscription.updated", attempts: 1 });
    expect(JSON.stringify(d)).not.toContain(PRICE_UNKNOWN);
    // Operator registers the price → the provider's retry of the SAME event applies exactly once.
    const reg = await api("POST", "/platform/billing/prices", platformToken, { planId: "enterprise", providerPriceId: PRICE_UNKNOWN });
    expect(reg.status, reg.text).toBe(201);
    const retry = await deliver("customer.subscription.updated", obj, T0 + 90, { id: first.id, raw: first.payload });
    expect(retry.outcome).toBe("applied");
    expect(await eventRow(first.id)).toMatchObject({ status: "processed", outcome: "applied", attempts: 2, failureCode: null });
    expect(await subRow(companyA)).toMatchObject({ plan: "enterprise", stripePriceId: PRICE_UNKNOWN });
    expect((await detail(companyA)).providerPriceUnmapped).toBeNull();
    // A terminal event still cancels without any price.
    const off = await api("PATCH", `/platform/billing/prices/${reg.body.id}`, platformToken, { active: false });
    expect(off.status).toBe(200);
    expect((await deliver("customer.subscription.updated", subscriptionObject({ id: bound, status: "past_due", items: { data: [{ price: { id: PRICE_UNKNOWN }, current_period_start: T0 + 90, current_period_end: T0 + 120 * 24 * 3600 }] } }), T0 + 91)).outcome).toBe("applied"); // inactive mapping still resolves an existing subscription
    expect((await subRow(companyA)).status).toBe("past_due");
    const deleted = await deliver("customer.subscription.deleted", subscriptionObject({ id: bound, status: "canceled", canceled_at: T0 + 92, ended_at: T0 + 92, items: { data: [{ price: { id: "price_fake_usd_1_month" }, current_period_start: T0 + 90, current_period_end: T0 + 120 * 24 * 3600 }] } }), T0 + 92);
    expect(deleted.outcome).toBe("applied");
    expect((await subRow(companyA)).status).toBe("cancelled");
  });

  it("a NEW live subscription with an unknown price cannot bind; inactive mappings never open Checkout", async () => {
    const before = await subRow(companyB);
    const SUBB = `sub_fake_c1_b_${SUFFIX}`;
    const r = await deliver("customer.subscription.created", subscriptionObject({ id: SUBB, customer: `cus_fake_${companyB}`, metadata: { companyId: String(companyB), subscriptionId: String(before.id) }, items: { data: [{ price: { id: "price_fake_usd_555_month" }, current_period_start: T0, current_period_end: T0 + 30 * 24 * 3600 }] } }), T0 + 100);
    expect(r).toMatchObject({ httpStatus: 500, outcome: "failed" });
    expect(await eventRow(r.id)).toMatchObject({ status: "failed", outcome: "price_unmapped" });
    expect(await subRow(companyB)).toMatchObject({ billingSource: "manual", stripeSubscriptionId: null, plan: "free" });
    // Inactive mapping: existing subscriptions resolve (above), NEW Checkout is refused.
    const inactive = (await api("GET", "/platform/billing/prices", platformToken)).body.prices.find((p: any) => p.providerMode === "test" && p.active === false);
    expect(inactive).toBeTruthy();
    await expectAppError(checkoutAs(inactive.id), "PRICE_NOT_AVAILABLE", 400);
  });

  it("a LIVE-mode price cannot enter the TEST catalog; a LIVE webhook cannot change data or be recorded", async () => {
    const live = await api("POST", "/platform/billing/prices", platformToken, { planId: "professional", providerPriceId: PRICE_LIVE });
    expect(live.status).toBe(400);
    expect(live.body.code).toBe("PRICE_MODE_MISMATCH");
    expect((await db.select().from(planPricesTable).where(eq(planPricesTable.providerPriceId, PRICE_LIVE))).length).toBe(0);
    for (const p of (await api("GET", "/platform/billing/prices", platformToken)).body.prices) expect(p.providerMode).toBe("test");

    const before = await subRow(companyA);
    const bound = before.stripeSubscriptionId!;
    // Event livemode=true (object test) → rejected; object livemode=true (event test) → rejected.
    const id1 = `evt_b20c1_${SUFFIX}_live1`;
    const id2 = `evt_b20c1_${SUFFIX}_live2`;
    eventIds.push(id1, id2);
    const p1 = JSON.stringify({ id: id1, object: "event", type: "customer.subscription.updated", created: T0 + 110, livemode: true, data: { object: subscriptionObject({ id: bound, status: "active" }) } });
    const p2 = JSON.stringify({ id: id2, object: "event", type: "customer.subscription.updated", created: T0 + 111, livemode: false, data: { object: subscriptionObject({ id: bound, status: "active", livemode: true }) } });
    for (const p of [p1, p2]) {
      let err: any = null;
      try {
        await processStripeWebhook(Buffer.from(p), fake.signPayload(p), fake);
      } catch (e) {
        err = e;
      }
      expect(err?.httpStatus).toBe(400);
      expect(err?.code).toBe("LIVEMODE_MISMATCH");
    }
    expect(await eventRow(id1)).toBeUndefined();
    expect(await eventRow(id2)).toBeUndefined();
    const after = await subRow(companyA);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // The HTTP route answers the same way (API process, same rule).
    const res = await fetch(`${BASE.replace(/\/api$/, "")}/api/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": fake.signPayload(p1) }, body: p1 });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§4 race-safe webhook idempotency (real PostgreSQL concurrency)", () => {
  let bound = "";
  beforeAll(async () => {
    // Bring A back to a LIVE provider subscription for the concurrency scenarios.
    const SUB4 = `sub_fake_c1_fourth_${SUFFIX}`;
    expect((await checkoutAs(priceM.id)).status).toBe("created");
    const open = (await checkoutRows(companyA)).find((r) => r.status === "open")!;
    const meta = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(open.id) };
    expect((await deliver("customer.subscription.created", subscriptionObject({ id: SUB4, metadata: meta }), T0 + 200)).outcome).toBe("applied");
    bound = SUB4;
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB4);
  });

  it("two simultaneous deliveries of one event → one mutation, one audit transition, applied + duplicate", async () => {
    const { id, payload } = eventPayload("customer.subscription.updated", subscriptionObject({ id: bound, status: "past_due" }), T0 + 210);
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    __setBillingFaultsForTests({
      "webhook.beforeClaim": async () => {
        arrived += 1;
        if (arrived === 2) release();
        await gate; // barrier: both deliveries verified + prefetched, now race the claim
      },
    });
    const sig = fake.signPayload(payload);
    const syncBefore = (await auditRows(companyA, "subscription.provider_sync")).length;
    const [r1, r2] = await Promise.all([processStripeWebhook(Buffer.from(payload), sig, fake), processStripeWebhook(Buffer.from(payload), sig, fake)]);
    expect(arrived).toBe(2);
    expect([r1.outcome, r2.outcome].sort()).toEqual(["applied", "duplicate"]);
    expect(r1.httpStatus).toBe(200);
    expect(r2.httpStatus).toBe(200);
    expect(await eventRow(id)).toMatchObject({ status: "processed", outcome: "applied", attempts: 1, companyId: companyA });
    expect((await subRow(companyA)).status).toBe("past_due");
    expect((await auditRows(companyA, "subscription.provider_sync")).length).toBe(syncBefore + 1);
    expect((await auditRows(companyA, "subscription.provider_sync")).filter((a) => JSON.stringify(a.metadata).includes(id))).toHaveLength(1);
  });

  it("a delivery that fails while the winner is mid-transaction never downgrades processed → failed; attempts stay exact", async () => {
    const { id, payload } = eventPayload("customer.subscription.updated", subscriptionObject({ id: bound, status: "active" }), T0 + 220);
    const sig = fake.signPayload(payload);
    let releaseCommit: () => void = () => undefined;
    const holdCommit = new Promise<void>((r) => (releaseCommit = r));
    __setBillingFaultsForTests({ "webhook.beforeCommit": () => holdCommit });
    // A: applies the state and parks INSIDE its transaction (row inserted, uncommitted).
    const a = processStripeWebhook(Buffer.from(payload), sig, fake);
    await new Promise((r) => setTimeout(r, 150));
    // B: same event; its provider fetch fails → the failure recorder runs against the
    // uncommitted claim (blocks on the unique index until A commits).
    __setBillingFaultsForTests({});
    fake.__failNextCall("StripeConnectionError", "retrieveSubscription");
    const b = processStripeWebhook(Buffer.from(payload), sig, fake);
    await new Promise((r) => setTimeout(r, 250));
    releaseCommit();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe("applied");
    expect(rb).toMatchObject({ httpStatus: 500, outcome: "failed" });
    // Durable truth: processed, attempts exactly 1, no failure code.
    expect(await eventRow(id)).toMatchObject({ status: "processed", outcome: "applied", attempts: 1, failureCode: null });
    expect((await subRow(companyA)).status).toBe("active");
    // And a plain re-delivery afterwards is a duplicate (never re-applied).
    expect((await processStripeWebhook(Buffer.from(payload), sig, fake)).outcome).toBe("duplicate");
    // The recorder itself refuses to touch a processed / ignored row.
    expect(await repo.recordProviderEventFailure({ provider: "stripe", providerMode: "test", eventId: id, eventType: "customer.subscription.updated", providerCreatedAt: new Date(), failureCode: "Simulated" })).toBeUndefined();
    expect(await eventRow(id)).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("retry after a genuine failure succeeds exactly once; attempts increment once per attempt", async () => {
    const { id, payload } = eventPayload("customer.subscription.updated", subscriptionObject({ id: bound, status: "past_due" }), T0 + 230);
    const sig = fake.signPayload(payload);
    const before = await subRow(companyA);
    fake.__failNextCall("StripeConnectionError", "retrieveSubscription");
    expect(await processStripeWebhook(Buffer.from(payload), sig, fake)).toMatchObject({ httpStatus: 500, outcome: "failed" });
    expect(await eventRow(id)).toMatchObject({ status: "failed", failureCode: "StripeConnectionError", attempts: 1 });
    expect((await subRow(companyA)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await processStripeWebhook(Buffer.from(payload), sig, fake)).outcome).toBe("applied");
    expect(await eventRow(id)).toMatchObject({ status: "processed", outcome: "applied", attempts: 2, failureCode: null });
    expect((await subRow(companyA)).status).toBe("past_due");
    expect((await processStripeWebhook(Buffer.from(payload), sig, fake)).outcome).toBe("duplicate");
    expect(await eventRow(id)).toMatchObject({ attempts: 2 });
    expect((await auditRows(companyA, "subscription.provider_sync")).filter((a) => JSON.stringify(a.metadata).includes(id))).toHaveLength(1);
  });

  it("a rollback after the state was applied leaves the entitlement unchanged and the event retryable", async () => {
    const { id, payload } = eventPayload("customer.subscription.updated", subscriptionObject({ id: bound, status: "active" }), T0 + 240);
    const sig = fake.signPayload(payload);
    const before = await subRow(companyA);
    __setBillingFaultsForTests({
      "webhook.beforeCommit": () => {
        throw new Error("simulated commit failure");
      },
    });
    expect(await processStripeWebhook(Buffer.from(payload), sig, fake)).toMatchObject({ httpStatus: 500, outcome: "failed" });
    expect(await eventRow(id)).toMatchObject({ status: "failed", failureCode: "Error", attempts: 1 });
    const mid = await subRow(companyA);
    expect(mid.status).toBe(before.status);
    expect(mid.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await auditRows(companyA, "subscription.provider_sync")).filter((a) => JSON.stringify(a.metadata).includes(id))).toHaveLength(0);
    __setBillingFaultsForTests({});
    expect((await processStripeWebhook(Buffer.from(payload), sig, fake)).outcome).toBe("applied");
    expect(await eventRow(id)).toMatchObject({ status: "processed", attempts: 2 });
    expect((await subRow(companyA)).status).toBe("active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§8 entitlement services fail closed", () => {
  it("a company without a canonical subscription → SUBSCRIPTION_MISSING from capacity, reservation and usage paths", async () => {
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyC));
    await expectAppError(
      db.transaction((tx) => assertCapacity(tx, companyC, "contacts", 1)),
      "SUBSCRIPTION_MISSING",
      409,
    );
    await expectAppError(reserveScans(companyC, `scan:${companyC}:0:b20c1-${SUFFIX}`, 1), "SUBSCRIPTION_MISSING", 409);
    expect((await db.select().from(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.companyId, companyC))).length).toBe(0);
    // Tenant creation paths never see "unlimited": a direct contact insert through the API is refused
    // (company C has no users; the platform owner is firewalled from tenant CRM routes) — proven at the service level above.
  });

  it("a subscription referencing an unknown plan → SUBSCRIPTION_PLAN_INVALID (never unlimited); usage reporting reports it", async () => {
    const real = await subRow(companyA);
    const phantom = { ...real, plan: `zz_missing_${SUFFIX}` };
    await expectAppError(effectiveLimitsFor(phantom), "SUBSCRIPTION_PLAN_INVALID", 409);
    await expectAppError(usageReport(companyA, phantom), "SUBSCRIPTION_PLAN_INVALID", 409);
    // The FK now forbids persisting such a row at all (proven in the constraint suite below).
    const limits = await effectiveLimitsFor(real);
    expect(limits.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§9 workflow execution re-reads the canonical entitlement before every action", () => {
  let definitionId = 0;
  let leadRow: typeof leadsTable.$inferSelect;
  const NOTIF_TITLE = `B20C1 notify ${SUFFIX}`;
  const TASK_TITLE = `B20C1 task ${SUFFIX}`;

  async function counts() {
    const n = await db.select().from(notificationsTable).where(and(eq(notificationsTable.companyId, companyA), eq(notificationsTable.title, NOTIF_TITLE)));
    const t = await db.select().from(tasksTable).where(and(eq(tasksTable.companyId, companyA), eq(tasksTable.title, TASK_TITLE)));
    return { notifications: n.length, tasks: t.length };
  }
  async function newRun() {
    const out = await dispatchWorkflowEvents([leadCreatedEvent(leadRow, adminAId)], { queue: fakeQueue() });
    expect(out.runIds).toHaveLength(1);
    return out.runIds[0];
  }

  beforeAll(async () => {
    // A is manual + active for this section: the provider cancels, then the platform owner takes over.
    const live = (await subRow(companyA)).stripeSubscriptionId!;
    expect((await deliver("customer.subscription.deleted", subscriptionObject({ id: live, status: "canceled", canceled_at: T0 + 400, ended_at: T0 + 400 }), T0 + 400)).outcome).toBe("applied");
    const conv = await platformOp(companyA, "convert-to-manual");
    expect(conv.status, conv.text).toBe(200);
    const act = await platformOp(companyA, "activate");
    expect(act.status, act.text).toBe(200);
    expect((await current(tokenA)).accessMode).toBe("full");
    const def = await api("POST", "/workflows", tokenA, {
      name: `B20C1 wf ${SUFFIX}`,
      trigger: { type: "lead.created" },
      actions: [
        { type: "notification.create", config: { title: NOTIF_TITLE, recipient: { kind: "actor" } } },
        { type: "task.create", config: { title: TASK_TITLE, assignee: { kind: "actor" } } },
      ],
    });
    expect(def.status, def.text).toBe(201);
    definitionId = def.body.id;
    const pub = await api("POST", `/workflows/${definitionId}/publish`, tokenA, { revision: def.body.revision });
    expect(pub.status, pub.text).toBe(200);
    const lead = await api("POST", "/leads", tokenA, { title: `B20C1 lead ${SUFFIX}`, value: 10 });
    expect(lead.status, lead.text).toBe(201);
    [leadRow] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.body.id));
    // The API process runs its own run for that lead (full access) — wait for it so counts are stable.
    const deadline = Date.now() + 10000;
    for (;;) {
      const runs = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.workflowDefinitionId, definitionId));
      if (runs.length >= 1 && runs.every((r) => r.status === "completed" || r.status === "failed")) break;
      if (Date.now() > deadline) throw new Error("API-side workflow run did not finish");
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  it("full → cancelled / past_due / suspended: the delivered run performs NO action, fails deterministically, keeps history, is never replayed", async () => {
    // Baseline: the API process already executed the run for the lead above (full access).
    const base = await counts();
    for (const [op, body] of [
      ["cancel", undefined],
      ["past-due", undefined],
      ["suspend", { reason: "b20c1 review" }],
    ] as const) {
      const ok = await platformOp(companyA, op, body);
      expect(ok.status, `${op}: ${ok.text}`).toBe(200);
      expect(["read_only", "blocked"]).toContain(ok.body.accessMode);
      const runId = await newRun();
      expect(await executeRun(runId, { attempts: 1, maxAttempts: 5 })).toBe("failed");
      const [run] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, runId));
      expect(run.status).toBe("failed");
      expect(run.error).toMatchObject({ code: "SUBSCRIPTION_NOT_WRITABLE", retryable: false });
      const actions = await db.select().from(workflowActionRunsTable).where(eq(workflowActionRunsTable.runId, runId)).orderBy(workflowActionRunsTable.actionIndex);
      expect(actions.map((a) => a.status)).toEqual(["failed", "pending"]);
      expect(actions[0].error).toMatchObject({ code: "SUBSCRIPTION_NOT_WRITABLE", accessMode: ok.body.accessMode });
      expect(actions[0].attempts).toBe(0);
      expect(await counts()).toEqual(base); // no notification, no task, no email
      // No auto replay: a second delivery of the same failed run is a no-op.
      expect(await executeRun(runId, { attempts: 2, maxAttempts: 5 })).toBe("noop");
      expect(await counts()).toEqual(base);
      // back to full for the next status
      const back = await platformOp(companyA, op === "suspend" ? "reactivate" : "activate");
      expect(back.status, back.text).toBe(200);
      if (op === "suspend") {
        // reactivate resumes the pre-suspension status (past_due → read-only) → activate explicitly
        if (back.body.accessMode !== "full") expect((await platformOp(companyA, "activate")).status).toBe(200);
      }
      expect((await current(tokenA)).accessMode).toBe("full");
    }
    // After reactivation a NEW event runs end-to-end (the failed runs stay failed).
    const runId = await newRun();
    expect(await executeRun(runId, { attempts: 1, maxAttempts: 5 })).toBe("completed");
    const after = await counts();
    expect(after).toEqual({ notifications: base.notifications + 1, tasks: base.tasks + 1 });
    const failedRuns = await db.select().from(workflowRunsTable).where(and(eq(workflowRunsTable.companyId, companyA), eq(workflowRunsTable.status, "failed")));
    expect(failedRuns.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§7 final DB constraints reject invalid direct writes", () => {
  let label = "";
  async function rejects(statement: ReturnType<typeof sql>, expectedCode: string) {
    let code: string | null = null;
    try {
      await db.execute(statement);
    } catch (e: any) {
      code = e?.code ?? e?.cause?.code ?? null;
    }
    expect(code, `${label}: expected SQLSTATE ${expectedCode}`).toBe(expectedCode);
  }
  const CHECK = "23514";
  const FK = "23503";
  const UNIQUE = "23505";

  it("subscriptions: plan FK, status / billing_source / status_before_suspension checks", async () => {
    label = "subscriptions";
    await rejects(sql`update subscriptions set status = 'trial' where company_id = ${companyB}`, CHECK);
    await rejects(sql`update subscriptions set billing_source = 'paypal' where company_id = ${companyB}`, CHECK);
    await rejects(sql`update subscriptions set status_before_suspension = 'suspended' where company_id = ${companyB}`, CHECK);
    await rejects(sql`update subscriptions set plan = 'no_such_plan' where company_id = ${companyB}`, FK);
  });

  it("plan_prices: provider, interval, interval_count, amount, currency shape, provider mode", async () => {
    label = "plan_prices";
    const base = (extra: string) => sql.raw(`insert into plan_prices (plan_id, provider, provider_price_id, provider_product_id, interval, interval_count, currency, unit_amount_minor, provider_mode, verified_at) values ${extra.replace(/\)$/, ", now())")}`);
    await rejects(base(`('professional', 'paddle', 'price_c1_x1', 'prod', 'month', 1, 'usd', 100, 'test')`), CHECK);
    await rejects(base(`('professional', 'stripe', 'price_c1_x2', 'prod', 'fortnight', 1, 'usd', 100, 'test')`), CHECK);
    await rejects(base(`('professional', 'stripe', 'price_c1_x3', 'prod', 'month', 0, 'usd', 100, 'test')`), CHECK);
    await rejects(base(`('professional', 'stripe', 'price_c1_x4', 'prod', 'month', 1, 'usd', -1, 'test')`), CHECK);
    await rejects(base(`('professional', 'stripe', 'price_c1_x5', 'prod', 'month', 1, 'USD', 100, 'test')`), CHECK);
    await rejects(base(`('professional', 'stripe', 'price_c1_x6', 'prod', 'month', 1, 'usd', 100, 'sandbox')`), CHECK);
    await rejects(base(`('no_such_plan', 'stripe', 'price_c1_x7', 'prod', 'month', 1, 'usd', 100, 'test')`), FK);
  });

  it("billing_checkout_sessions: provider, state, mode, plan FK, ONE current intent per company", async () => {
    label = "billing_checkout_sessions";
    const sub = await subRow(companyB);
    const ins = (vals: string) => sql.raw(`insert into billing_checkout_sessions (company_id, subscription_id, plan_price_id, plan_id, provider, provider_mode, idempotency_key, status) values ${vals}`);
    await rejects(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'professional', 'paddle', 'test', 'c1-k1-${SUFFIX}', 'creating')`), CHECK);
    await rejects(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'professional', 'stripe', 'test', 'c1-k2-${SUFFIX}', 'created')`), CHECK);
    await rejects(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'professional', 'stripe', 'sandbox', 'c1-k3-${SUFFIX}', 'creating')`), CHECK);
    await rejects(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'no_such_plan', 'stripe', 'test', 'c1-k4-${SUFFIX}', 'creating')`), FK);
    await db.execute(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'professional', 'stripe', 'test', 'c1-k5-${SUFFIX}', 'creating')`));
    await rejects(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'professional', 'stripe', 'test', 'c1-k6-${SUFFIX}', 'open')`), UNIQUE);
    // A terminal row does not count against the current-intent uniqueness.
    await db.execute(ins(`(${companyB}, ${sub.id}, ${priceM.id}, 'professional', 'stripe', 'test', 'c1-k7-${SUFFIX}', 'expired')`));
    await db.delete(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.companyId, companyB));
  });

  it("billing_provider_events: provider, mode, status, outcome, attempts ≥ 1", async () => {
    label = "billing_provider_events";
    const ins = (vals: string) => sql.raw(`insert into billing_provider_events (provider, provider_mode, event_id, event_type, status, outcome, attempts) values ${vals}`);
    await rejects(ins(`('paddle', 'test', 'evt_b20c1_${SUFFIX}_c1', 'x', 'received', null, 1)`), CHECK);
    await rejects(ins(`('stripe', 'sandbox', 'evt_b20c1_${SUFFIX}_c2', 'x', 'received', null, 1)`), CHECK);
    await rejects(ins(`('stripe', 'test', 'evt_b20c1_${SUFFIX}_c3', 'x', 'queued', null, 1)`), CHECK);
    await rejects(ins(`('stripe', 'test', 'evt_b20c1_${SUFFIX}_c4', 'x', 'processed', 'weird', 1)`), CHECK);
    await rejects(ins(`('stripe', 'test', 'evt_b20c1_${SUFFIX}_c5', 'x', 'received', null, 0)`), CHECK);
  });

  it("subscription_usage_reservations: resource, state, quantity > 0", async () => {
    label = "subscription_usage_reservations";
    const ins = (vals: string) => sql.raw(`insert into subscription_usage_reservations (company_id, resource, quantity, idempotency_key, status, expires_at) values ${vals}`);
    await rejects(ins(`(${companyB}, 'emails', 1, 'c1-r1-${SUFFIX}', 'pending', now())`), CHECK);
    await rejects(ins(`(${companyB}, 'scans', 1, 'c1-r2-${SUFFIX}', 'reserved', now())`), CHECK);
    await rejects(ins(`(${companyB}, 'scans', 0, 'c1-r3-${SUFFIX}', 'pending', now())`), CHECK);
    expect((await db.select().from(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.companyId, companyB))).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("test-only fault hooks", () => {
  it("are reset after every test and never affect an unrelated delivery", async () => {
    // The afterEach above cleared the hooks; a plain delivery goes through untouched.
    const before = await subRow(companyB);
    const r = await deliver("invoice.paid", { id: `in_c1_${SUFFIX}`, object: "invoice", livemode: false, customer: `cus_fake_${companyB}` }, T0 + 300);
    expect(r.outcome).toBe("unbound");
    expect((await subRow(companyB)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});
