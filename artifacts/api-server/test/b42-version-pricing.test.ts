import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, auditLogsTable, plansTable, planVersionsTable, planPricesTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 42 (PB-4.2) — version-specific pricing against the LIVE API with the
// deterministic FAKE provider: a verified provider mapping bound to a DRAFT
// version (strict identity, immutable once published), plan-wide mappings kept
// for compatibility, manual price summaries (D2) in the draft / snapshot,
// publication price validation (duplicate periods, shadowed manual prices),
// preservation of an older version's prices after a new version is published
// and deactivation-not-deletion.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b42price-${SUFFIX}.test`;
const PLAN = `b42p-${SUFFIX}`;
const PRICE_PLAN_WIDE = "price_fake_eur_1900_month";
const PRICE_V1 = "price_fake_eur_2900_month";
const PRICE_V2 = "price_fake_eur_3900_month";
const PRICE_LIVE = "price_fake_live_eur_8900_month";

let platformToken = "";
let tenantToken = "";
let companyId = 0;
let v1 = 0;
let v2 = 0;
let freeV1 = 0;
let planWide: Record<string, any> = {};
let boundV1: Record<string, any> = {};
let boundV2: Record<string, any> = {};
const priceIds: number[] = [];

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
const validate = async (id: number) => (await api("POST", `/platform/plans/${PLAN}/versions/${id}/validate`, platformToken)).body;
const priceList = async () => ((await api("GET", "/platform/billing/prices", platformToken)).body.prices as any[]);

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const status = await api("GET", "/platform/billing/status", platformToken);
  expect(status.body, "the API must run with BILLING_PROVIDER=fake for this suite").toMatchObject({ provider: "fake", available: true });
  const report = await runVersionBackfill({ apply: true });
  expect(report.verdict).toBe("APPLIED");
  freeV1 = (await api("GET", "/platform/plans/free", platformToken)).body.currentVersion.id;
  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `Priced ${SUFFIX}`, limits: {}, features: {} });
  expect(created.status, created.text).toBe(201);
  v1 = created.body.draft.id;
  const company = await api("POST", "/companies", platformToken, { name: `QA B42 Pricing ${SUFFIX}`, plan: "free" });
  expect(company.status, company.text).toBe(201);
  companyId = company.body.id;
  const user = await api("POST", "/users", platformToken, { email: `admin@${DOMAIN}`, name: "admin", role: "primary_admin", companyId, password: PW });
  expect(user.status, user.text).toBe(201);
  tenantToken = await login(`admin@${DOMAIN}`);
});

afterAll(async () => {
  if (companyId) {
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  if (priceIds.length) {
    await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), inArray(auditLogsTable.entityId, priceIds.map(String))));
    await db.delete(planPricesTable).where(inArray(planPricesTable.id, priceIds));
  }
  await db.delete(planPricesTable).where(eq(planPricesTable.planId, PLAN));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, PLAN));
  await db.delete(plansTable).where(eq(plansTable.id, PLAN));
});

describe("registration: plan-wide vs version-bound (strict identity)", () => {
  it("binds a verified provider price to a DRAFT version only; plan-wide stays available; every refusal is explicit", async () => {
    const wide = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: PRICE_PLAN_WIDE });
    expect(wide.status, wide.text).toBe(201);
    planWide = wide.body;
    priceIds.push(planWide.id);
    expect(planWide).toMatchObject({ planId: PLAN, scope: "plan", planVersionId: null, planVersion: null, planVersionState: null, interval: "month", currency: "eur", unitAmountMinor: 1900, active: true, verified: true, modeMatches: true, providerMode: "test" });
    expect(planWide).not.toHaveProperty("providerPriceId");

    const bound = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: PRICE_V1, planVersionId: v1 });
    expect(bound.status, bound.text).toBe(201);
    boundV1 = bound.body;
    priceIds.push(boundV1.id);
    expect(boundV1).toMatchObject({ planId: PLAN, scope: "version", planVersionId: v1, planVersion: 1, planVersionState: "draft", unitAmountMinor: 2900, verified: true, modeMatches: true });

    // Refusals: malformed id, a version of ANOTHER plan, a PUBLISHED version (fixed plan v1), live-mode price.
    expect((await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: "price_fake_eur_4900_month", planVersionId: 0 })).status).toBe(400);
    const foreign = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: "price_fake_eur_4900_month", planVersionId: freeV1 });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("VERSION_NOT_FOUND");
    const published = await api("POST", "/platform/billing/prices", platformToken, { planId: "free", providerPriceId: "price_fake_eur_4900_month", planVersionId: freeV1 });
    expect(published.status).toBe(409);
    expect(published.body.code).toBe("VERSION_NOT_DRAFT");
    expect(published.body.context ?? published.body.details).toMatchObject({ versionId: freeV1, state: "published" });
    const live = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: PRICE_LIVE, planVersionId: v1 });
    expect(live.status).toBe(400);
    expect(live.body.code).toBe("PRICE_MODE_MISMATCH");
    // Nothing was registered by the refusals.
    const mine = (await priceList()).filter((p) => p.planId === PLAN);
    expect(mine.map((p) => p.id).sort()).toEqual([planWide.id, boundV1.id].sort());
    // The audit row of the bound mapping records the scope but never the provider id.
    const audit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_price"), eq(auditLogsTable.entityId, String(boundV1.id))));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ planId: PLAN, planVersionId: v1, planVersion: 1, scope: "version" });
    expect(JSON.stringify(audit[0].metadata)).not.toContain(PRICE_V1);
    // Tenants never reach the pricing administration.
    expect((await api("GET", "/platform/billing/prices", tenantToken)).status).toBe(403);
    expect((await api("POST", "/platform/billing/prices", tenantToken, { planId: PLAN, providerPriceId: "price_fake_eur_4900_month" })).status).toBe(403);
  });

  it("the draft shows both mappings; two active offers on one period block publication until one is deactivated (never deleted)", async () => {
    const v = await version(v1);
    expect(v.priceMappings.map((m: any) => [m.id, m.scope, m.verified, m.modeMatches])).toEqual(expect.arrayContaining([[planWide.id, "plan", true, true], [boundV1.id, "version", true, true]]));
    const blocked = await validate(v1);
    expect(blocked.publishable).toBe(false);
    const dup = blocked.errors.find((e: any) => e.code === "PRICE_DUPLICATE_PERIOD");
    expect(dup, JSON.stringify(blocked.errors)).toBeTruthy();
    expect(dup.message).toContain("eur/monthx1");
    const off = await api("PATCH", `/platform/billing/prices/${planWide.id}`, platformToken, { active: false });
    expect(off.status, off.text).toBe(200);
    expect(off.body).toMatchObject({ id: planWide.id, active: false, scope: "plan" });
    const ok = await validate(v1);
    expect(ok.publishable, JSON.stringify(ok.errors)).toBe(true);
    expect(ok.warnings.map((w: any) => w.code)).not.toContain("NO_PROVIDER_PRICE");
    // The deactivated mapping still exists (identity preserved) and is reported inactive.
    expect((await priceList()).find((p) => p.id === planWide.id)).toMatchObject({ active: false, verified: true });
  });

  it("manual price summaries (D2) live in the draft, are validated, reported when shadowed and never billed by the product", async () => {
    // Contract-level rejection (unknown interval) never reaches the service.
    expect((await api("PATCH", `/platform/plans/${PLAN}/versions/${v1}`, platformToken, { manualPrices: [{ interval: "quarter", currency: "eur", unitAmountMinor: 1 }] })).status).toBe(400);
    // Service-level rejection: a currency that is not three letters, and a repeated period.
    const bad = await api("PATCH", `/platform/plans/${PLAN}/versions/${v1}`, platformToken, { manualPrices: [{ interval: "month", currency: "eur", unitAmountMinor: 1900 }, { interval: "month", currency: "EU1", unitAmountMinor: 1 }] });
    expect(bad.status, bad.text).toBe(400);
    expect(bad.body.code).toBe("VERSION_INPUT_INVALID");
    expect(bad.text).toContain("MANUAL_PRICE_INVALID");
    const dup = await api("PATCH", `/platform/plans/${PLAN}/versions/${v1}`, platformToken, { manualPrices: [{ interval: "month", currency: "eur", unitAmountMinor: 1900 }, { interval: "month", intervalCount: 1, currency: "EUR", unitAmountMinor: 2900 }] });
    expect(dup.status, dup.text).toBe(400);
    expect(dup.text).toContain("MANUAL_PRICE_DUPLICATE");
    expect((await version(v1)).manualPrices).toEqual([]);
    const saved = await api("PATCH", `/platform/plans/${PLAN}/versions/${v1}`, platformToken, { manualPrices: [{ interval: "month", currency: "EUR", unitAmountMinor: 1900, label: " Monthly " }, { interval: "year", currency: "eur", unitAmountMinor: 19900 }] });
    expect(saved.status, saved.text).toBe(200);
    const normalized = [
      { interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, label: "Monthly" },
      { interval: "year", intervalCount: 1, currency: "eur", unitAmountMinor: 19900, label: null },
    ];
    // The PATCH answer is the version view: the summaries live in its snapshot; the
    // detail read surfaces the same list top-level as well.
    expect(saved.body.snapshot.manualPrices).toEqual(normalized);
    expect((await version(v1)).manualPrices).toEqual(normalized);
    expect((await version(v1)).snapshot.manualPrices).toEqual(normalized);
    const v = await validate(v1);
    expect(v.publishable).toBe(true);
    const shadow = v.warnings.find((w: any) => w.code === "MANUAL_PRICE_SHADOWED");
    expect(shadow?.field).toBe("manualPrices.0"); // eur/monthx1 has the active bound provider price
    // The tenant catalog offers provider prices only; manual summaries never reach the checkout surface.
    const plans = (await api("GET", "/subscriptions/plans", tenantToken)).body as any[];
    expect(plans.find((p) => p.id === PLAN)).toBeUndefined(); // the plan is still a draft: not offered at all
  });

  it("a draft carrying a bound price cannot be deleted (VERSION_HAS_PRICES)", async () => {
    const res = await api("DELETE", `/platform/plans/${PLAN}/versions/${v1}`, platformToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_HAS_PRICES");
    expect(res.body.context ?? res.body.details).toMatchObject({ count: 1, priceIds: [boundV1.id] });
    expect((await version(v1)).id).toBe(v1);
  });
});

describe("publication freezes the version's pricing", () => {
  it("publishes v1 with its mappings and manual prices captured; afterwards the pricing is immutable (bind / edit refused, deactivate allowed)", async () => {
    const published = await api("POST", `/platform/plans/${PLAN}/versions/${v1}/publish`, platformToken);
    expect(published.status, published.text).toBe(200);
    const v = await version(v1);
    expect(v.publishedAt).toBeTruthy();
    expect(v.snapshot.manualPrices).toHaveLength(2);
    expect(v.snapshot.prices.map((p: any) => p.id)).toContain(boundV1.id);
    expect(v.snapshot.prices.map((p: any) => p.id)).not.toContain(planWide.id); // inactive at publication
    expect(v.priceMappings.find((m: any) => m.id === boundV1.id)).toMatchObject({ scope: "version", planVersionId: v1, active: true });

    const bindAgain = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: "price_fake_eur_4900_month", planVersionId: v1 });
    expect(bindAgain.status).toBe(409);
    expect(bindAgain.body.code).toBe("VERSION_NOT_DRAFT");
    expect(bindAgain.body.context ?? bindAgain.body.details).toMatchObject({ versionId: v1, state: "published" });
    const edit = await api("PATCH", `/platform/plans/${PLAN}/versions/${v1}`, platformToken, { manualPrices: [] });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("VERSION_IMMUTABLE");
    expect((await version(v1)).snapshot.manualPrices).toHaveLength(2);

    const off = await api("PATCH", `/platform/billing/prices/${boundV1.id}`, platformToken, { active: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ active: false, planVersionId: v1, planVersionState: "published" });
    const on = await api("PATCH", `/platform/billing/prices/${boundV1.id}`, platformToken, { active: true });
    expect(on.body.active).toBe(true);
    // The published snapshot did not change through the deactivation round trip.
    expect((await version(v1)).snapshot.prices.map((p: any) => p.id)).toContain(boundV1.id);
    // The plan is now published: the tenant catalog offers exactly the active bound price of the current version.
    const plans = (await api("GET", "/subscriptions/plans", tenantToken)).body as any[];
    const mine = plans.find((p) => p.id === PLAN);
    expect(mine.prices.map((p: any) => p.id)).toEqual([boundV1.id]);
  });

  it("a new draft starts from the published version (manual prices copied, provider mappings NOT re-bound); publishing v2 preserves v1's price identity", async () => {
    const draft = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v1 });
    expect(draft.status, draft.text).toBe(201);
    v2 = draft.body.id;
    const d = await version(v2);
    expect(d.manualPrices).toHaveLength(2);
    expect(d.priceMappings.map((m: any) => m.id)).toEqual([planWide.id]); // plan-wide (inactive) applies; the v1-bound mapping does not
    const bound = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: PRICE_V2, planVersionId: v2 });
    expect(bound.status, bound.text).toBe(201);
    boundV2 = bound.body;
    priceIds.push(boundV2.id);
    expect(boundV2).toMatchObject({ scope: "version", planVersionId: v2, planVersion: 2, planVersionState: "draft", unitAmountMinor: 3900 });
    const val = await validate(v2);
    expect(val.publishable, JSON.stringify(val.errors)).toBe(true);
    const published = await api("POST", `/platform/plans/${PLAN}/versions/${v2}/publish`, platformToken);
    expect(published.status, published.text).toBe(200);
    // Older version keeps its own price identity; the catalog now offers only the current version's price.
    const list = await priceList();
    expect(list.find((p) => p.id === boundV1.id)).toMatchObject({ planVersionId: v1, planVersion: 1, planVersionState: "published", active: true });
    expect(list.find((p) => p.id === boundV2.id)).toMatchObject({ planVersionId: v2, planVersion: 2, planVersionState: "published", active: true });
    expect((await version(v1)).priceMappings.map((m: any) => m.id)).toContain(boundV1.id);
    const plans = (await api("GET", "/subscriptions/plans", tenantToken)).body as any[];
    expect(plans.find((p) => p.id === PLAN).prices.map((p: any) => p.id)).toEqual([boundV2.id]);
    // Provider mapping identity is unique: the same provider price cannot be registered twice (any scope).
    const dup = await api("POST", "/platform/billing/prices", platformToken, { planId: PLAN, providerPriceId: PRICE_V2 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("PRICE_ALREADY_REGISTERED");
  });
});
