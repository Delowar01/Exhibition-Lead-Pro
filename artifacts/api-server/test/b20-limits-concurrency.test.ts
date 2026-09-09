import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq, and, inArray, like } from "drizzle-orm";
import sharp from "sharp";
import { db, companiesTable, usersTable, contactsTable, eventsTable, invitationsTable, scansTable, subscriptionUsageReservationsTable, auditLogsTable } from "@workspace/db";

// Batch 20 — race-free limit enforcement against the LIVE API. Limits are
// unlimited by default; this suite configures small overrides through the
// platform-owner API and fires PARALLEL requests at every enforced path:
// contacts (direct create + CSV import contending), events, admins / employees
// (users, pending invitations, role changes, invitation acceptance), single scans
// (reservations released on failure, retry within the TTL not double-charged)
// and batch capture (all-or-nothing reservation). OCR uses the deterministic
// stub provider — no Gemini, no email, no object storage.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b20limits-${SUFFIX}.test`;

let platformToken = "";
let adminToken = "";
let companyId = 0;
let companyD = 0;
let adminId = 0;
const companyIds: number[] = [];
const images: string[] = [];

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string, body?: unknown) {
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
const setLimits = async (cid: number, limits: Record<string, number | null>) => {
  const res = await api("PUT", `/platform/subscriptions/${cid}/limits`, platformToken, { limits });
  expect(res.status, res.text).toBe(200);
  return res.body;
};
const usage = async (resource: string) => {
  const res = await api("GET", "/subscriptions/usage", adminToken);
  expect(res.status).toBe(200);
  return res.body.resources.find((r: any) => r.resource === resource);
};
const limitError = (r: { status: number; body: any }, resource: string) => {
  expect(r.status).toBe(409);
  expect(r.body.code).toBe("LIMIT_EXCEEDED");
  expect(r.body.context).toMatchObject({ resource });
  expect(r.body.context.limit).toBeTypeOf("number");
  expect(r.body.context.used).toBeTypeOf("number");
  expect(r.body.context.requested).toBeTypeOf("number");
};
const contactBody = (tag: string) => ({ firstName: "Limit", lastName: tag, email: `${tag}-${SUFFIX}@${DOMAIN}` });
const csv = (rows: string[]) => Buffer.from(`name,email\n${rows.map((r) => `${r},${r}-${SUFFIX}@${DOMAIN}`).join("\n")}\n`).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

async function waitForBatch(jobId: string, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const r = await api("GET", `/scans/batch/${jobId}`, adminToken);
    if (r.status === 200 && (r.body.status === "completed" || r.body.status === "failed")) return r.body;
    if (Date.now() - start > timeoutMs) throw new Error(`batch ${jobId} did not finish: ${r.text.slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 250));
  }
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  for (const [name, setter] of [
    [`QA B20 Limits ${SUFFIX}`, (id: number) => (companyId = id)],
    [`QA B20 Limits D ${SUFFIX}`, (id: number) => (companyD = id)],
  ] as const) {
    const res = await api("POST", "/companies", platformToken, { name, plan: "free" });
    expect(res.status, res.text).toBe(201);
    setter(res.body.id);
    companyIds.push(res.body.id);
  }
  const admin = await api("POST", "/users", platformToken, { email: `admin@${DOMAIN}`, name: "Limits Admin", role: "primary_admin", companyId, password: PW });
  expect(admin.status, admin.text).toBe(201);
  adminId = admin.body.id;
  adminToken = await login(`admin@${DOMAIN}`);
  const ai = await api("PATCH", "/ai/settings", adminToken, { provider: "stub", model: "stub-model" });
  expect(ai.status, ai.text).toBe(200);
  for (let i = 0; i < 8; i++) {
    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 200 - i * 10, g: 100 + i * 12, b: 50 + i * 20 } } }).png().toBuffer();
    images.push(`data:image/png;base64,${png.toString("base64")}`);
  }
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(scansTable).where(inArray(scansTable.companyId, companyIds));
    await db.delete(subscriptionUsageReservationsTable).where(inArray(subscriptionUsageReservationsTable.companyId, companyIds));
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(eventsTable).where(inArray(eventsTable.companyId, companyIds));
    await db.delete(invitationsTable).where(inArray(invitationsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
});

describe("contacts — parallel creates and CSV imports share one boundary", () => {
  it("exactly `limit` parallel creates succeed; the rest fail with a stable 409", async () => {
    await setLimits(companyId, { contacts: 3 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api("POST", "/contacts", adminToken, contactBody(`par${i}`))));
    const ok = results.filter((r) => r.status === 201);
    const denied = results.filter((r) => r.status !== 201);
    expect(ok).toHaveLength(3);
    expect(denied).toHaveLength(3);
    for (const d of denied) limitError(d, "contacts");
    const rows = await db.select().from(contactsTable).where(eq(contactsTable.companyId, companyId));
    expect(rows).toHaveLength(3);
    expect(await usage("contacts")).toMatchObject({ used: 3, limit: 3, remaining: 0, enforced: true, source: "override" });
  });
  it("an import larger than the remaining capacity is refused whole (no partial rows)", async () => {
    await setLimits(companyId, { contacts: 5 });
    const res = await api("POST", "/imports/commit", adminToken, { entityType: "contact", file: csv(["imp-a", "imp-b", "imp-c"]), mapping: { name: "name", email: "email" } });
    limitError(res, "contacts");
    expect(res.body.context).toMatchObject({ limit: 5, used: 3, requested: 3 });
    expect((await db.select().from(contactsTable).where(eq(contactsTable.companyId, companyId))).length).toBe(3);
  });
  it("an import and a direct create racing for the last slots never exceed the limit", async () => {
    const [imp, direct] = await Promise.all([
      api("POST", "/imports/commit", adminToken, { entityType: "contact", file: csv(["race-a", "race-b"]), mapping: { name: "name", email: "email" } }),
      api("POST", "/contacts", adminToken, contactBody("race-direct")),
    ]);
    const count = (await db.select().from(contactsTable).where(eq(contactsTable.companyId, companyId))).length;
    expect(count).toBeLessThanOrEqual(5);
    const failures = [imp, direct].filter((r) => r.status === 409);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) limitError(f, "contacts");
    expect((await usage("contacts")).used).toBe(count);
  });
  it("clearing the override restores unlimited creation; another tenant's limits are independent", async () => {
    await setLimits(companyId, {});
    expect((await api("POST", "/contacts", adminToken, contactBody("unlimited"))).status).toBe(201);
    expect(await usage("contacts")).toMatchObject({ limit: null, enforced: false });
    await setLimits(companyD, { contacts: 1 });
    const dAdmin = await api("POST", "/users", platformToken, { email: `admin-d@${DOMAIN}`, name: "D", role: "primary_admin", companyId: companyD, password: PW });
    expect(dAdmin.status).toBe(201);
    const tokenD = await login(`admin-d@${DOMAIN}`);
    expect((await api("POST", "/contacts", tokenD, contactBody("d1"))).status).toBe(201);
    limitError(await api("POST", "/contacts", tokenD, contactBody("d2")), "contacts");
    expect((await api("POST", "/contacts", adminToken, contactBody("still-unlimited"))).status).toBe(201);
  });
});

describe("events", () => {
  it("parallel event creation respects the limit", async () => {
    await setLimits(companyId, { events: 2 });
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => api("POST", "/events", adminToken, { name: `Limit Event ${i} ${SUFFIX}`, status: "upcoming" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const d of results.filter((r) => r.status !== 201)) limitError(d, "events");
    expect((await db.select().from(eventsTable).where(eq(eventsTable.companyId, companyId))).length).toBe(2);
    expect(await usage("events")).toMatchObject({ used: 2, limit: 2 });
    await setLimits(companyId, {});
  });
});

describe("admins / employees — users, pending invitations and role changes", () => {
  let employeeUserId = 0;
  let pendingInvitationId = 0;
  it("counts existing users; direct creation and invitations both stop at the limit", async () => {
    await setLimits(companyId, { admins: 2, employees: 2 });
    expect(await usage("admins")).toMatchObject({ used: 1, limit: 2 });
    const a2 = await api("POST", "/users", adminToken, { email: `admin2@${DOMAIN}`, name: "Admin 2", role: "admin", password: PW });
    expect(a2.status, a2.text).toBe(201);
    limitError(await api("POST", "/users", adminToken, { email: `admin3@${DOMAIN}`, name: "Admin 3", role: "admin", password: PW }), "admins");
    limitError(await api("POST", "/invitations", adminToken, { email: `admin4@${DOMAIN}`, name: null, role: "admin", companyId: null }), "admins");
    const inv = await api("POST", "/invitations", adminToken, { email: `emp-inv@${DOMAIN}`, name: null, role: "employee", companyId: null });
    expect(inv.status, inv.text).toBe(201);
    pendingInvitationId = inv.body.invitation.id;
    const e2 = await api("POST", "/users", adminToken, { email: `emp2@${DOMAIN}`, name: "Emp 2", role: "employee", password: PW });
    expect(e2.status, e2.text).toBe(201);
    employeeUserId = e2.body.id;
    const emp = await usage("employees");
    expect(emp).toMatchObject({ used: 2, limit: 2 });
    expect(emp.details).toMatchObject({ users: 1, pendingInvitations: 1 });
    limitError(await api("POST", "/invitations", adminToken, { email: `emp3@${DOMAIN}`, name: null, role: "employee", companyId: null }), "employees");
    limitError(await api("POST", "/users", adminToken, { email: `emp4@${DOMAIN}`, name: "Emp 4", role: "employee", password: PW }), "employees");
  });
  it("a role change into a full family is refused; parallel promotions admit exactly the free slots", async () => {
    limitError(await api("PATCH", `/users/${employeeUserId}`, adminToken, { role: "admin" }), "admins");
    await setLimits(companyId, { admins: 3, employees: 3 });
    const e3 = await api("POST", "/users", adminToken, { email: `emp3@${DOMAIN}`, name: "Emp 3", role: "employee", password: PW });
    expect(e3.status, e3.text).toBe(201);
    // One admin slot left (used 2 of 3): two parallel promotions → exactly one succeeds.
    const results = await Promise.all([
      api("PATCH", `/users/${employeeUserId}`, adminToken, { role: "admin" }),
      api("PATCH", `/users/${e3.body.id}`, adminToken, { role: "admin" }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const d of results.filter((r) => r.status !== 200)) limitError(d, "admins");
    expect(await usage("admins")).toMatchObject({ used: 3, limit: 3 });
  });
  it("accepting a pending invitation never double-counts the invitee", async () => {
    // employees: 1 user (whichever promotion failed) + 1 pending = 2 of 3 → tighten to exactly the current usage.
    const before = await usage("employees");
    await setLimits(companyId, { admins: 3, employees: before.used });
    const raw = `b20-accept-${SUFFIX}`;
    await db.update(invitationsTable).set({ tokenHash: createHash("sha256").update(raw).digest("hex") }).where(eq(invitationsTable.id, pendingInvitationId));
    const accepted = await api("POST", "/invitations/accept", adminToken, { token: raw, name: "Invited Employee", password: PW });
    expect(accepted.status, accepted.text).toBe(200);
    const after = await usage("employees");
    expect(after.used).toBe(before.used);
    expect(after.details.pendingInvitations).toBe(before.details.pendingInvitations - 1);
    expect(after.details.users).toBe(before.details.users + 1);
    await setLimits(companyId, {});
  });
});

describe("scans — reservations under the limit, released on failure, idempotent retries, batch all-or-nothing", () => {
  it("exactly `limit` parallel scans are admitted; failures release their reservation", async () => {
    await setLimits(companyId, { scans: 2 });
    const results = await Promise.all(images.slice(0, 4).map((imageData) => api("POST", "/scans", adminToken, { imageData, appLanguage: "en" })));
    const ok = results.filter((r) => r.status === 201);
    expect(ok, results.map((r) => `${r.status}:${r.text.slice(0, 80)}`).join(" | ")).toHaveLength(2);
    for (const d of results.filter((r) => r.status !== 201)) limitError(d, "scans");
    const u = await usage("scans");
    expect(u).toMatchObject({ used: 2, limit: 2, remaining: 0 });
    expect(u.details).toMatchObject({ scans: 2, reservations: 0 });
    const pending = await db.select().from(subscriptionUsageReservationsTable).where(and(eq(subscriptionUsageReservationsTable.companyId, companyId), eq(subscriptionUsageReservationsTable.status, "pending")));
    expect(pending).toHaveLength(0);
    const consumed = await db.select().from(subscriptionUsageReservationsTable).where(and(eq(subscriptionUsageReservationsTable.companyId, companyId), eq(subscriptionUsageReservationsTable.status, "consumed")));
    expect(consumed).toHaveLength(2);
    expect(consumed.every((r) => r.scanId != null)).toBe(true);
    // Reservation keys are opaque hashes — never the image itself.
    expect(consumed.every((r) => r.idempotencyKey === `scan:${companyId}:${adminId}:${sha(images.indexOf(images[0]) >= 0 ? "" : "")}` || /^scan:\d+:\d+:[a-f0-9]{32}$/.test(r.idempotencyKey))).toBe(true);
  });
  it("a no-card result releases capacity; a retry of the same capture within the TTL is not reserved twice", async () => {
    await setLimits(companyId, { scans: 3 });
    expect((await api("PATCH", "/ai/settings", adminToken, { provider: "stub", model: "stub-nocard" })).status).toBe(200);
    const noCard = await api("POST", "/scans", adminToken, { imageData: images[4], appLanguage: "en" });
    expect(noCard.status).toBe(422);
    expect(noCard.body.code).toBe("SCAN_NO_CARD");
    expect((await usage("scans")).used).toBe(2);
    const released = await db.select().from(subscriptionUsageReservationsTable).where(and(eq(subscriptionUsageReservationsTable.companyId, companyId), eq(subscriptionUsageReservationsTable.status, "released")));
    expect(released.length).toBeGreaterThanOrEqual(1);
    expect((await api("PATCH", "/ai/settings", adminToken, { provider: "stub", model: "stub-model" })).status).toBe(200);
    // Retry the SAME image that already succeeded: admitted without a new reservation (TTL window).
    const successful = (await db.select().from(scansTable).where(and(eq(scansTable.companyId, companyId), eq(scansTable.status, "completed")))).length;
    const retry = await api("POST", "/scans", adminToken, { imageData: images[0], appLanguage: "en" });
    expect(retry.status, retry.text).toBe(201);
    const reservations = await db.select().from(subscriptionUsageReservationsTable).where(eq(subscriptionUsageReservationsTable.companyId, companyId));
    expect(reservations.filter((r) => r.status === "consumed")).toHaveLength(2);
    expect((await db.select().from(scansTable).where(and(eq(scansTable.companyId, companyId), eq(scansTable.status, "completed")))).length).toBe(successful + 1);
    // The retried scan is a real completed scan and counts toward usage → the limit is now reached.
    expect((await usage("scans")).used).toBe(3);
    limitError(await api("POST", "/scans", adminToken, { imageData: images[5], appLanguage: "en" }), "scans");
  });
  it("batch analysis reserves every item up front and rolls back when any item does not fit", async () => {
    await setLimits(companyId, { scans: 4 });
    const tooMany = await api("POST", "/scans/batch-analyze", adminToken, {
      items: [
        { key: "b1", fields: {}, imageData: images[6], appLanguage: "en" },
        { key: "b2", fields: {}, imageData: images[7], appLanguage: "en" },
      ],
    });
    limitError(tooMany, "scans");
    const pending = await db.select().from(subscriptionUsageReservationsTable).where(and(eq(subscriptionUsageReservationsTable.companyId, companyId), eq(subscriptionUsageReservationsTable.status, "pending")));
    expect(pending).toHaveLength(0);
    expect((await usage("scans")).used).toBe(3);
    const fits = await api("POST", "/scans/batch-analyze", adminToken, { items: [{ key: "b3", fields: {}, imageData: images[6], appLanguage: "en" }] });
    expect(fits.status, fits.text).toBe(202);
    expect((await usage("scans")).used).toBe(4); // reserved immediately
    const job = await waitForBatch(fits.body.jobId ?? fits.body.id);
    expect(job.status).toBe("completed");
    expect((await usage("scans")).used).toBe(4);
    const batchRes = await db.select().from(subscriptionUsageReservationsTable).where(and(eq(subscriptionUsageReservationsTable.companyId, companyId), like(subscriptionUsageReservationsTable.idempotencyKey, `batch:${companyId}:%`)));
    expect(batchRes.some((r) => r.status === "consumed")).toBe(true);
    limitError(await api("POST", "/scans", adminToken, { imageData: images[7], appLanguage: "en" }), "scans");
    // Items without an image reserve nothing (recognition only).
    const noImage = await api("POST", "/scans/batch-analyze", adminToken, { items: [{ key: "b4", fields: { firstName: "No", lastName: "Image" } }] });
    expect(noImage.status).toBe(202);
    await setLimits(companyId, {});
  });
});

describe("storage is reported honestly and never enforced", () => {
  it("a storage override is accepted but flagged unmeasured / unenforced", async () => {
    await setLimits(companyId, { storageMb: 1 });
    const s = await usage("storageMb");
    expect(s).toMatchObject({ limit: 1, measurable: false, enforced: false, remaining: null });
    await setLimits(companyId, {});
  });
});
