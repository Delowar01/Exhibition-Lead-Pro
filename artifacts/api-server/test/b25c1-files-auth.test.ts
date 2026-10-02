// B25 Correction 1 — private file bytes are served only after the NORMAL current
// authentication + authorization checks (no query-string credentials). Against the
// LIVE API with the filesystem driver.
//   • unauthenticated private upload / download → 401
//   • tenant user without the feature permission → 403
//   • foreign tenant → 404 (no existence disclosure); platform owner → 403 (firewall)
//   • a logged-out / disabled user cannot reuse an earlier authorization
//   • a revoked permission is effective on the very next request
//   • a legacy `?t=` query credential is rejected (and never required)
//   • the authenticated web- and mobile-style flows work; the upload capability
//     travels in a dedicated header bound to the reserving user
//   • the intentionally PUBLIC branding-logo and published-card logo routes keep
//     working without auth and expose nothing else
//   • byte responses carry Referrer-Policy: no-referrer
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import sharp from "sharp";
import {
  db,
  companiesTable,
  usersTable,
  sessionsTable,
  loginAttemptsTable,
  contactsTable,
  leadsTable,
  documentsTable,
  documentVersionsTable,
  exportRunsTable,
  storageObjectsTable,
  auditLogsTable,
  rolesTable,
  businessCardsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b25c1qa-${SUFFIX}.test`;
const ADMIN_A = `admin-a@${DOMAIN}`;
const EMP_A = `emp-a@${DOMAIN}`;
const ADMIN_B = `admin-b@${DOMAIN}`;
const TEMP_USER = `temp@${DOMAIN}`;

let platformToken = "";
let tokenA = "";
let tokenEmp = "";
let tokenB = "";
let companyA = 0;
let companyB = 0;
let empId = 0;
let leadA = 0;

function headers(token: string | null, extra: Record<string, string> = {}) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(res: Response) {
  return res.json();
}
function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
async function reserve(token: string, fileName = "f.txt", contentType = "text/plain", size = 16) {
  const res = await api("POST", "/documents/upload-url", token, { fileName, contentType, size });
  expect(res.status).toBe(200);
  return (await json(res)) as { uploadURL: string; objectPath: string; uploadToken: string };
}
async function putBytes(url: string, bytes: Buffer, opts: { token?: string | null; capability?: string | null; contentType?: string } = {}) {
  const h: Record<string, string> = { "Content-Type": opts.contentType ?? "text/plain" };
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  if (opts.capability) h["X-Storage-Capability"] = opts.capability;
  return fetch(url, { method: "PUT", headers: h, body: new Uint8Array(bytes) });
}
async function getBytes(url: string, token: string | null, method = "GET") {
  return fetch(url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer();

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const coA = await api("POST", "/companies", platformToken, { name: `QA B25C1 A ${SUFFIX}`, plan: "professional" });
  expect(coA.status).toBe(201);
  companyA = (await json(coA)).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyA));
  expect((await api("POST", "/users", platformToken, { email: ADMIN_A, name: "QA Admin A", role: "primary_admin", companyId: companyA, password: PW })).status).toBe(201);
  tokenA = await login(ADMIN_A);
  const emp = await api("POST", "/users", tokenA, { email: EMP_A, name: "QA Emp A", role: "employee", password: PW });
  expect(emp.status).toBe(201);
  empId = (await json(emp)).id;
  tokenEmp = await login(EMP_A);
  const coB = await api("POST", "/companies", platformToken, { name: `QA B25C1 B ${SUFFIX}`, plan: "professional" });
  expect(coB.status).toBe(201);
  companyB = (await json(coB)).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyB));
  expect((await api("POST", "/users", platformToken, { email: ADMIN_B, name: "QA Admin B", role: "primary_admin", companyId: companyB, password: PW })).status).toBe(201);
  tokenB = await login(ADMIN_B);
  const c = await api("POST", "/contacts", tokenA, { firstName: "B25C1", lastName: "Target", email: `target@${DOMAIN}` });
  expect(c.status).toBe(201);
  const l = await api("POST", "/leads", tokenA, { title: `QA B25C1 lead ${SUFFIX}`, contactId: (await json(c)).id });
  expect(l.status).toBe(201);
  leadA = (await json(l)).id;
});

afterAll(async () => {
  for (const cid of [companyA, companyB].filter(Boolean)) {
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid));
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, cid));
    await db.delete(documentsTable).where(eq(documentsTable.companyId, cid));
    await db.delete(exportRunsTable).where(eq(exportRunsTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, cid));
    await db.delete(rolesTable).where(eq(rolesTable.companyId, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
  for (const cid of [companyA, companyB].filter(Boolean)) {
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.companyId, cid));
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await db.delete(businessCardsTable).where(inArray(businessCardsTable.userId, ids));
      await db.delete(sessionsTable).where(inArray(sessionsTable.userId, ids));
    }
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("3. private uploads", () => {
  it("the upload target carries no credential; bytes need the session AND the header-bound capability of the reserving user", async () => {
    const bytes = Buffer.from(`upload ${SUFFIX}`);
    const r = await reserve(tokenA, "u.txt", "text/plain", bytes.length);
    expect(r.uploadURL).toMatch(/^http:\/\/localhost(:80)?\/api\/files\/uploads\/[0-9a-f-]{36}$/);
    expect(r.uploadURL).not.toContain("?");
    expect(typeof r.uploadToken).toBe("string");
    expect(r.uploadToken.length).toBeGreaterThan(40);
    expect(JSON.stringify(r)).not.toMatch(/tenants\/|gs:\/\/|storage\.googleapis/);

    expect((await putBytes(r.uploadURL, bytes)).status).toBe(401); // no session
    expect((await putBytes(r.uploadURL, bytes, { capability: r.uploadToken })).status).toBe(401); // capability without session
    expect((await putBytes(r.uploadURL, bytes, { token: tokenA })).status).toBe(403); // session without capability
    expect((await putBytes(r.uploadURL, bytes, { token: tokenEmp, capability: r.uploadToken })).status).toBe(403); // another user of the tenant (no permission, not the reserver)
    expect((await putBytes(r.uploadURL, bytes, { token: tokenB, capability: r.uploadToken })).status).toBe(404); // foreign tenant: no existence disclosure
    expect((await putBytes(r.uploadURL, bytes, { token: platformToken, capability: r.uploadToken })).status).toBe(403); // platform firewall
    const query = await putBytes(`${r.uploadURL}?t=${encodeURIComponent(r.uploadToken)}`, bytes, { token: tokenA, capability: r.uploadToken });
    expect(query.status).toBe(403);
    expect((await json(query)).code).toBe("STORAGE_QUERY_CREDENTIAL_REJECTED");
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.state).toBe("pending"); // nothing above touched the object

    const ok = await putBytes(r.uploadURL, bytes, { token: tokenA, capability: r.uploadToken });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ sizeBytes: bytes.length, sha256: sha(bytes) });
    expect((await putBytes(r.uploadURL, bytes, { token: tokenA, capability: r.uploadToken })).status).toBe(409);
    const created = await api("POST", "/documents", tokenA, { entityType: "lead", entityId: leadA, category: "Quotation", objectPath: r.objectPath, fileName: "u.txt", fileSize: bytes.length, mimeType: "text/plain" });
    expect(created.status).toBe(201);
  });

  it("a capability for one object cannot be replayed against another reserved object", async () => {
    const r1 = await reserve(tokenA);
    const r2 = await reserve(tokenA);
    expect((await putBytes(r2.uploadURL, Buffer.from("x"), { token: tokenA, capability: r1.uploadToken })).status).toBe(403);
    expect((await putBytes(r1.uploadURL.replace(/uploads\/[0-9a-f-]{36}/, `uploads/${randomUUID()}`), Buffer.from("x"), { token: tokenA, capability: r1.uploadToken })).status).toBe(404);
  });
});

describe("3. private downloads", () => {
  let docUrl = "";
  let exportUrl = "";
  const content = Buffer.from(`download ${SUFFIX}`);

  beforeAll(async () => {
    const r = await reserve(tokenA, "d.txt", "text/plain", content.length);
    expect((await putBytes(r.uploadURL, content, { token: tokenA, capability: r.uploadToken })).status).toBe(200);
    const created = await api("POST", "/documents", tokenA, { entityType: "lead", entityId: leadA, category: "Proposal", objectPath: r.objectPath, fileName: "d.txt", fileSize: content.length, mimeType: "text/plain" });
    expect(created.status).toBe(201);
    const dl = await api("GET", `/documents/${(await json(created)).id}/download`, tokenA);
    expect(dl.status).toBe(200);
    docUrl = (await json(dl)).url;
    const exp = await api("POST", "/exports", tokenA, { entityType: "contact", format: "csv" });
    expect(exp.status).toBe(201);
    exportUrl = (await json(exp)).downloadUrl;
  });

  it("download URLs carry no credential and are served only to the authenticated, authorized tenant user", async () => {
    expect(docUrl).toMatch(/^http:\/\/localhost(:80)?\/api\/files\/[0-9a-f-]{36}$/);
    expect(exportUrl).toMatch(/^http:\/\/localhost(:80)?\/api\/files\/[0-9a-f-]{36}$/);
    expect((await getBytes(docUrl, null)).status).toBe(401);
    expect((await getBytes(docUrl, tokenB)).status).toBe(404);
    expect((await getBytes(docUrl, platformToken)).status).toBe(403);
    const q = await getBytes(`${docUrl}?t=anything`, tokenA);
    expect(q.status).toBe(403);
    expect((await json(q)).code).toBe("STORAGE_QUERY_CREDENTIAL_REJECTED");

    const ok = await getBytes(docUrl, tokenA);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(content)).toBe(true);
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ok.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-disposition")).toMatch(/filename="d.txt"/);
    expect((await getBytes(docUrl, tokenA, "HEAD")).status).toBe(200);
    // documents are open tenant-scoped reads: an employee of the tenant may read
    expect((await getBytes(docUrl, tokenEmp)).status).toBe(200);
  });

  it("the feature permission for the object kind is enforced at byte time and a revocation is effective immediately", async () => {
    expect((await getBytes(exportUrl, tokenEmp)).status).toBe(403); // reports.view missing
    const role = await api("POST", "/rbac/roles", tokenA, { name: `QA Reports ${SUFFIX}`, permissions: [{ module: "reports", action: "view" }] });
    expect(role.status).toBe(201);
    const roleId = (await json(role)).id;
    expect((await api("PUT", `/users/${empId}/roles`, tokenA, { roleIds: [roleId] })).status).toBe(200);
    expect((await getBytes(exportUrl, tokenEmp)).status).toBe(200);
    expect((await api("PUT", `/users/${empId}/roles`, tokenA, { roleIds: [] })).status).toBe(200);
    expect((await getBytes(exportUrl, tokenEmp)).status).toBe(403); // same token, next request
    expect((await getBytes(exportUrl, tokenB)).status).toBe(404);
  });

  it("a logged-out session and a disabled account cannot reuse an earlier authorization", async () => {
    const created = await api("POST", "/users", tokenA, { email: TEMP_USER, name: "QA Temp", role: "admin", password: PW });
    expect(created.status).toBe(201);
    const tempId = (await json(created)).id;
    let temp = await login(TEMP_USER);
    expect((await getBytes(docUrl, temp)).status).toBe(200);
    expect((await api("POST", "/auth/logout", temp)).status).toBe(200);
    expect((await getBytes(docUrl, temp)).status).toBe(401);
    temp = await login(TEMP_USER);
    expect((await getBytes(docUrl, temp)).status).toBe(200);
    expect((await api("PATCH", `/users/${tempId}`, tokenA, { isActive: false })).status).toBe(200);
    expect((await getBytes(docUrl, temp)).status).toBe(401);
  });
});

describe("3. public exceptions stay public and constrained", () => {
  it("the managed logo and the published-card logo are served without auth; nothing else is", async () => {
    const up = await fetch(`${BASE}/organization/branding/logo`, { method: "POST", headers: { "Content-Type": "image/png", Authorization: `Bearer ${tokenA}` }, body: new Uint8Array(await png(120, 120)) });
    expect(up.status).toBe(200);
    const logoUrl = (await json(up)).logoUrl as string;
    expect(logoUrl).toMatch(new RegExp(`^/api/branding/logos/${companyA}/[0-9a-f]{32}$`));
    const pub = await fetch(`http://localhost:80${logoUrl}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");
    expect(pub.headers.get("cache-control")).toContain("public");
    const id = logoUrl.split("/").pop()!;
    expect((await fetch(`http://localhost:80/api/branding/logos/${companyB}/${id}`)).status).toBe(404);
    // a published card exposes the SAME constrained projection
    const card = await api("PUT", "/cards/me", tokenA, { fullName: "QA Admin A", isPublished: true });
    expect([200, 201]).toContain(card.status);
    const token = (await json(card)).publicToken;
    if (token) {
      const cardLogo = await fetch(`${BASE}/cards/public/${token}/logo`);
      expect(cardLogo.status).toBe(200);
      expect(cardLogo.headers.get("content-type")).toBe("image/png");
    }
    // the storage byte route itself is never public for logos
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyA)).limit(1);
    expect((await fetch(`${BASE}/files/${row.id}`)).status).toBe(401);
  });
});
