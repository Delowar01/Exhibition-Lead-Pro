import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { eq, and, inArray, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  subscriptionsTable,
  auditLogsTable,
  planPricesTable,
  billingCheckoutSessionsTable,
  billingProviderEventsTable,
} from "@workspace/db";
import { FakeBillingProvider } from "../src/lib/billing/fake-provider.js";
import { __setBillingProviderForTests } from "../src/lib/billing/provider.js";
import { __setBillingFaultsForTests } from "../src/lib/billing/test-faults.js";
import { processStripeWebhook } from "../src/services/billing-webhook.service.js";
import { createCheckout } from "../src/services/subscriptions.service.js";
import { syncFromProvider } from "../src/services/subscription-lifecycle.service.js";
import * as repo from "../src/repositories/subscriptions.repository.js";
import { loadAuthUserById } from "../src/middlewares/requireAuth.js";
import { AppError } from "../src/middlewares/errorHandler.js";

// =============================================================================
// Batch 20 — Correction 2: close the Checkout crash/switch gap and require LOCAL
// binding proof. Real PostgreSQL + the deterministic fake provider, in-process
// (fault hooks, barriers, provider registry inspection). Proves:
//   §1 a crash after the remote session was created but before its id was saved,
//      followed by a different-price request, recovers the remote session through
//      the SAME idempotency key, expires it at the provider and only then creates
//      the replacement — never two open remote sessions; recovery/expiry failures
//      leave the old intent current with no replacement and no second session;
//      same-price retry resolves to the original session; a crash after the
//      provider expiration recovers; concurrent same/different-price requests
//      never exceed one open remote session; the idempotent create reply is never
//      trusted over a fresh retrieval.
//   §2 ownership needs a real local Checkout record: metadata companyId +
//      subscriptionId alone never binds; missing / nonexistent / expired / failed /
//      cross-company / wrong-customer / wrong-mode / wrong-price checkout ids never
//      prove ownership; a completed Checkout bound to subscription A never
//      authorizes B; both legitimate event orders still bind exactly once.
//   §3 a retrieved subscription with the wrong livemode cannot mutate entitlement
//      through webhooks, Checkout reconciliation, invoice handling or manual sync.
//   §4 no provider call ever runs inside a database transaction.
// =============================================================================

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b20c2-${SUFFIX}.test`;
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_M = "price_fake_usd_4100_month"; // professional
const PRICE_Y = "price_fake_usd_130000_year"; // business
const T0 = Math.floor(Date.now() / 1000) - 600;

let platformToken = "";
let companyA = 0;
let companyB = 0;
let adminAId = 0;
let adminBId = 0;
let subIdA = 0;
let subIdB = 0;
let priceM: Record<string, any> = {};
let priceY: Record<string, any> = {};
const companyIds: number[] = [];
const eventIds: string[] = [];
let fake: FakeBillingProvider;
let eventSeq = 0;
const CUS_A = () => `cus_fake_${companyA}`;

// ── "no provider call inside a transaction" tracker ─────────────────────────
const txContext = new AsyncLocalStorage<boolean>();
const providerCallsInsideTx: string[] = [];
const originalTransaction = db.transaction.bind(db);

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
async function subRow(companyId: number) {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId));
  return row;
}
async function checkoutRows(companyId: number) {
  return db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.companyId, companyId)).orderBy(billingCheckoutSessionsTable.id);
}
const currentIntent = async (companyId: number) => (await checkoutRows(companyId)).find((r) => r.status === "creating" || r.status === "open");
async function eventRow(eventId: string) {
  const [row] = await db.select().from(billingProviderEventsTable).where(eq(billingProviderEventsTable.eventId, eventId));
  return row;
}
async function auditRows(companyId: number, action?: string) {
  const rows = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyId), eq(auditLogsTable.entityType, "subscription"))).orderBy(auditLogsTable.id);
  return action ? rows.filter((r) => r.action === action) : rows;
}
const actorA = () => ({ userId: adminAId, userName: `admin-a@${DOMAIN}`, ipAddress: null });
async function checkoutAs(planPriceId: number, userId = adminAId) {
  const user = await loadAuthUserById(userId);
  if (!user) throw new Error("user missing");
  return createCheckout(user, { planPriceId }, actorA());
}
async function expectAppError(p: Promise<unknown>, code: string, status?: number) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${code}, got ${err instanceof Error ? `${(err as any).code ?? ""} ${err.message}` : String(err)}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status) expect((err as AppError).statusCode).toBe(status);
  return err as AppError;
}
function subscriptionObject(o: Record<string, unknown>) {
  return {
    id: `sub_fake_c2_${SUFFIX}`,
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
function sessionObject(o: Record<string, unknown>) {
  return { object: "checkout.session", livemode: false, status: "complete", customer: CUS_A(), ...o };
}
function eventPayload(type: string, object: Record<string, unknown>, created: number, id?: string) {
  const eventId = id ?? `evt_b20c2_${SUFFIX}_${++eventSeq}`;
  if (!eventIds.includes(eventId)) eventIds.push(eventId);
  return { id: eventId, payload: JSON.stringify({ id: eventId, object: "event", type, created, livemode: false, data: { object } }) };
}
async function deliver(type: string, object: Record<string, unknown>, created: number) {
  const { id, payload } = eventPayload(type, object, created);
  const res = await processStripeWebhook(Buffer.from(payload), fake.signPayload(payload), fake);
  return { ...res, id };
}
// Retires the company's current intent at the provider AND locally (test setup only).
async function clearIntent(companyId: number) {
  const cur = await currentIntent(companyId);
  if (!cur) return;
  if (cur.providerSessionId && fake.remoteSession(cur.providerSessionId)?.status === "open") await fake.expireCheckoutSession(cur.providerSessionId);
  await db.update(billingCheckoutSessionsTable).set({ status: "expired" }).where(eq(billingCheckoutSessionsTable.id, cur.id));
}

beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set (fake provider)").not.toBe("");
  fake = new FakeBillingProvider(SECRET);
  __setBillingProviderForTests(fake);
  // Every provider call made while a transaction is open in this process is a violation.
  (db as any).transaction = (fn: any, cfg?: any) => txContext.run(true, () => originalTransaction(fn, cfg));
  fake.__setCallObserverForTests((method) => {
    if (txContext.getStore()) providerCallsInsideTx.push(method);
  });
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const status = await api("GET", "/platform/billing/status", platformToken);
  expect(status.body).toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true, stripeMode: "test" });
  await db.delete(planPricesTable).where(inArray(planPricesTable.providerPriceId, [PRICE_M, PRICE_Y]));
  for (const [name, setter] of [
    [`QA B20C2 A ${SUFFIX}`, (id: number) => (companyA = id)],
    [`QA B20C2 B ${SUFFIX}`, (id: number) => (companyB = id)],
  ] as const) {
    const res = await api("POST", "/companies", platformToken, { name, plan: "free" });
    expect(res.status, res.text).toBe(201);
    setter(res.body.id);
    companyIds.push(res.body.id);
  }
  for (const [email, companyId, setter] of [
    [`admin-a@${DOMAIN}`, companyA, (id: number) => (adminAId = id)],
    [`admin-b@${DOMAIN}`, companyB, (id: number) => (adminBId = id)],
  ] as const) {
    const u = await api("POST", "/users", platformToken, { email, name: email, role: "primary_admin", companyId, password: PW });
    expect(u.status, u.text).toBe(201);
    setter(u.body.id);
  }
  subIdA = (await subRow(companyA)).id;
  subIdB = (await subRow(companyB)).id;
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
  __setBillingFaultsForTests({});
  fake.__failNextCall(null);
  expect(providerCallsInsideTx, "provider calls inside a database transaction").toEqual([]);
});

afterAll(async () => {
  __setBillingFaultsForTests({});
  __setBillingProviderForTests(null);
  (db as any).transaction = originalTransaction;
  if (companyIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(billingProviderEventsTable).where(like(billingProviderEventsTable.eventId, `evt_b20c2_${SUFFIX}%`));
  await db.delete(planPricesTable).where(inArray(planPricesTable.providerPriceId, [PRICE_M, PRICE_Y]));
  await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), like(auditLogsTable.action, "billing.price_mapping.%")));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§1 crash after remote session creation, then a different-price request", () => {
  it("recovers the original remote session through the same key, expires it at the provider, then creates the replacement — never two open remote sessions", async () => {
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash before the provider session id was saved");
      },
    });
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated crash");
    const crashed = (await currentIntent(companyA))!;
    expect(crashed).toMatchObject({ status: "creating", providerSessionId: null, planPriceId: priceM.id });
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1); // the remote session exists, the local row does not know it
    const orphan = fake.remoteSessions().find((s) => s.customerId === CUS_A() && s.status === "open")!;
    __setBillingFaultsForTests({});
    fake.__resetCounters();

    // The tenant now asks for a DIFFERENT price.
    const out = await checkoutAs(priceY.id);
    expect(out.status).toBe("created");

    // Invariant: at most one open remote session at any externally visible boundary.
    expect(fake.remoteMaxOpenSessionCount(CUS_A()), "peak number of simultaneously open remote sessions").toBe(1);
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    expect(fake.remoteSession(orphan.id)!.status).toBe("expired");
    expect(fake.calls.expireCheckoutSession).toBe(1);
    const rows = await checkoutRows(companyA);
    const old = rows.find((r) => r.id === crashed.id)!;
    expect(old).toMatchObject({ status: "expired", providerSessionId: orphan.id }); // the recovered id was persisted before closure
    const fresh = rows.find((r) => r.status === "open")!;
    expect(fresh).toMatchObject({ planPriceId: priceY.id, planId: "business" });
    expect(fresh.providerSessionId).not.toBe(orphan.id);
    expect(rows.filter((r) => r.status === "creating" || r.status === "open")).toHaveLength(1);
    expect((await auditRows(companyA, "subscription.checkout_expired")).length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("checkout.fake.local"); // no hosted URL persisted
  });

  it("a failure while recovering or expiring the original session leaves the old intent current: no replacement intent, no second remote session", async () => {
    await clearIntent(companyA);
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash before the provider session id was saved");
      },
    });
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated crash");
    __setBillingFaultsForTests({});
    const crashed = (await currentIntent(companyA))!;
    const orphan = fake.remoteSessions().find((s) => s.customerId === CUS_A() && s.status === "open")!;
    const rowsBefore = (await checkoutRows(companyA)).length;
    fake.__resetCounters();

    // (a) the recovery replay itself fails at the provider
    fake.__failNextCall("StripeConnectionError", "createCheckoutSession");
    await expectAppError(checkoutAs(priceY.id), "PROVIDER_ERROR", 502);
    expect(await currentIntent(companyA)).toMatchObject({ id: crashed.id, status: "creating", providerSessionId: null });
    expect((await checkoutRows(companyA)).length).toBe(rowsBefore);
    expect(fake.remoteSession(orphan.id)!.status).toBe("open");

    // (b) the replay parameters no longer match the original request (idempotency conflict)
    await db.update(billingCheckoutSessionsTable).set({ planId: "business" }).where(eq(billingCheckoutSessionsTable.id, crashed.id)); // metadata.planId would differ
    await expectAppError(checkoutAs(priceY.id), "PROVIDER_ERROR", 502);
    await db.update(billingCheckoutSessionsTable).set({ planId: "professional" }).where(eq(billingCheckoutSessionsTable.id, crashed.id));
    expect(await currentIntent(companyA)).toMatchObject({ id: crashed.id, status: "creating", providerSessionId: null });
    expect((await checkoutRows(companyA)).length).toBe(rowsBefore);

    // (c) recovery succeeds, the provider refuses to expire
    fake.__failNextCall("StripeAPIError", "expireCheckoutSession");
    await expectAppError(checkoutAs(priceY.id), "PROVIDER_ERROR", 502);
    const cur = (await currentIntent(companyA))!;
    expect(cur).toMatchObject({ id: crashed.id, status: "creating", providerSessionId: orphan.id }); // the recovered id is durable, the intent stays current
    expect(fake.remoteSession(orphan.id)!.status).toBe("open");
    expect((await checkoutRows(companyA)).length).toBe(rowsBefore);

    // Invariants across all three failures: one remote session ever, never two open.
    expect(fake.remoteSessions().filter((s) => s.customerId === CUS_A() && s.id !== orphan.id && s.status === "open")).toHaveLength(0);
    expect(fake.remoteMaxOpenSessionCount(CUS_A())).toBe(1);

    // Provider recovered → the switch completes with a single open session.
    const out = await checkoutAs(priceY.id);
    expect(out.status).toBe("created");
    expect(fake.remoteSession(orphan.id)!.status).toBe("expired");
    expect(fake.remoteMaxOpenSessionCount(CUS_A())).toBe(1);
    expect((await checkoutRows(companyA)).filter((r) => r.status === "open")).toHaveLength(1);
  });

  it("a same-price retry after the crash resolves to the ORIGINAL remote session", async () => {
    await clearIntent(companyA);
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash before the provider session id was saved");
      },
    });
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated crash");
    __setBillingFaultsForTests({});
    const crashed = (await currentIntent(companyA))!;
    const original = fake.remoteSessions().find((s) => s.customerId === CUS_A() && s.status === "open")!;
    fake.__resetCounters();
    const out = await checkoutAs(priceM.id);
    expect(out.status).toBe("created");
    expect(out.url).toBe(original.url);
    expect(fake.calls.createCheckoutSession).toBe(1); // the replay (same key) — no new session
    expect(fake.calls.expireCheckoutSession).toBe(0);
    expect(await currentIntent(companyA)).toMatchObject({ id: crashed.id, status: "open", providerSessionId: original.id });
    expect(fake.remoteSessions().filter((s) => s.customerId === CUS_A() && s.status === "open")).toEqual([expect.objectContaining({ id: original.id })]);
    expect(fake.remoteMaxOpenSessionCount(CUS_A())).toBe(1);
  });

  it("a crash after the provider expiration but before the local transition recovers without duplication", async () => {
    // Current: open intent for M (from the previous test). Ask for Y, crash right after the provider confirmed the expiration.
    const open = (await currentIntent(companyA))!;
    expect(open.status).toBe("open");
    __setBillingFaultsForTests({
      "checkout.afterExpire": () => {
        throw new Error("simulated crash after provider expiration");
      },
    });
    await expect(checkoutAs(priceY.id)).rejects.toThrow("simulated crash after provider expiration");
    __setBillingFaultsForTests({});
    expect(fake.remoteSession(open.providerSessionId!)!.status).toBe("expired");
    expect(await currentIntent(companyA)).toMatchObject({ id: open.id, status: "open" }); // local row lags behind the provider
    fake.__resetCounters();
    // Same price next: the stale local row is resolved from the provider (expired) → a fresh intent, no second expire.
    const same = await checkoutAs(priceM.id);
    expect(same.status).toBe("created");
    expect(fake.calls.expireCheckoutSession).toBe(0);
    const rows = await checkoutRows(companyA);
    expect(rows.find((r) => r.id === open.id)!.status).toBe("expired");
    const fresh = (await currentIntent(companyA))!;
    expect(fresh.id).toBeGreaterThan(open.id);
    expect(fresh).toMatchObject({ status: "open", planPriceId: priceM.id });
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    expect(fake.remoteMaxOpenSessionCount(CUS_A())).toBe(1);
    // …and the same crash on a different-price request recovers on the next attempt too.
    __setBillingFaultsForTests({
      "checkout.afterExpire": () => {
        throw new Error("simulated crash after provider expiration");
      },
    });
    await expect(checkoutAs(priceY.id)).rejects.toThrow("simulated crash after provider expiration");
    __setBillingFaultsForTests({});
    const switched = await checkoutAs(priceY.id);
    expect(switched.status).toBe("created");
    expect((await currentIntent(companyA))).toMatchObject({ status: "open", planPriceId: priceY.id });
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    expect(fake.remoteMaxOpenSessionCount(CUS_A())).toBe(1);
  });

  it("concurrent same-price and different-price requests never produce more than one open remote session", async () => {
    // Start from a crashed intent (no session id persisted) so every caller has to recover or replay.
    await clearIntent(companyA);
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash before the provider session id was saved");
      },
    });
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated crash");
    fake.__resetCounters();
    // Barrier: hold every caller at its post-provider point until all four arrived, then race.
    const CALLERS = 4;
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const hold = async () => {
      arrived += 1;
      if (arrived === CALLERS) release();
      await gate;
    };
    __setBillingFaultsForTests({ "checkout.afterSessionCreate": hold, "checkout.afterRecover": hold });
    const results = await Promise.allSettled([checkoutAs(priceM.id), checkoutAs(priceY.id), checkoutAs(priceM.id), checkoutAs(priceY.id)]);
    expect(arrived).toBeGreaterThanOrEqual(CALLERS); // every caller reached a post-provider point at least once
    for (const r of results) {
      if (r.status === "rejected") expect(["CHECKOUT_IN_PROGRESS", "PROVIDER_ERROR", "CHECKOUT_ALREADY_COMPLETED"], String(r.reason)).toContain((r.reason as AppError).code);
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(fake.remoteMaxOpenSessionCount(CUS_A()), "peak open remote sessions during the race").toBe(1);
    expect(fake.remoteOpenSessionCount(CUS_A())).toBeLessThanOrEqual(1);
    const rows = await checkoutRows(companyA);
    expect(rows.filter((r) => r.status === "creating" || r.status === "open").length).toBeLessThanOrEqual(1);
    // Every URL handed out belongs to a session the provider actually holds.
    for (const r of results) if (r.status === "fulfilled") expect(fake.remoteSessions().some((s) => s.url === r.value.url || (s.status !== "open" && r.value.url))).toBe(true);
  });

  it("a cached / idempotent creation reply is never trusted over a fresh remote-session retrieval", async () => {
    await clearIntent(companyA);
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash before the provider session id was saved");
      },
    });
    await expect(checkoutAs(priceM.id)).rejects.toThrow("simulated crash");
    __setBillingFaultsForTests({});
    const crashed = (await currentIntent(companyA))!;
    const original = fake.remoteSessions().find((s) => s.customerId === CUS_A() && s.status === "open")!;
    // The session expires at the provider (time / another actor) while the local row still has no id.
    await fake.expireCheckoutSession(original.id);
    fake.__resetCounters();
    // Same price: the replay answers with the ORIGINAL "open" reply; only the retrieval knows it expired.
    const out = await checkoutAs(priceM.id);
    expect(out.status).toBe("created");
    expect(out.url).not.toBe(original.url);
    expect(fake.calls.retrieveCheckoutSession).toBeGreaterThanOrEqual(1);
    const rows = await checkoutRows(companyA);
    expect(rows.find((r) => r.id === crashed.id)).toMatchObject({ status: "expired", providerSessionId: original.id });
    const fresh = (await currentIntent(companyA))!;
    expect(fresh.id).toBeGreaterThan(crashed.id);
    expect(fresh.providerSessionId).not.toBe(original.id);
    expect(fake.remoteOpenSessionCount(CUS_A())).toBe(1);
    expect(fake.remoteMaxOpenSessionCount(CUS_A())).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§2 ownership requires a real local Checkout record", () => {
  const SUB1 = `sub_fake_c2_${SUFFIX}`;
  const SUB2 = `sub_fake_c2_two_${SUFFIX}`;
  let completedIntentId = 0;

  it("binds through the tenant's own Checkout (session id + validated checkout id), then the provider cancels", async () => {
    const open = (await currentIntent(companyA))!;
    const meta = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(open.id) };
    fake.__seedSubscription(subscriptionObject({ id: SUB1, metadata: meta }), T0 + 10);
    const done = await deliver("checkout.session.completed", sessionObject({ id: open.providerSessionId, subscription: SUB1, client_reference_id: String(open.id), metadata: meta }), T0 + 11);
    expect(done.outcome).toBe("applied");
    expect(await subRow(companyA)).toMatchObject({ billingSource: "stripe", status: "active", plan: "professional", stripeSubscriptionId: SUB1, stripePriceId: PRICE_M });
    expect((await checkoutRows(companyA)).find((r) => r.id === open.id)).toMatchObject({ status: "completed", providerSubscriptionId: SUB1, providerSessionId: open.providerSessionId });
    completedIntentId = open.id;
    expect((await deliver("customer.subscription.deleted", subscriptionObject({ id: SUB1, status: "canceled", canceled_at: T0 + 20, ended_at: T0 + 20, metadata: meta }), T0 + 20)).outcome).toBe("applied");
    expect(await subRow(companyA)).toMatchObject({ status: "cancelled", stripeSubscriptionId: SUB1 });
  });

  it("a cancelled binding cannot be replaced by a same-customer subscription carrying only companyId + subscriptionId", async () => {
    const before = await subRow(companyA);
    const r = await deliver("customer.subscription.created", subscriptionObject({ id: SUB2, metadata: { companyId: String(companyA), subscriptionId: String(subIdA) } }), T0 + 30);
    expect(r.outcome).toBe("unbound");
    expect(await eventRow(r.id)).toMatchObject({ status: "ignored", outcome: "unbound" });
    const after = await subRow(companyA);
    expect(after).toMatchObject({ status: "cancelled", stripeSubscriptionId: SUB1 });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // Neither by e-mail nor by customer id alone.
    expect((await deliver("customer.subscription.created", subscriptionObject({ id: SUB2, metadata: {} }), T0 + 31)).outcome).toBe("unbound");
    expect((await deliver("invoice.paid", { id: `in_c2_${SUFFIX}`, object: "invoice", livemode: false, customer: CUS_A(), customer_email: `admin-a@${DOMAIN}`, subscription: SUB2 }, T0 + 32)).outcome).toBe("unbound");
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB1);
  });

  it("missing, nonexistent, expired, failed, cross-company, wrong-customer, wrong-mode and wrong-price checkout ids never establish ownership", async () => {
    const before = await subRow(companyA);
    const sub = subIdA;
    const meta = (checkoutId: number | string) => ({ companyId: String(companyA), subscriptionId: String(sub), checkoutId: String(checkoutId) });
    const nonBinding = ["unbound", "mismatch"];
    const attempt = async (label: string, o: Record<string, unknown>) => {
      const r = await deliver("customer.subscription.created", subscriptionObject({ id: SUB2, ...o }), T0 + 40 + eventSeq);
      expect(nonBinding, label).toContain(r.outcome);
      const now = await subRow(companyA);
      expect(now.stripeSubscriptionId, label).toBe(SUB1);
      expect(now.updatedAt.getTime(), label).toBe(before.updatedAt.getTime());
    };
    const terminal = async (status: "expired" | "failed") => {
      const [row] = await db
        .insert(billingCheckoutSessionsTable)
        .values({ companyId: companyA, subscriptionId: sub, planPriceId: priceM.id, planId: "professional", provider: "stripe", providerMode: "test", idempotencyKey: `c2-${status}-${SUFFIX}`, providerCustomerId: CUS_A(), status })
        .returning();
      return row.id;
    };
    await attempt("nonexistent checkout id", { metadata: meta(999_999_999) });
    await attempt("expired intent", { metadata: meta(await terminal("expired")) });
    await attempt("failed intent", { metadata: meta(await terminal("failed")) });
    // cross-company: a CURRENT intent of company B referenced from company A's tenant metadata
    const bOut = await checkoutAs(priceM.id, adminBId);
    expect(bOut.status).toBe("created");
    const bIntent = (await currentIntent(companyB))!;
    await attempt("cross-company intent", { metadata: meta(bIntent.id) });
    // wrong customer: a genuine current intent of A (yearly), but the provider subscription belongs to another customer
    expect((await checkoutAs(priceY.id)).status).toBe("created");
    const aIntent = (await currentIntent(companyA))!;
    expect(aIntent).toMatchObject({ status: "open", planPriceId: priceY.id });
    await attempt("wrong customer", { customer: "cus_fake_someone_else", metadata: meta(aIntent.id), items: { data: [{ price: { id: PRICE_Y }, current_period_start: T0, current_period_end: T0 + 400 * 24 * 3600 }] } });
    // wrong price: the intent is for the yearly price, the subscription is billed monthly
    await attempt("wrong price", { metadata: meta(aIntent.id) });
    // wrong mode: the intent was verified in the other Stripe mode
    await db.update(billingCheckoutSessionsTable).set({ providerMode: "live" }).where(eq(billingCheckoutSessionsTable.id, aIntent.id));
    await attempt("wrong mode", { metadata: meta(aIntent.id), items: { data: [{ price: { id: PRICE_Y }, current_period_start: T0, current_period_end: T0 + 400 * 24 * 3600 }] } });
    await db.update(billingCheckoutSessionsTable).set({ providerMode: "test" }).where(eq(billingCheckoutSessionsTable.id, aIntent.id));
    // metadata that disagrees with the referenced intent's tenant
    await attempt("foreign tenant metadata", { metadata: { companyId: String(companyB), subscriptionId: String(subIdB), checkoutId: String(aIntent.id) }, items: { data: [{ price: { id: PRICE_Y }, current_period_start: T0, current_period_end: T0 + 400 * 24 * 3600 }] } });
    // checkout.session.completed whose client_reference_id and metadata checkout id disagree
    const disagree = await deliver("checkout.session.completed", sessionObject({ id: aIntent.providerSessionId, subscription: SUB2, client_reference_id: String(aIntent.id), metadata: meta(completedIntentId) }), T0 + 60 + eventSeq);
    expect(disagree.outcome).toBe("mismatch");
    // id-less completion (path 2) naming ANOTHER company's customer-less intent: no session id may be
    // attached to that foreign intent, nothing binds.
    await clearIntent(companyB); // one non-terminal intent per company
    const [foreign] = await db
      .insert(billingCheckoutSessionsTable)
      .values({ companyId: companyB, subscriptionId: subIdB, planPriceId: priceM.id, planId: "professional", provider: "stripe", providerMode: "test", idempotencyKey: `c2-foreign-${SUFFIX}`, providerCustomerId: null, status: "creating" })
      .returning();
    const hijack = await deliver("checkout.session.completed", sessionObject({ id: `cs_fake_hijack_${SUFFIX}`, subscription: SUB2, client_reference_id: String(foreign.id), metadata: meta(foreign.id) }), T0 + 61 + eventSeq);
    expect(hijack.outcome).toBe("mismatch");
    const [foreignAfter] = await db.select().from(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.id, foreign.id));
    expect(foreignAfter).toMatchObject({ status: "creating", providerSessionId: null });
    await db.delete(billingCheckoutSessionsTable).where(eq(billingCheckoutSessionsTable.id, foreign.id));
    expect((await currentIntent(companyA))).toMatchObject({ id: aIntent.id, status: "open" });
    expect((await subRow(companyA)).stripeSubscriptionId).toBe(SUB1);
    expect((await auditRows(companyA, "subscription.provider_replaced")).length).toBe(0);
  });

  it("a completed Checkout associated with subscription A cannot authorize subscription B", async () => {
    const before = await subRow(companyA);
    const r = await deliver("customer.subscription.created", subscriptionObject({ id: SUB2, metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(completedIntentId) } }), T0 + 70);
    expect(r.outcome).toBe("unbound");
    // …nor through a completed-session replay naming the other subscription.
    const completed = (await checkoutRows(companyA)).find((r) => r.id === completedIntentId)!;
    const replay = await deliver("checkout.session.completed", sessionObject({ id: completed.providerSessionId, subscription: SUB2, client_reference_id: String(completedIntentId), metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(completedIntentId) } }), T0 + 71);
    expect(["unbound", "mismatch"]).toContain(replay.outcome);
    const after = await subRow(companyA);
    expect(after.stripeSubscriptionId).toBe(SUB1);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await checkoutRows(companyA)).find((r) => r.id === completedIntentId)).toMatchObject({ status: "completed", providerSubscriptionId: SUB1 });
  });

  it("legitimate orders still bind exactly once: created → completed, completed → created, and completed for a crashed (id-less) intent", async () => {
    const SUB3 = `sub_fake_c2_three_${SUFFIX}`;
    const SUB4 = `sub_fake_c2_four_${SUFFIX}`;
    const SUB5 = `sub_fake_c2_five_${SUFFIX}`;
    const yearly = { data: [{ price: { id: PRICE_Y }, current_period_start: T0 + 100, current_period_end: T0 + 400 * 24 * 3600 }] };
    // (a) subscription.created first — the current yearly intent is the proof.
    const yIntent = (await currentIntent(companyA))!;
    expect(yIntent).toMatchObject({ status: "open", planPriceId: priceY.id });
    const metaY = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(yIntent.id) };
    const replacedBefore = (await auditRows(companyA, "subscription.provider_replaced")).length;
    expect((await deliver("customer.subscription.created", subscriptionObject({ id: SUB3, metadata: metaY, items: yearly }), T0 + 100)).outcome).toBe("applied");
    expect(await subRow(companyA)).toMatchObject({ status: "active", plan: "business", stripeSubscriptionId: SUB3, stripePriceId: PRICE_Y });
    expect((await auditRows(companyA, "subscription.provider_replaced")).length).toBe(replacedBefore + 1);
    const done = await deliver("checkout.session.completed", sessionObject({ id: yIntent.providerSessionId, subscription: SUB3, client_reference_id: String(yIntent.id), metadata: metaY }), T0 + 101);
    expect(["applied", "no_change"]).toContain(done.outcome);
    expect((await checkoutRows(companyA)).find((r) => r.id === yIntent.id)).toMatchObject({ status: "completed", providerSubscriptionId: SUB3 });
    expect((await deliver("customer.subscription.created", subscriptionObject({ id: SUB3, metadata: metaY, items: yearly }), T0 + 102)).outcome).toBe("no_change");
    expect((await auditRows(companyA, "subscription.provider_replaced")).length).toBe(replacedBefore + 1);

    // (b) completed first — the provider already holds the subscription.
    expect((await deliver("customer.subscription.deleted", subscriptionObject({ id: SUB3, status: "canceled", canceled_at: T0 + 110, ended_at: T0 + 110, metadata: metaY, items: yearly }), T0 + 110)).outcome).toBe("applied");
    expect((await checkoutAs(priceM.id)).status).toBe("created");
    const mIntent = (await currentIntent(companyA))!;
    const metaM = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(mIntent.id) };
    fake.__seedSubscription(subscriptionObject({ id: SUB4, metadata: metaM }), T0 + 120);
    expect((await deliver("checkout.session.completed", sessionObject({ id: mIntent.providerSessionId, subscription: SUB4, client_reference_id: String(mIntent.id), metadata: metaM }), T0 + 121)).outcome).toBe("applied");
    expect(await subRow(companyA)).toMatchObject({ status: "active", plan: "professional", stripeSubscriptionId: SUB4 });
    expect((await deliver("customer.subscription.created", subscriptionObject({ id: SUB4, metadata: metaM }), T0 + 122)).outcome).toBe("no_change");
    expect((await auditRows(companyA, "subscription.provider_replaced")).length).toBe(replacedBefore + 2);

    // (c) completed for an intent whose session id was never saved (crash) — located by the validated
    // checkout id / client_reference_id, session id attached atomically, then completed.
    expect((await deliver("customer.subscription.deleted", subscriptionObject({ id: SUB4, status: "canceled", canceled_at: T0 + 130, ended_at: T0 + 130, metadata: metaM }), T0 + 130)).outcome).toBe("applied");
    let calls = 0;
    __setBillingFaultsForTests({
      "checkout.afterSessionCreate": () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash before the provider session id was saved");
      },
    });
    await expect(checkoutAs(priceY.id)).rejects.toThrow("simulated crash");
    __setBillingFaultsForTests({});
    const crashed = (await currentIntent(companyA))!;
    expect(crashed).toMatchObject({ status: "creating", providerSessionId: null });
    const remote = fake.remoteSessions().find((s) => s.customerId === CUS_A() && s.status === "open")!;
    const metaC = { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(crashed.id) };
    fake.__seedSubscription(subscriptionObject({ id: SUB5, metadata: metaC, items: yearly }), T0 + 140);
    const completed = await deliver("checkout.session.completed", sessionObject({ id: remote.id, subscription: SUB5, client_reference_id: String(crashed.id), metadata: metaC }), T0 + 141);
    expect(completed.outcome).toBe("applied");
    expect((await checkoutRows(companyA)).find((r) => r.id === crashed.id)).toMatchObject({ status: "completed", providerSessionId: remote.id, providerSubscriptionId: SUB5 });
    expect(await subRow(companyA)).toMatchObject({ status: "active", plan: "business", stripeSubscriptionId: SUB5 });
    expect((await auditRows(companyA, "subscription.provider_replaced")).length).toBe(replacedBefore + 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§3 a provider subscription from the other Stripe mode never mutates entitlement", () => {
  it("webhook processing, invoice handling, manual sync and Checkout reconciliation all fail safely with PROVIDER_MODE_MISMATCH", async () => {
    const bound = (await subRow(companyA)).stripeSubscriptionId!;
    const before = await subRow(companyA);
    const yearly = { data: [{ price: { id: PRICE_Y }, current_period_start: T0 + 100, current_period_end: T0 + 400 * 24 * 3600 }] };
    // The provider now answers retrievals with a LIVE-mode object (newer than any event below).
    fake.__seedSubscription(subscriptionObject({ id: bound, livemode: true, status: "past_due", items: yearly }), T0 + 950);
    const eventsBefore = (await auditRows(companyA)).length;
    // (1) signed TEST-mode event whose retrieved subscription is LIVE
    const upd = await deliver("customer.subscription.updated", subscriptionObject({ id: bound, status: "past_due", items: yearly }), T0 + 901);
    expect(upd).toMatchObject({ httpStatus: 500, outcome: "failed" });
    expect(await eventRow(upd.id)).toMatchObject({ status: "failed", failureCode: "PROVIDER_MODE_MISMATCH", companyId: companyA });
    // (2) invoice-triggered retrieval
    const inv = await deliver("invoice.payment_failed", { id: `in_c2_live_${SUFFIX}`, object: "invoice", livemode: false, customer: CUS_A(), subscription: bound }, T0 + 902);
    expect(inv).toMatchObject({ httpStatus: 500, outcome: "failed" });
    expect(await eventRow(inv.id)).toMatchObject({ status: "failed", failureCode: "PROVIDER_MODE_MISMATCH" });
    // (3) manual provider sync (platform operator)
    await expectAppError(syncFromProvider(companyA, { userId: null, userName: "system:test", ipAddress: null }), "PROVIDER_MODE_MISMATCH", 409);
    const mid = await subRow(companyA);
    expect(mid).toMatchObject({ status: "active", stripeSubscriptionId: bound, stripePriceId: before.stripePriceId });
    expect(mid.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await auditRows(companyA)).length).toBe(eventsBefore);
    // Sanitized: no provider object / full id / URL in the failure records.
    for (const id of [upd.id, inv.id]) expect(JSON.stringify(await eventRow(id))).not.toMatch(/livemode|checkout\.fake\.local|whsec_/);

    // (4) Checkout reconciliation: the provider now reports the deleted (test-mode) object so the
    // tenant can re-enter Checkout; the completed session references a LIVE subscription.
    expect((await deliver("customer.subscription.deleted", subscriptionObject({ id: bound, status: "canceled", canceled_at: T0 + 960, ended_at: T0 + 960, items: yearly }), T0 + 960)).outcome).toBe("applied");
    expect((await checkoutAs(priceM.id)).status).toBe("created");
    const intent = (await currentIntent(companyA))!;
    const SUBL = `sub_fake_c2_live_${SUFFIX}`;
    fake.__seedSubscription(subscriptionObject({ id: SUBL, livemode: true, metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(intent.id) } }), T0 + 970);
    fake.recordObject("checkout.session", sessionObject({ id: intent.providerSessionId, subscription: SUBL, client_reference_id: String(intent.id) }), T0 + 971);
    const cancelledRow = await subRow(companyA);
    await expectAppError(checkoutAs(priceY.id), "PROVIDER_MODE_MISMATCH", 502);
    expect((await currentIntent(companyA))).toMatchObject({ id: intent.id, status: "open" }); // not completed, not replaced
    expect((await checkoutRows(companyA)).filter((r) => r.id > intent.id)).toHaveLength(0);
    const after = await subRow(companyA);
    expect(after).toMatchObject({ status: "cancelled", stripeSubscriptionId: bound });
    expect(after.updatedAt.getTime()).toBe(cancelledRow.updatedAt.getTime());
    // (5) the same completed session through the webhook: non-2xx, retryable, nothing changes.
    const done = await deliver("checkout.session.completed", sessionObject({ id: intent.providerSessionId, subscription: SUBL, client_reference_id: String(intent.id), metadata: { companyId: String(companyA), subscriptionId: String(subIdA), checkoutId: String(intent.id) } }), T0 + 972);
    expect(done).toMatchObject({ httpStatus: 500, outcome: "failed" });
    expect(await eventRow(done.id)).toMatchObject({ status: "failed", failureCode: "PROVIDER_MODE_MISMATCH" });
    expect((await currentIntent(companyA))).toMatchObject({ id: intent.id, status: "open" });
    expect((await subRow(companyA)).updatedAt.getTime()).toBe(cancelledRow.updatedAt.getTime());
  });
});
