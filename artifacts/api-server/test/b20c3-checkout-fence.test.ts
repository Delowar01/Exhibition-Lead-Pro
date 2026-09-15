import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { eq, and, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, subscriptionsTable, auditLogsTable, planPricesTable, billingCheckoutSessionsTable } from "@workspace/db";
import { FakeBillingProvider } from "../src/lib/billing/fake-provider.js";
import { __setBillingProviderForTests } from "../src/lib/billing/provider.js";
import { __setBillingFaultsForTests } from "../src/lib/billing/test-faults.js";
import { createCheckout } from "../src/services/subscriptions.service.js";
import { loadAuthUserById } from "../src/middlewares/requireAuth.js";
import { AppError } from "../src/middlewares/errorHandler.js";

// =============================================================================
// Batch 20 — Correction 3: cold-start Checkout requests are FENCED against a
// concurrent price switch. Real PostgreSQL + the fake provider, in-process, with
// awaited barriers (no sleeps). Proves:
//   A. cold start (no customer, no intent, no remote session): request A pauses
//      after the provider customer was created but before its binding is
//      persisted; request B switches to a different price and completes; A then
//      cannot create a provider session for its retired intent, answers a safe
//      conflict, and the peak number of open remote sessions is one.
//   B. cold-start same-price concurrency: one provider customer under the stable
//      key, one remote session, one current intent, safe reuse / conflicts.
//   C. opposite ordering: A's customer binding commits before B switches; B closes
//      A's (id-less) session through the authoritative recovery protocol and the
//      delayed A can neither open another session nor resurrect the retired intent.
//   Every test also asserts that no provider call ran inside a database transaction.
// =============================================================================

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b20c3-${SUFFIX}.test`;
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_M = "price_fake_usd_5100_month"; // professional
const PRICE_Y = "price_fake_usd_140000_year"; // business

let platformToken = "";
let adminId = 0;
let priceM: Record<string, any> = {};
let priceY: Record<string, any> = {};
const companyIds: number[] = [];
let fake: FakeBillingProvider;

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
const nonTerminal = (rows: Array<{ status: string }>) => rows.filter((r) => r.status === "creating" || r.status === "open");
async function auditCount(companyId: number, action: string) {
  return (await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyId), eq(auditLogsTable.entityType, "subscription"), eq(auditLogsTable.action, action)))).length;
}
async function checkoutAs(planPriceId: number) {
  const user = await loadAuthUserById(adminId);
  if (!user) throw new Error("admin missing");
  return createCheckout(user, { planPriceId }, { userId: adminId, userName: `admin@${DOMAIN}`, ipAddress: null });
}
function codeOf(r: PromiseSettledResult<unknown>): string | null {
  return r.status === "rejected" ? ((r.reason as AppError).code ?? `!${(r.reason as Error).message}`) : null;
}
// A FRESH cold-start tenant for every scenario: no provider customer, no intent, no
// remote session. Torn down in afterAll (company delete cascades the intents).
async function coldStartCompany(label: string): Promise<{ companyId: number; customerId: string }> {
  const res = await api("POST", "/companies", platformToken, { name: `QA B20C3 ${label} ${SUFFIX}`, plan: "free" });
  expect(res.status, res.text).toBe(201);
  const companyId = res.body.id as number;
  companyIds.push(companyId);
  const u = await api("POST", "/users", platformToken, { email: `${label}-admin@${DOMAIN}`, name: label, role: "primary_admin", companyId, password: PW });
  expect(u.status, u.text).toBe(201);
  adminId = u.body.id;
  expect((await subRow(companyId)).stripeCustomerId).toBeNull();
  expect(await checkoutRows(companyId)).toHaveLength(0);
  fake.__resetCounters();
  return { companyId, customerId: `cus_fake_${companyId}` };
}
// One-shot gate: the FIRST arrival at the hook parks until released; later arrivals pass.
function firstArrivalGate() {
  let released: () => void = () => undefined;
  let arrived: () => void = () => undefined;
  const release = new Promise<void>((r) => (released = r));
  const reached = new Promise<void>((r) => (arrived = r));
  let first = true;
  const hook = async () => {
    if (!first) return;
    first = false;
    arrived();
    await release;
  };
  return { hook, reached, release: () => released() };
}

beforeAll(async () => {
  expect(SECRET, "STRIPE_WEBHOOK_SECRET must be set (fake provider)").not.toBe("");
  fake = new FakeBillingProvider(SECRET);
  __setBillingProviderForTests(fake);
  (db as any).transaction = (fn: any, cfg?: any) => txContext.run(true, () => originalTransaction(fn, cfg));
  fake.__setCallObserverForTests((method) => {
    if (txContext.getStore()) providerCallsInsideTx.push(method);
  });
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  expect((await api("GET", "/platform/billing/status", platformToken)).body).toMatchObject({ provider: "fake", available: true, selfServiceCheckoutEnabled: true, stripeMode: "test" });
  await db.delete(planPricesTable).where(inArray(planPricesTable.providerPriceId, [PRICE_M, PRICE_Y]));
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
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds)); // cascades subscriptions + intents
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(planPricesTable).where(inArray(planPricesTable.providerPriceId, [PRICE_M, PRICE_Y]));
  await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), like(auditLogsTable.action, "billing.price_mapping.%")));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A. cold start + concurrent different-price switch", () => {
  it("a request paused between provider customer creation and its binding cannot open a session for its retired intent", async () => {
    const { companyId, customerId } = await coldStartCompany("a");
    const gate = firstArrivalGate();
    __setBillingFaultsForTests({ "checkout.afterCustomerCreate": gate.hook });

    // Request A: inserts the cold intent, creates the provider customer, parks before the binding.
    const a = checkoutAs(priceM.id);
    a.catch(() => undefined);
    await gate.reached;
    const [intentA] = await checkoutRows(companyId);
    expect(intentA).toMatchObject({ status: "creating", planPriceId: priceM.id, providerCustomerId: null, providerSessionId: null });
    expect((await subRow(companyId)).stripeCustomerId).toBeNull();
    expect(fake.remoteOpenSessionCount(customerId)).toBe(0);

    // Request B (not blocked by the one-shot gate): switches to the yearly price and completes.
    const b = await checkoutAs(priceY.id);
    expect(b.status).toBe("created");
    const afterB = await checkoutRows(companyId);
    const replacement = afterB.find((r) => r.status === "open")!;
    expect(replacement).toMatchObject({ planPriceId: priceY.id, providerCustomerId: customerId });
    expect(afterB.find((r) => r.id === intentA.id)).toMatchObject({ status: "expired", providerCustomerId: null, providerSessionId: null });
    expect(fake.remoteOpenSessionCount(customerId)).toBe(1);

    // Release A: it must NOT create a provider session for the retired intent.
    gate.release();
    const settled = await Promise.allSettled([a]);
    expect(codeOf(settled[0])).toBe("CHECKOUT_IN_PROGRESS");

    // Invariants.
    expect(fake.remoteMaxOpenSessionCount(customerId), "peak open remote sessions").toBe(1);
    expect(fake.remoteOpenSessionCount(customerId)).toBe(1);
    expect(fake.remoteSessions().filter((s) => s.customerId === customerId)).toHaveLength(1); // no orphan session at all
    expect(fake.calls.createCheckoutSession).toBe(1);
    expect(fake.remoteCustomerCount(customerId)).toBe(1);
    const rows = await checkoutRows(companyId);
    expect(nonTerminal(rows)).toHaveLength(1);
    expect(nonTerminal(rows)[0]).toMatchObject({ id: replacement.id, planPriceId: priceY.id, providerSessionId: replacement.providerSessionId, status: "open" });
    expect(fake.remoteSession(replacement.providerSessionId!)).toMatchObject({ status: "open", customerId });
    expect(rows.find((r) => r.id === intentA.id)).toMatchObject({ status: "expired", providerCustomerId: null, providerSessionId: null }); // not resurrected, not written
    expect((await subRow(companyId)).stripeCustomerId).toBe(customerId);
    expect(await auditCount(companyId, "subscription.provider_customer_linked")).toBe(1);
    expect(await auditCount(companyId, "subscription.checkout_started")).toBe(2);
    expect(await auditCount(companyId, "subscription.checkout_expired")).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("checkout.fake.local");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("B. cold start + same-price concurrency", () => {
  it("concurrent first checkouts share one provider customer, one remote session and one current intent", async () => {
    const { companyId, customerId } = await coldStartCompany("b");
    const CALLERS = 5;
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    // Barrier: every caller that created a provider customer parks until all did, then they race the binding.
    __setBillingFaultsForTests({
      "checkout.afterCustomerCreate": async () => {
        arrived += 1;
        if (arrived === CALLERS) release();
        await gate;
      },
    });
    const results = await Promise.allSettled(Array.from({ length: CALLERS }, () => checkoutAs(priceM.id)));
    expect(arrived).toBe(CALLERS);
    const urls = new Set<string>();
    for (const r of results) {
      if (r.status === "fulfilled") urls.add(r.value.url);
      else expect(["CHECKOUT_IN_PROGRESS"], String(r.reason)).toContain(codeOf(r));
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(urls.size).toBe(1);
    expect(fake.remoteCustomerCount(customerId)).toBe(1);
    expect(fake.calls.createCustomer).toBe(CALLERS); // every caller asked, the stable key collapsed them
    expect(fake.remoteSessions().filter((s) => s.customerId === customerId)).toHaveLength(1);
    expect(fake.remoteOpenSessionCount(customerId)).toBe(1);
    expect(fake.remoteMaxOpenSessionCount(customerId)).toBe(1);
    const rows = await checkoutRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", providerCustomerId: customerId, planPriceId: priceM.id });
    expect((await subRow(companyId)).stripeCustomerId).toBe(customerId);
    expect(await auditCount(companyId, "subscription.provider_customer_linked")).toBe(1);
    expect(await auditCount(companyId, "subscription.checkout_started")).toBe(1);
    // Idempotent same-customer attachment: a later same-price request reuses the session.
    expect((await checkoutAs(priceM.id)).status).toBe("reused");
    expect(fake.remoteOpenSessionCount(customerId)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C. opposite fence ordering", () => {
  it("binding committed first, session creation delayed: the switch recovers and expires A's session; delayed A cannot open another one", async () => {
    const { companyId, customerId } = await coldStartCompany("c");
    const gate = firstArrivalGate();
    __setBillingFaultsForTests({ "checkout.beforeSessionCreate": gate.hook });

    const a = checkoutAs(priceM.id);
    a.catch(() => undefined);
    await gate.reached;
    const [intentA] = await checkoutRows(companyId);
    expect(intentA).toMatchObject({ status: "creating", planPriceId: priceM.id, providerCustomerId: customerId, providerSessionId: null }); // binding committed
    expect((await subRow(companyId)).stripeCustomerId).toBe(customerId);
    expect(fake.calls.createCheckoutSession).toBe(0);

    // B switches: the bound, id-less intent must go through the authoritative recovery protocol.
    const b = await checkoutAs(priceY.id);
    expect(b.status).toBe("created");
    const afterB = await checkoutRows(companyId);
    const retired = afterB.find((r) => r.id === intentA.id)!;
    expect(retired.status).toBe("expired");
    expect(retired.providerSessionId).not.toBeNull(); // recovered through A's key …
    expect(fake.remoteSession(retired.providerSessionId!)!.status).toBe("expired"); // … and closed at the provider before the replacement
    expect(fake.calls.expireCheckoutSession).toBe(1);
    const replacement = afterB.find((r) => r.status === "open")!;
    expect(replacement).toMatchObject({ planPriceId: priceY.id });
    expect(fake.remoteOpenSessionCount(customerId)).toBe(1);

    // Delayed A: its creation replays the same key — it must neither open another session nor resurrect the intent.
    gate.release();
    const settled = await Promise.allSettled([a]);
    expect(codeOf(settled[0])).toBe("CHECKOUT_IN_PROGRESS");
    expect(fake.remoteMaxOpenSessionCount(customerId), "peak open remote sessions").toBe(1);
    expect(fake.remoteSessions().filter((s) => s.customerId === customerId)).toHaveLength(2); // A's (expired) + B's (open) — nothing else
    const rows = await checkoutRows(companyId);
    expect(nonTerminal(rows)).toHaveLength(1);
    expect(nonTerminal(rows)[0]).toMatchObject({ id: replacement.id, status: "open", planPriceId: priceY.id });
    expect(rows.find((r) => r.id === intentA.id)).toMatchObject({ status: "expired", providerSessionId: retired.providerSessionId });
    expect(await auditCount(companyId, "subscription.provider_customer_linked")).toBe(1);
    expect(await auditCount(companyId, "subscription.checkout_expired")).toBe(1);
  });
});
