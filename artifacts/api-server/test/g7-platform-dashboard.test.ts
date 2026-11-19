import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, count, eq, gte, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { db, companiesTable, usersTable, scansTable, subscriptionsTable } from "@workspace/db";

// G-7 — the Platform Dashboard uses the same definitions as Platform Owner Analytics.
//
// Exercised against the LIVE API (localhost:80). The dashboard totals are all-time figures,
// so each rule is proven as a DELTA: read the totals, add synthetic rows of a known kind,
// read again. Independent SQL written here is the oracle for the absolute figures. Test
// files run one at a time against the shared database, so nothing else writes meanwhile.
//   • Total Users  — company users that exist today (no deleted account, no platform owner).
//   • Total Captures / Total Scans — every capture vs. the captures sent for OCR.
//   • a company's Users and Captures figures follow the same rules and add up to the totals.
// Every test creates the rows it needs; none depends on another test having run.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SUFFIX = Date.now();
const DAY_MS = 86_400_000;

let platformToken = "";
let seq = 0;

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

async function newCompany(tag: string): Promise<{ id: number; name: string }> {
  const name = `G7 Dash ${SUFFIX} ${tag}`;
  const [c] = await db.insert(companiesTable).values({ name, status: "active", plan: "starter" }).returning({ id: companiesTable.id });
  return { id: c.id, name };
}
const user = (companyId: number | null, extra: Partial<typeof usersTable.$inferInsert> = {}) => ({
  email: `u${++seq}-${SUFFIX}@g7-dash.test`,
  passwordHash: "synthetic-not-a-hash",
  name: `G7 Dash user ${seq}`,
  role: "employee",
  companyId,
  ...extra,
});
// Rows written the way the API writes them: OCR rows carry 'ai_vision' (or nothing while
// they are still processing); every capture saved without OCR carries 'manual'.
const capture = (companyId: number, kind: "ocr" | "ocr-pending" | "ocr-failed" | "qr" | "vcard" | "typed", extra: Partial<typeof scansTable.$inferInsert> = {}) => ({
  companyId,
  status: kind === "ocr-pending" ? "pending" : kind === "ocr-failed" ? "failed" : "completed",
  extractionMethod: kind === "ocr" ? "ai_vision" : kind === "ocr-pending" || kind === "ocr-failed" ? null : "manual",
  captureSource: kind === "qr" ? "qr" : kind === "vcard" ? "vcard" : kind === "typed" ? "manual" : "camera",
  ...extra,
});
const LIVE_COMPANY_USER = and(isNull(usersTable.deletedAt), sql`${usersTable.role} is distinct from 'platform_owner'`);
const OCR = or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual"));

async function purge() {
  const companies = await db.select({ id: companiesTable.id }).from(companiesTable).where(like(companiesTable.name, "G7 Dash %"));
  const ids = companies.map((c) => c.id);
  await db.delete(usersTable).where(like(usersTable.email, "%@g7-dash.test"));
  if (ids.length === 0) return;
  await db.delete(scansTable).where(inArray(scansTable.companyId, ids));
  await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.companyId, ids));
  await db.delete(companiesTable).where(inArray(companiesTable.id, ids));
}

/** Every company the platform lists, read page by page. */
async function allCompanies(): Promise<Array<{ id: number; userCount: number; scanCount: number }>> {
  const out: Array<{ id: number; userCount: number; scanCount: number }> = [];
  for (let page = 1; page < 200; page++) {
    const body = await get(`/companies?limit=100&page=${page}`);
    out.push(...body.companies);
    if (out.length >= body.total || body.companies.length === 0) break;
  }
  return out;
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`).catch((err) => {
    throw new Error(`API not reachable at ${BASE} (${String(err)})`);
  });
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  await purge();
  platformToken = await loginToken(PLATFORM);
});

afterAll(purge);

describe("Total Users", () => {
  it("is the number of company users that exist today", async () => {
    const [[{ live }], [{ all }], [{ owners }], [{ deleted }]] = await Promise.all([
      db.select({ live: count() }).from(usersTable).where(LIVE_COMPANY_USER),
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
    const company = await newCompany("grow");
    const before = await stats();
    await db.insert(usersTable).values(user(company.id));
    expect((await stats()).totalUsers).toBe(before.totalUsers + 1);

    await db.insert(usersTable).values(user(company.id, { isActive: false, deletedAt: new Date() }));
    expect((await stats()).totalUsers).toBe(before.totalUsers + 1);
  });

  it("drops when an account is deleted and returns when it is restored", async () => {
    const company = await newCompany("toggle");
    const [u] = await db.insert(usersTable).values(user(company.id)).returning({ id: usersTable.id });
    const withUser = (await stats()).totalUsers;
    await db.update(usersTable).set({ deletedAt: new Date(), isActive: false }).where(eq(usersTable.id, u.id));
    expect((await stats()).totalUsers).toBe(withUser - 1);
    await db.update(usersTable).set({ deletedAt: null, isActive: true }).where(eq(usersTable.id, u.id));
    expect((await stats()).totalUsers).toBe(withUser);
  });

  it("does not count an account once it is a platform owner", async () => {
    const company = await newCompany("operator");
    const [u] = await db.insert(usersTable).values(user(company.id, { isActive: false })).returning({ id: usersTable.id });
    const asUser = (await stats()).totalUsers;
    // The role alone is flipped on an inactive synthetic row; it never signs in.
    await db.update(usersTable).set({ role: "platform_owner", companyId: null }).where(eq(usersTable.id, u.id));
    try {
      expect((await stats()).totalUsers).toBe(asUser - 1);
    } finally {
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  });

  it("is the figure Platform Owner Analytics reports", async () => {
    const [s, overview] = await Promise.all([stats(), get("/platform/analytics/overview")]);
    expect(overview.totals).toEqual({ companies: s.totalCompanies, users: s.totalUsers });
  });
});

describe("a company's Users figure", () => {
  it("counts the company's users that exist today, on the detail and in the list", async () => {
    const company = await newCompany("users");
    await db.insert(usersTable).values([user(company.id), user(company.id), user(company.id, { isActive: false, deletedAt: new Date() })]);
    const [{ rows }] = await db.select({ rows: count() }).from(usersTable).where(eq(usersTable.companyId, company.id));
    expect(Number(rows)).toBe(3);

    expect((await get(`/companies/${company.id}`)).userCount).toBe(2);
    const listed = await get(`/companies?search=${encodeURIComponent(company.name)}`);
    expect(listed.companies.find((c: { id: number }) => c.id === company.id)?.userCount).toBe(2);
  });

  it("adds up to Total Users across all companies", async () => {
    const company = await newCompany("sum");
    await db.insert(usersTable).values([user(company.id), user(company.id, { isActive: false, deletedAt: new Date() })]);
    const [companies, s] = await Promise.all([allCompanies(), stats()]);
    expect(companies.length).toBe(s.totalCompanies);
    // A live company user without a company row is in the total and in no company.
    const [{ unattached }] = await db
      .select({ unattached: count() })
      .from(usersTable)
      .where(and(LIVE_COMPANY_USER, sql`(${usersTable.companyId} is null or ${usersTable.companyId} not in (select id from ${companiesTable}))`));
    const perCompany = companies.reduce((sum, c) => sum + c.userCount, 0);
    expect(perCompany + Number(unattached)).toBe(s.totalUsers);
  });
});

describe("Total Captures and Total Scans", () => {
  it("captures count every saved capture; scans count only those sent for OCR", async () => {
    const company = await newCompany("captures");
    const before = await stats();
    expect(before.totalScans).toBeLessThanOrEqual(before.totalCaptures);

    await db.insert(scansTable).values([
      capture(company.id, "ocr"), // OCR card scan
      capture(company.id, "ocr-pending"), // OCR in flight — a card scan
      capture(company.id, "ocr-failed"), // OCR failed — still a card scan
      capture(company.id, "ocr", { captureSource: "nfc" }), // OCR of an NFC-sourced image
      capture(company.id, "qr"), // a capture, not a scan
      capture(company.id, "vcard"), // a capture, not a scan
      capture(company.id, "typed"), // a capture, not a scan
      capture(company.id, "ocr", { deletedAt: new Date() }), // deleted — neither
      capture(company.id, "qr", { deletedAt: new Date() }), // deleted — neither
    ]);
    const after = await stats();
    expect(after.totalCaptures).toBe(before.totalCaptures + 7);
    expect(after.totalScans).toBe(before.totalScans + 4);
    expect(after.totalScans).toBeLessThanOrEqual(after.totalCaptures);
    // Leads and companies are untouched by captures.
    expect(after.totalLeads).toBe(before.totalLeads);
    expect(after.totalCompanies).toBe(before.totalCompanies);
  });

  it("match independent SQL, and deleted rows are in neither figure", async () => {
    const company = await newCompany("oracle");
    await db.insert(scansTable).values([capture(company.id, "ocr"), capture(company.id, "qr"), capture(company.id, "ocr", { deletedAt: new Date() }), capture(company.id, "typed", { deletedAt: new Date() })]);
    const [[{ captures }], [{ scans }], [{ allRows }]] = await Promise.all([
      db.select({ captures: count() }).from(scansTable).where(isNull(scansTable.deletedAt)),
      db.select({ scans: count() }).from(scansTable).where(and(isNull(scansTable.deletedAt), OCR)),
      db.select({ allRows: count() }).from(scansTable),
    ]);
    const s = await stats();
    expect(s.totalCaptures).toBe(Number(captures));
    expect(s.totalScans).toBe(Number(scans));
    expect(Number(allRows)).toBeGreaterThanOrEqual(Number(captures) + 2); // the two deleted rows above
  });

  it("a company's Captures figure counts its captures that exist today, and the companies add up", async () => {
    const company = await newCompany("company-captures");
    await db.insert(scansTable).values([capture(company.id, "ocr"), capture(company.id, "ocr-pending"), capture(company.id, "qr"), capture(company.id, "typed"), capture(company.id, "ocr", { deletedAt: new Date() })]);
    // Five rows, four of them live: the figure is the live captures, with or without OCR.
    expect((await get(`/companies/${company.id}`)).scanCount).toBe(4);
    const listed = await get(`/companies?search=${encodeURIComponent(company.name)}`);
    expect(listed.companies.find((c: { id: number }) => c.id === company.id)?.scanCount).toBe(4);

    const [companies, s] = await Promise.all([allCompanies(), stats()]);
    const [{ unattached }] = await db
      .select({ unattached: count() })
      .from(scansTable)
      .where(and(isNull(scansTable.deletedAt), sql`${scansTable.companyId} not in (select id from ${companiesTable})`));
    expect(companies.reduce((sum, c) => sum + c.scanCount, 0) + Number(unattached)).toBe(s.totalCaptures);
  });

  it("the scan trend and the analytics module count card scans by the same rule", async () => {
    const company = await newCompany("trend");
    const at = new Date();
    const day = at.toISOString().slice(0, 10);
    await db.insert(scansTable).values([
      capture(company.id, "ocr", { createdAt: at }),
      capture(company.id, "ocr-pending", { createdAt: at }),
      capture(company.id, "ocr-failed", { createdAt: at }),
      capture(company.id, "qr", { createdAt: at }), // not in the trend
      capture(company.id, "ocr", { createdAt: at, deletedAt: at }), // not in the trend
    ]);
    const trend: Array<{ date: string; value: number }> = await get("/platform/scan-trend");
    expect(trend).toHaveLength(30);
    // The bucket of the day the rows were written on (the last one, or the one before it
    // when the run straddles UTC midnight) holds the OCR rows of that day and nothing else.
    const bucket = trend.find((p) => p.date === day);
    expect(bucket, `no trend bucket for ${day}`).toBeDefined();
    const start = new Date(`${day}T00:00:00.000Z`);
    const [{ ocr }] = await db
      .select({ ocr: count() })
      .from(scansTable)
      .where(and(isNull(scansTable.deletedAt), OCR, gte(scansTable.createdAt, start), lt(scansTable.createdAt, new Date(start.getTime() + DAY_MS))));
    expect(bucket!.value).toBe(Number(ocr));
    expect(bucket!.value).toBeGreaterThanOrEqual(3);

    // The 30 trend days and the same 30 days of the analytics module report the same card scans.
    const activity = await get(`/platform/analytics/activity?from=${trend[0].date}&to=${trend[29].date}`);
    expect(trend.reduce((a, p) => a + p.value, 0)).toBe(activity.totals.scans.current);
    expect(activity.totals.captures.current).toBeGreaterThanOrEqual(activity.totals.scans.current + 1); // the QR capture
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
