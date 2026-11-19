import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, auditLogsTable, subscriptionsTable, plansTable, planVersionsTable, planPricesTable } from "@workspace/db";

// Launch pricing & dashboard polish — the two server-side facts the web screens rely on.
//
// 1. Money. The API keeps every price in the currency's MINOR unit and never converts it:
//    what is written is what is read back, whatever the currency's number of decimals
//    (US dollars and Saudi riyals have two, yen none, Kuwaiti dinars three; Icelandic
//    krónur are whole units kept in hundredths). Reading an amount for people is the web
//    app's single currency policy (artifacts/web-app/src/lib/money.ts); nothing here divides
//    or multiplies by 100. The fake provider is used — no real price, session or payment.
// 2. The platform's company list is newest first, with the id breaking ties, so "Recent
//    Companies" shows the latest tenants and paging never repeats or skips a row.
//
// Exercised against the LIVE API (localhost:80). Independent SQL written here is the oracle.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `lp-${SUFFIX}.test`;
const PLAN = `lp-${SUFFIX}`;
const ORDER_TAG = `LP Order ${SUFFIX}`;
const MAX_PRICE_MINOR = 1_000_000_000;

let platformToken = "";
let tenantToken = "";
let tenantCompanyId = 0;
let draftId = 0;

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
const version = async (id: number) => (await api("GET", `/platform/plans/${PLAN}/versions/${id}`, platformToken)).body;
const patchPrices = (manualPrices: unknown) => api("PATCH", `/platform/plans/${PLAN}/versions/${draftId}`, platformToken, { manualPrices });

async function purge() {
  const companies = await db.select({ id: companiesTable.id }).from(companiesTable).where(like(companiesTable.name, "LP Order %"));
  const ids = [...companies.map((c) => c.id), ...(tenantCompanyId ? [tenantCompanyId] : [])];
  await db.delete(usersTable).where(like(usersTable.email, "%@lp-%.test"));
  if (ids.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, ids));
    await db.delete(usersTable).where(inArray(usersTable.companyId, ids));
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.companyId, ids));
    await db.delete(companiesTable).where(inArray(companiesTable.id, ids));
  }
  const prices = await db.select({ id: planPricesTable.id }).from(planPricesTable).where(like(planPricesTable.planId, "lp-%"));
  if (prices.length) await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), inArray(auditLogsTable.entityId, prices.map((p) => String(p.id)))));
  await db.delete(planPricesTable).where(like(planPricesTable.planId, "lp-%"));
  await db.delete(planVersionsTable).where(like(planVersionsTable.planId, "lp-%"));
  await db.delete(plansTable).where(like(plansTable.id, "lp-%"));
}

beforeAll(async () => {
  await purge();
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const status = await api("GET", "/platform/billing/status", platformToken);
  expect(status.body, "the API must run with BILLING_PROVIDER=fake for this suite").toMatchObject({ provider: "fake", available: true });

  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `LP Pricing ${SUFFIX}`, limits: {}, features: {} });
  expect(created.status, created.text).toBe(201);
  draftId = created.body.draft.id;

  const company = await api("POST", "/companies", platformToken, { name: `QA LP Pricing ${SUFFIX}`, plan: "free" });
  expect(company.status, company.text).toBe(201);
  tenantCompanyId = company.body.id;
  const user = await api("POST", "/users", platformToken, { email: `admin@${DOMAIN}`, name: "admin", role: "primary_admin", companyId: tenantCompanyId, password: PW });
  expect(user.status, user.text).toBe(201);
  tenantToken = await login(`admin@${DOMAIN}`);
});

afterAll(async () => {
  await purge();
});

describe("manual prices are kept in minor units, exactly as written", () => {
  // What the plan editor sends for each typed amount (see the web policy's tests).
  const PRICES = [
    { interval: "month", intervalCount: 1, currency: "usd", unitAmountMinor: 4900, label: "49.00 US dollars" },
    { interval: "year", intervalCount: 1, currency: "sar", unitAmountMinor: 125050, label: "1,250.50 riyals" },
    { interval: "month", intervalCount: 1, currency: "jpy", unitAmountMinor: 5000, label: "5,000 yen" },
    { interval: "month", intervalCount: 1, currency: "isk", unitAmountMinor: 50000, label: "500 kronur" },
    { interval: "month", intervalCount: 1, currency: "huf", unitAmountMinor: 490000, label: "4,900 forints" },
    { interval: "month", intervalCount: 1, currency: "kwd", unitAmountMinor: 10500, label: "10.500 dinars" },
  ];

  it("a draft returns every amount it was given — two-, zero- and three-decimal currencies alike", async () => {
    const saved = await patchPrices(PRICES);
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.snapshot.manualPrices).toEqual(PRICES);
    const read = await version(draftId);
    expect(read.manualPrices).toEqual(PRICES);
    expect(read.snapshot.manualPrices).toEqual(PRICES);

    // The stored row holds the same integers (no scaling on the way in or out).
    const [row] = await db.select({ snapshot: planVersionsTable.snapshot }).from(planVersionsTable).where(eq(planVersionsTable.id, draftId));
    const stored = (row.snapshot as { manualPrices: Array<{ currency: string; unitAmountMinor: number }> }).manualPrices;
    expect(stored.map((p) => [p.currency, p.unitAmountMinor])).toEqual(PRICES.map((p) => [p.currency, p.unitAmountMinor]));
  });

  it("saving what was read, again and again, changes nothing", async () => {
    for (let round = 0; round < 3; round++) {
      const read = await version(draftId);
      const again = await patchPrices(read.manualPrices);
      expect(again.status, again.text).toBe(200);
      expect(again.body.snapshot.manualPrices).toEqual(PRICES);
    }
    // Changing something else leaves the prices alone.
    const renamed = await api("PATCH", `/platform/plans/${PLAN}/versions/${draftId}`, platformToken, { description: "Launch pricing check" });
    expect(renamed.status, renamed.text).toBe(200);
    expect((await version(draftId)).manualPrices).toEqual(PRICES);
  });

  it("accepts the whole range of amounts and refuses what cannot be a minor-unit integer", async () => {
    const one = (unitAmountMinor: unknown, currency = "usd") => patchPrices([{ interval: "month", intervalCount: 1, currency, unitAmountMinor }]);
    for (const ok of [0, 1, 99, 100, 101, MAX_PRICE_MINOR - 1, MAX_PRICE_MINOR]) {
      const res = await one(ok);
      expect(res.status, `${ok}: ${res.text}`).toBe(200);
      expect(res.body.snapshot.manualPrices[0].unitAmountMinor).toBe(ok);
    }
    for (const bad of [MAX_PRICE_MINOR + 1, -1, 49.5, 0.1 + 0.2, "4900", null, Number.MAX_SAFE_INTEGER]) {
      const res = await one(bad);
      expect(res.status, `${String(bad)}: ${res.text}`).toBe(400);
    }
    // A refused save leaves the last accepted amount in place.
    expect((await version(draftId)).manualPrices).toEqual([{ interval: "month", intervalCount: 1, currency: "usd", unitAmountMinor: MAX_PRICE_MINOR, label: null }]);

    // The currency is a three-letter code and is normalised to lower case; the API never
    // interprets the amount, so a code it does not know is stored as given, unconverted.
    // (The editor is what refuses a currency the billing provider does not support.)
    expect((await one(100, "USD")).body.snapshot.manualPrices[0]).toMatchObject({ currency: "usd", unitAmountMinor: 100 });
    expect((await one(5000, "xyz")).body.snapshot.manualPrices[0]).toMatchObject({ currency: "xyz", unitAmountMinor: 5000 });
    for (const bad of ["us", "usdd", "u$d", "", 840]) expect((await one(100, bad as string)).status, String(bad)).toBe(400);

    const restored = await patchPrices(PRICES);
    expect(restored.status, restored.text).toBe(200);
  });

  it("publishing captures the same amounts for good", async () => {
    const published = await api("POST", `/platform/plans/${PLAN}/versions/${draftId}/publish`, platformToken);
    expect(published.status, published.text).toBe(200);
    const read = await version(draftId);
    expect(read.state).toBe("published");
    expect(read.snapshot.manualPrices).toEqual(PRICES);
    // Published pricing is immutable.
    expect((await patchPrices([])).status).not.toBe(200);
    expect((await version(draftId)).snapshot.manualPrices).toEqual(PRICES);
    // A new draft starts from the same amounts.
    const draft = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: draftId });
    expect(draft.status, draft.text).toBe(201);
    expect((await version(draft.body.id)).manualPrices).toEqual(PRICES);
  });
});

describe("provider prices are stored exactly as the provider reports them", () => {
  // The fake provider reports the amount written in the id, as Stripe reports `unit_amount`.
  const REPORTED: Array<[string, string, number]> = [
    ["price_fake_usd_4917_month", "usd", 4917],
    ["price_fake_sar_37517_year", "sar", 37517],
    ["price_fake_jpy_5017_week", "jpy", 5017],
    ["price_fake_kwd_10517_day", "kwd", 10517],
  ];

  it("registration keeps the reported minor amount for every kind of currency", async () => {
    for (const [providerPriceId, currency, minor] of REPORTED) {
      const res = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId });
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({ planId: PLAN, currency, unitAmountMinor: minor, verified: true });
      const [row] = await db.select({ minor: planPricesTable.unitAmountMinor, currency: planPricesTable.currency }).from(planPricesTable).where(eq(planPricesTable.id, res.body.id));
      expect(row).toEqual({ minor, currency });
    }
    const listed = ((await api("GET", "/platform/billing/prices", platformToken)).body.prices as Array<{ planId: string; currency: string; unitAmountMinor: number }>).filter((p) => p.planId === PLAN);
    expect(listed.map((p) => [p.currency, p.unitAmountMinor]).sort()).toEqual(REPORTED.map(([, c, m]) => [c, m]).sort());
  });

  it("the pricing endpoints are the platform owner's", async () => {
    for (const [method, path, body] of [
      ["GET", "/platform/billing/prices", undefined],
      ["POST", "/platform/billing/prices", { planId: PLAN, providerPriceId: "price_fake_usd_100_month" }],
      ["GET", `/platform/plans/${PLAN}/versions/${draftId}`, undefined],
      ["PATCH", `/platform/plans/${PLAN}/versions/${draftId}`, { manualPrices: [] }],
    ] as const) {
      expect((await api(method, path, tenantToken, body)).status, `${method} ${path} as a tenant admin`).toBe(403);
      expect((await api(method, path, null, body)).status, `${method} ${path} anonymously`).toBe(401);
    }
    // Nothing was written by the refused calls.
    const rows = await db.select({ id: planPricesTable.id }).from(planPricesTable).where(eq(planPricesTable.planId, PLAN));
    expect(rows).toHaveLength(REPORTED.length);
  });
});

describe("the platform's company list is newest first", () => {
  const T0 = Date.parse("2026-03-01T10:00:00.000Z");
  const at = (minutes: number) => new Date(T0 + minutes * 60_000);
  const ids: number[] = [];
  // Seven companies; three of them were created in the very same instant.
  const CREATED = [0, 5, 5, 5, 9, 2, 7];

  beforeAll(async () => {
    for (const [i, minutes] of CREATED.entries()) {
      const [c] = await db
        .insert(companiesTable)
        .values({ name: `${ORDER_TAG} #${i}`, status: "active", plan: "free", createdAt: at(minutes) })
        .returning({ id: companiesTable.id });
      ids.push(c.id);
    }
  });

  const expected = () =>
    CREATED.map((minutes, i) => ({ id: ids[i], minutes }))
      .sort((a, b) => b.minutes - a.minutes || b.id - a.id)
      .map((c) => c.id);
  const list = async (query: string) => (await api("GET", `/companies?search=${encodeURIComponent(ORDER_TAG)}${query}`, platformToken)).body;

  it("orders by creation time, newest first, with the higher id first among equals", async () => {
    const res = await list("&limit=100");
    expect(res.total).toBe(CREATED.length);
    expect((res.companies as Array<{ id: number }>).map((c) => c.id)).toEqual(expected());
    // The three created together come out in one fixed order: highest id first.
    const tied = (res.companies as Array<{ id: number; createdAt: string }>).filter((c) => Date.parse(c.createdAt) === at(5).getTime()).map((c) => c.id);
    expect(tied).toEqual([ids[3], ids[2], ids[1]]);
  });

  it("pages through every company once — none repeated, none skipped", async () => {
    for (const limit of [1, 2, 3]) {
      const seen: number[] = [];
      for (let page = 1; page <= Math.ceil(CREATED.length / limit); page++) {
        const res = await list(`&limit=${limit}&page=${page}`);
        expect(res.total).toBe(CREATED.length);
        seen.push(...(res.companies as Array<{ id: number }>).map((c) => c.id));
      }
      expect(seen, `limit ${limit}`).toEqual(expected());
    }
  });

  it("the dashboard's request (limit 5) returns the five newest companies of the platform", async () => {
    const oracle = await db.select({ id: companiesTable.id }).from(companiesTable).orderBy(desc(companiesTable.createdAt), desc(companiesTable.id)).limit(5);
    const res = (await api("GET", "/companies?limit=5", platformToken)).body;
    expect((res.companies as Array<{ id: number }>).map((c) => c.id)).toEqual(oracle.map((c) => c.id));
    // The default page is ordered the same way.
    const all = await db.select({ id: companiesTable.id }).from(companiesTable).orderBy(desc(companiesTable.createdAt), desc(companiesTable.id)).limit(20);
    const defaults = (await api("GET", "/companies", platformToken)).body;
    expect((defaults.companies as Array<{ id: number }>).map((c) => c.id)).toEqual(all.map((c) => c.id));
  });

  it("a company onboarded now leads the list", async () => {
    const created = await api("POST", "/companies", platformToken, { name: `${ORDER_TAG} newest`, plan: "free" });
    expect(created.status, created.text).toBe(201);
    const res = (await api("GET", "/companies?limit=5", platformToken)).body;
    expect(res.companies[0].id).toBe(created.body.id);
  });

  it("the filters keep the same order", async () => {
    // Every company of this group, filtered by the plan of its subscription.
    await db.insert(subscriptionsTable).values([ids[1], ids[4], ids[6]].map((companyId) => ({ companyId, plan: "free", status: "active" })));
    const res = await list("&plan=free&status=active&limit=100");
    const want = expected().filter((id) => [ids[1], ids[4], ids[6]].includes(id));
    expect((res.companies as Array<{ id: number }>).map((c) => c.id).filter((id) => ids.includes(id))).toEqual(want);
  });

  it("the list stays the platform owner's", async () => {
    expect((await api("GET", "/companies?limit=5", tenantToken)).status).toBe(403);
    expect((await api("GET", "/companies?limit=5", null)).status).toBe(401);
  });
});
