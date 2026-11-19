import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, count, eq, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import { db, companiesTable, usersTable, scansTable, subscriptionsTable } from "@workspace/db";

// G-7 — the Platform Dashboard uses the same definitions as Platform Owner Analytics.
//
// Exercised against the LIVE API (localhost:80). The dashboard totals are all-time figures,
// so each rule is proven as a DELTA: read the totals, add synthetic rows of a known kind,
// read again. Independent SQL written here is the oracle for the absolute figures.
//   • Total Users  — company users that exist today (no deleted account, no platform owner).
//   • Total Captures / Total Scans — every capture vs. the captures read by OCR.
//   • the per-company "Users" figure of the dashboard's company table follows the same rule.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SUFFIX = Date.now();
const COMPANY = `G7 Dash ${SUFFIX}`;

let platformToken = "";
let companyId = 0;

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}
async function get(path: string, token = platformToken) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status, path).toBe(200);
  return res.json();
}
const stats = () => get("/platform/stats");
const user = (tag: string, extra: Partial<typeof usersTable.$inferInsert> = {}) => ({
  email: `${tag}-${SUFFIX}@g7-dash.test`,
  passwordHash: "synthetic-not-a-hash",
  name: `G7 Dash ${tag}`,
  role: "employee",
  companyId,
  ...extra,
});

async function purge() {
  const companies = await db.select({ id: companiesTable.id }).from(companiesTable).where(like(companiesTable.name, "G7 Dash %"));
  const ids = companies.map((c) => c.id);
  await db.delete(usersTable).where(like(usersTable.email, "%@g7-dash.test"));
  if (ids.length === 0) return;
  await db.delete(scansTable).where(inArray(scansTable.companyId, ids));
  await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.companyId, ids));
  await db.delete(companiesTable).where(inArray(companiesTable.id, ids));
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`).catch((err) => {
    throw new Error(`API not reachable at ${BASE} (${String(err)})`);
  });
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  await purge();
  platformToken = await loginToken(PLATFORM);
  const [c] = await db.insert(companiesTable).values({ name: COMPANY, status: "active", plan: "starter" }).returning({ id: companiesTable.id });
  companyId = c.id;
});

afterAll(purge);

describe("Total Users", () => {
  it("is the number of company users that exist today", async () => {
    const liveTenantUser = and(isNull(usersTable.deletedAt), sql`${usersTable.role} is distinct from 'platform_owner'`);
    const [[{ live }], [{ all }], [{ owners }], [{ deleted }]] = await Promise.all([
      db.select({ live: count() }).from(usersTable).where(liveTenantUser),
      db.select({ all: count() }).from(usersTable),
      db.select({ owners: count() }).from(usersTable).where(eq(usersTable.role, "platform_owner")),
      db.select({ deleted: count() }).from(usersTable).where(sql`${usersTable.deletedAt} is not null and ${usersTable.role} is distinct from 'platform_owner'`),
    ]);
    const s = await stats();
    expect(s.totalUsers).toBe(Number(live));
    // The platform owner account exists as a row and is not a user of any company.
    expect(Number(owners)).toBeGreaterThanOrEqual(1);
    expect(s.totalUsers).toBe(Number(all) - Number(owners) - Number(deleted));
    expect(s.totalUsers).toBeLessThan(Number(all));
  });

  it("grows with a new company user, and not with a deleted account", async () => {
    const before = await stats();
    await db.insert(usersTable).values(user("live"));
    expect((await stats()).totalUsers).toBe(before.totalUsers + 1);

    await db.insert(usersTable).values(user("gone", { isActive: false, deletedAt: new Date() }));
    expect((await stats()).totalUsers).toBe(before.totalUsers + 1);
  });

  it("drops when an account is deleted and returns when it is restored", async () => {
    const [u] = await db.insert(usersTable).values(user("toggle")).returning({ id: usersTable.id });
    const withUser = (await stats()).totalUsers;
    await db.update(usersTable).set({ deletedAt: new Date(), isActive: false }).where(eq(usersTable.id, u.id));
    expect((await stats()).totalUsers).toBe(withUser - 1);
    await db.update(usersTable).set({ deletedAt: null, isActive: true }).where(eq(usersTable.id, u.id));
    expect((await stats()).totalUsers).toBe(withUser);
  });

  it("does not count an account once it is a platform owner", async () => {
    const [u] = await db.insert(usersTable).values(user("operator", { isActive: false })).returning({ id: usersTable.id });
    const asUser = (await stats()).totalUsers;
    // The role alone is flipped on an inactive synthetic row; it never signs in.
    await db.update(usersTable).set({ role: "platform_owner", companyId: null }).where(eq(usersTable.id, u.id));
    try {
      expect((await stats()).totalUsers).toBe(asUser - 1);
    } finally {
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  });

  it("is the figure Platform Owner Analytics reports, and what the company rows add up to", async () => {
    const [s, overview] = await Promise.all([stats(), get("/platform/analytics/overview")]);
    expect(overview.totals).toEqual({ companies: s.totalCompanies, users: s.totalUsers });

    // The synthetic company: three live users were added above, plus one deleted account.
    const company = await get(`/companies/${companyId}`);
    const [{ rows }] = await db.select({ rows: count() }).from(usersTable).where(eq(usersTable.companyId, companyId));
    expect(Number(rows)).toBe(3);
    expect(company.userCount).toBe(2); // "live" and "toggle"; "gone" is deleted
    const listed = await get(`/companies?search=${encodeURIComponent(COMPANY)}`);
    expect(listed.companies.find((c: { id: number }) => c.id === companyId)?.userCount).toBe(2);

    // Every live company user belongs to exactly one company, so the per-company figures sum to the total.
    const perCompany = await db
      .select({ c: count() })
      .from(usersTable)
      .where(and(isNull(usersTable.deletedAt), sql`${usersTable.role} is distinct from 'platform_owner'`, sql`${usersTable.companyId} is not null`));
    const orphans = await db
      .select({ c: count() })
      .from(usersTable)
      .where(and(isNull(usersTable.deletedAt), sql`${usersTable.role} is distinct from 'platform_owner'`, isNull(usersTable.companyId)));
    expect(Number(perCompany[0].c) + Number(orphans[0].c)).toBe(s.totalUsers);
  });
});

describe("Total Captures and Total Scans", () => {
  it("captures count every saved capture; scans count only those read by OCR", async () => {
    const before = await stats();
    expect(before.totalScans).toBeLessThanOrEqual(before.totalCaptures);

    // Rows written the way the API writes them.
    await db.insert(scansTable).values([
      { companyId, status: "completed", extractionMethod: "ai_vision", captureSource: "camera" }, // OCR card scan
      { companyId, status: "pending", extractionMethod: null, captureSource: "camera" }, // OCR in flight
      { companyId, status: "completed", extractionMethod: "ai_vision", captureSource: "nfc" }, // OCR of an NFC-sourced image
      { companyId, status: "completed", extractionMethod: "manual", captureSource: "qr" }, // QR — a capture, not a scan
      { companyId, status: "completed", extractionMethod: "manual", captureSource: "vcard" }, // vCard — a capture, not a scan
      { companyId, status: "completed", extractionMethod: "manual", captureSource: "manual" }, // typed in — a capture, not a scan
      { companyId, status: "completed", extractionMethod: "ai_vision", captureSource: "camera", deletedAt: new Date() }, // deleted — neither
      { companyId, status: "completed", extractionMethod: "manual", captureSource: "qr", deletedAt: new Date() }, // deleted — neither
    ]);
    const after = await stats();
    expect(after.totalCaptures).toBe(before.totalCaptures + 6);
    expect(after.totalScans).toBe(before.totalScans + 3);
    expect(after.totalScans).toBeLessThanOrEqual(after.totalCaptures);
    // Leads and companies are untouched by captures.
    expect(after.totalLeads).toBe(before.totalLeads);
    expect(after.totalCompanies).toBe(before.totalCompanies);
  });

  it("match independent SQL, and deleted rows are in neither figure", async () => {
    const [[{ captures }], [{ scans }], [{ allRows }]] = await Promise.all([
      db.select({ captures: count() }).from(scansTable).where(isNull(scansTable.deletedAt)),
      db
        .select({ scans: count() })
        .from(scansTable)
        .where(and(isNull(scansTable.deletedAt), or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual")))),
      db.select({ allRows: count() }).from(scansTable),
    ]);
    const s = await stats();
    expect(s.totalCaptures).toBe(Number(captures));
    expect(s.totalScans).toBe(Number(scans));
    expect(Number(allRows)).toBeGreaterThanOrEqual(Number(captures) + 2); // the two deleted rows above
  });

  it("the scan trend and the analytics module count card scans by the same rule", async () => {
    // Today's bucket of the dashboard trend holds the three OCR rows inserted above, not the six captures.
    const [trend, today] = await Promise.all([get("/platform/scan-trend"), get("/platform/analytics/activity")]);
    const [{ ocrToday }] = await db
      .select({ ocrToday: count() })
      .from(scansTable)
      .where(and(isNull(scansTable.deletedAt), or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual")), sql`${scansTable.createdAt} >= date_trunc('day', (now() at time zone 'utc'))`));
    const last = trend[trend.length - 1];
    expect(last.value).toBe(Number(ocrToday));
    expect(last.value).toBeGreaterThanOrEqual(3);
    // 30 trend days and the analytics default window (30 days) cover the same days.
    expect(trend).toHaveLength(30);
    expect(trend.reduce((a: number, p: { value: number }) => a + p.value, 0)).toBe(today.totals.scans.current);
    expect(today.totals.captures.current).toBeGreaterThanOrEqual(today.totals.scans.current + 3);
  });
});

describe("contract", () => {
  it("keeps every existing field and adds totalCaptures", async () => {
    const s = await stats();
    for (const key of ["totalCompanies", "activeCompanies", "totalUsers", "totalCaptures", "totalScans", "totalLeads"]) {
      expect(Number.isInteger(s[key]), key).toBe(true);
      expect(s[key], key).toBeGreaterThanOrEqual(0);
    }
    expect(s).toHaveProperty("revenue.available");
    expect(s).toHaveProperty("subscriptions.byStatus");
    expect(Array.isArray(s.subscriptionDistribution)).toBe(true);
  });
});
