// Batch 25 — provider-neutral object storage, end-to-end against the LIVE API
// running the FILESYSTEM driver (OBJECT_STORAGE_DRIVER=fs). Requires the same
// OBJECT_STORAGE_FS_ROOT in the test shell as in the API shell so on-disk
// effects (probe cleanup, tombstone deletes, company purge) can be asserted.
// B25 Correction 1: every private byte request carries the normal session;
// uploads also carry the header-bound capability; URLs hold no credential.
//
//   • upload targets are credential-free API URLs bound to the tenant + user;
//     bytes stream through PUT /files/uploads/:id (409 on reuse, 403 on a
//     missing/foreign capability, 413 before reading an over-limit body)
//   • a storage failure after reservation never produces a committed reference
//   • a staged handle can only be attached by its own tenant (400 otherwise)
//   • downloads are credential-free URLs served by the API with safe headers
//     (no cloud URL, no path, no key); HEAD works; unauthenticated, foreign and
//     platform-operator requests are refused
//   • scan images, export runs and branding logos go through the same boundary;
//     replaced images / logos are tombstoned and their files removed
//   • company deletion tombstones every object and the durable purge removes files
//   • readiness probes the driver and leaves nothing behind; /metrics carries
//     the storage block
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
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
  scansTable,
  exportRunsTable,
  aiSettingsTable,
  aiInvocationsTable,
  aiUsageReservationsTable,
  storageObjectsTable,
  auditLogsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b25qa-${SUFFIX}.test`;
const ADMIN_A = `admin-a@${DOMAIN}`;
const ADMIN_B = `admin-b@${DOMAIN}`;
const ROOT = process.env.OBJECT_STORAGE_FS_ROOT ?? "";
const DOC_LIMIT = 25 * 1024 * 1024;

let platformToken = "";
let tokenA = "";
let tokenB = "";
let companyA = 0;
let companyB = 0;
let leadA = 0;
let companyBDeleted = false;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(res: Response) {
  return res.json();
}
function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
function onDisk(storageKey: string): string {
  return path.join(ROOT, ...storageKey.split("/"));
}
async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for: ${label}`);
}
async function rowsFor(companyId: number) {
  return db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
}
async function reserve(token: string, fileName: string, contentType: string, size: number) {
  const res = await api("POST", "/documents/upload-url", token, { fileName, contentType, size });
  expect(res.status).toBe(200);
  return (await json(res)) as { uploadURL: string; objectPath: string; uploadToken: string };
}
async function putBytes(target: { uploadURL: string; uploadToken: string }, token: string, bytes: Buffer, contentType = "text/plain", extra: Record<string, string> = {}) {
  return fetch(target.uploadURL, { method: "PUT", headers: { "Content-Type": contentType, Authorization: `Bearer ${token}`, "X-Storage-Capability": target.uploadToken, ...extra }, body: new Uint8Array(bytes) });
}
async function getBytes(url: string, token: string | null, method = "GET") {
  return fetch(url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
async function createDoc(token: string, entityType: string, entityId: number, category: string, file: { objectPath: string; fileName: string; fileSize: number; mimeType: string }) {
  return api("POST", "/documents", token, { entityType, entityId, category, ...file });
}
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer();
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 80 }).toBuffer();
async function uploadLogo(token: string, bytes: Buffer, contentType: string) {
  return fetch(`${BASE}/organization/branding/logo`, { method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${token}` }, body: new Uint8Array(bytes) });
}
const FORBIDDEN = ["storage.googleapis.com", "gs://", "tenants/", ROOT || "\u0000never"];
function expectNoInternals(text: string) {
  for (const f of FORBIDDEN) expect(text, `must not contain ${f}`).not.toContain(f);
}

beforeAll(async () => {
  if (!ROOT) throw new Error("OBJECT_STORAGE_FS_ROOT must be set in the test shell (same value as the API shell) for the B25 storage suite");
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = await login(PLATFORM.email, PLATFORM.password);

  const coA = await api("POST", "/companies", platformToken, { name: `QA B25 A ${SUFFIX}`, plan: "professional" });
  expect(coA.status).toBe(201);
  companyA = (await json(coA)).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyA));
  expect((await api("POST", "/users", platformToken, { email: ADMIN_A, name: "QA B25 Admin A", role: "primary_admin", companyId: companyA, password: PW })).status).toBe(201);
  tokenA = await login(ADMIN_A);

  const coB = await api("POST", "/companies", platformToken, { name: `QA B25 B ${SUFFIX}`, plan: "professional" });
  expect(coB.status).toBe(201);
  companyB = (await json(coB)).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyB));
  expect((await api("POST", "/users", platformToken, { email: ADMIN_B, name: "QA B25 Admin B", role: "primary_admin", companyId: companyB, password: PW })).status).toBe(201);
  tokenB = await login(ADMIN_B);

  const c = await api("POST", "/contacts", tokenA, { firstName: "B25", lastName: "Target", email: `b25-target@${DOMAIN}` });
  expect(c.status).toBe(201);
  const l = await api("POST", "/leads", tokenA, { title: `QA B25 Opportunity ${SUFFIX}`, contactId: (await json(c)).id });
  expect(l.status).toBe(201);
  leadA = (await json(l)).id;

  // deterministic stub AI provider for the scan flow (never live Gemini)
  expect((await api("PATCH", "/ai/settings", tokenA, { provider: "stub", model: "stub-model" })).status).toBe(200);
});

afterAll(async () => {
  for (const cid of [companyA, companyB].filter(Boolean)) {
    for (const row of await rowsFor(cid)) rmSync(onDisk(row.storageKey), { force: true });
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid));
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, cid));
    await db.delete(documentsTable).where(eq(documentsTable.companyId, cid));
    await db.delete(exportRunsTable).where(eq(exportRunsTable.companyId, cid));
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, cid));
    await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, cid));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
  for (const cid of [companyA, companyB].filter(Boolean)) {
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.companyId, cid));
    const ids = users.map((u) => u.id);
    if (ids.length) await db.delete(sessionsTable).where(inArray(sessionsTable.userId, ids));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("B25 — upload targets and byte ingestion", () => {
  it("reserves a credential-free API upload URL bound to the tenant (no cloud URL, opaque handle, header capability)", async () => {
    const r = await reserve(tokenA, "notes.txt", "text/plain", 12);
    expect(r.uploadURL).toMatch(/^http:\/\/localhost(:80)?\/api\/files\/uploads\/[0-9a-f-]{36}$/);
    expect(r.uploadURL).not.toContain("?");
    expect(r.objectPath).toMatch(/^\/objects\/[0-9a-f-]{36}$/);
    expect(typeof r.uploadToken).toBe("string");
    expectNoInternals(JSON.stringify(r));
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.companyId).toBe(companyA);
    expect(row.state).toBe("pending");
    expect(row.kind).toBe("document");
    expect(row.storageKey).toMatch(new RegExp(`^tenants/${companyA}/documents/`));
  });

  it("stores the bytes exactly once and verifies them (409 on reuse, 401/403/404 for missing session, missing capability, foreign tenant)", async () => {
    const bytes = Buffer.from(`hello b25 ${SUFFIX}`);
    const r = await reserve(tokenA, "hello.txt", "text/plain", bytes.length);
    const put = await putBytes(r, tokenA, bytes);
    expect(put.status).toBe(200);
    const receipt = await json(put);
    expect(receipt).toEqual({ sizeBytes: bytes.length, sha256: sha(bytes) });
    expect(put.headers.get("cache-control")).toBe("no-store");
    expect(put.headers.get("referrer-policy")).toBe("no-referrer");
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.state).toBe("staged");
    expect(row.sizeBytes).toBe(bytes.length);
    expect(row.sha256).toBe(sha(bytes));
    expect(row.leaseToken).toBeNull();
    expect(existsSync(onDisk(row.storageKey))).toBe(true);
    expect(readdirSync(path.dirname(onDisk(row.storageKey))).some((n) => n.startsWith(".tmp-"))).toBe(false);

    expect((await putBytes(r, tokenA, bytes)).status).toBe(409);
    expect((await fetch(r.uploadURL, { method: "PUT", headers: { "Content-Type": "text/plain", "X-Storage-Capability": r.uploadToken }, body: new Uint8Array(bytes) })).status).toBe(401);
    const other = await reserve(tokenA, "other.txt", "text/plain", 4);
    expect((await fetch(other.uploadURL, { method: "PUT", headers: { "Content-Type": "text/plain", Authorization: `Bearer ${tokenA}` }, body: new Uint8Array(Buffer.from("abcd")) })).status).toBe(403);
    expect((await putBytes(other, tokenB, Buffer.from("abcd"))).status).toBe(404);
    // a valid capability used on a different object id
    const swapped = { uploadURL: other.uploadURL.replace(/uploads\/[0-9a-f-]{36}/, `uploads/${randomUUID()}`), uploadToken: other.uploadToken };
    expect((await putBytes(swapped, tokenA, Buffer.from("abcd"))).status).toBe(404);
    const mismatched = { uploadURL: other.uploadURL, uploadToken: r.uploadToken };
    expect((await putBytes(mismatched, tokenA, Buffer.from("abcd"))).status).toBe(403);
  });

  it("refuses an over-limit upload before reading it and the handle can never be attached", async () => {
    const r = await reserve(tokenA, "big.bin", "application/zip", DOC_LIMIT);
    const res = await putBytes(r, tokenA, Buffer.alloc(DOC_LIMIT + 1, 1), "application/zip");
    expect(res.status).toBe(413);
    expect((await json(res)).code).toBe("STORAGE_TOO_LARGE");
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.state).toBe("pending");
    expect(existsSync(onDisk(row.storageKey))).toBe(false);
    const create = await createDoc(tokenA, "lead", leadA, "Drawing", { objectPath: r.objectPath, fileName: "big.bin", fileSize: DOC_LIMIT, mimeType: "application/zip" });
    expect(create.status).toBe(400);
    expect((await api("POST", "/documents/upload-url", tokenA, { fileName: "x.bin", contentType: "application/zip", size: DOC_LIMIT + 1 })).status).toBe(413);
  });

  it("a storage failure after reservation leaves no committed reference; the failed intent is never reused — a fresh reservation completes the upload", async () => {
    const bytes = Buffer.from("retry me");
    const r = await reserve(tokenA, "retry.txt", "text/plain", bytes.length);
    const failed = await putBytes(r, tokenA, bytes, "text/plain", { "x-storage-test-fail": "1" });
    expect(failed.status).toBe(503);
    expect((await json(failed)).code).toBe("STORAGE_UNAVAILABLE");
    let [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.state).toBe("failed");
    expect(existsSync(onDisk(row.storageKey))).toBe(false);
    expect((await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: r.objectPath, fileName: "retry.txt", fileSize: bytes.length, mimeType: "text/plain" })).status).toBe(400);

    // B25 Correction 2: one publication attempt per intent — the failed target answers 409 and the client reserves a new one
    const retry = await putBytes(r, tokenA, bytes);
    expect(retry.status).toBe(409);
    expect((await json(retry)).code).toBe("STORAGE_UPLOAD_EXPIRED");
    [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.state).toBe("failed");
    expect(existsSync(onDisk(row.storageKey))).toBe(false);

    const fresh = await reserve(tokenA, "retry.txt", "text/plain", bytes.length);
    expect(fresh.objectPath).not.toBe(r.objectPath);
    expect((await putBytes(fresh, tokenA, bytes)).status).toBe(200);
    [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, fresh.objectPath));
    expect(row.state).toBe("staged");
    const created = await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: fresh.objectPath, fileName: "retry.txt", fileSize: bytes.length, mimeType: "text/plain" });
    expect(created.status).toBe(201);
    [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, fresh.objectPath));
    expect(row.state).toBe("active");
    expect(row.entityType).toBe("document_version");
    expect(row.entityId).toBe((await json(created)).currentVersionId);
  });

  it("two concurrent bodies for one upload intent: exactly one succeeds, the other answers 409, the winner's bytes are kept", async () => {
    const a = randomBytes(3000);
    const b = randomBytes(3000);
    const r = await reserve(tokenA, "race.bin", "application/zip", 3000);
    const [ra, rb] = await Promise.all([putBytes(r, tokenA, a, "application/zip"), putBytes(r, tokenA, b, "application/zip")]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, r.objectPath));
    expect(row.state).toBe("staged");
    expect(row.sha256).toBe(sha(winner));
    expect(row.sizeBytes).toBe(3000);
    expect(existsSync(onDisk(row.storageKey))).toBe(true);
    expect(readdirSync(path.dirname(onDisk(row.storageKey))).some((n) => n.startsWith(".tmp-"))).toBe(false);
  });

  it("a staged handle belongs to its tenant: another tenant cannot attach it, a mismatched mimeType is refused", async () => {
    const bytes = Buffer.from("tenant bound");
    const r = await reserve(tokenA, "bound.txt", "text/plain", bytes.length);
    expect((await putBytes(r, tokenA, bytes)).status).toBe(200);
    const stolen = await createDoc(tokenB, "company", companyB, "Company Profile", { objectPath: r.objectPath, fileName: "bound.txt", fileSize: bytes.length, mimeType: "text/plain" });
    expect(stolen.status).toBe(400);
    expect((await json(stolen)).error).toMatch(/Invalid objectPath/);
    const wrongType = await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: r.objectPath, fileName: "bound.pdf", fileSize: bytes.length, mimeType: "application/pdf" });
    expect(wrongType.status).toBe(400);
    expect((await json(wrongType)).error).toMatch(/mimeType/);
    expect((await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: r.objectPath, fileName: "bound.txt", fileSize: bytes.length, mimeType: "text/plain" })).status).toBe(201);
    // attached once: the same handle cannot be attached again
    expect((await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: r.objectPath, fileName: "bound.txt", fileSize: bytes.length, mimeType: "text/plain" })).status).toBe(400);
    // a never-uploaded / foreign-shaped handle is refused too
    expect((await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: `/objects/${randomUUID()}`, fileName: "x.txt", fileSize: 1, mimeType: "text/plain" })).status).toBe(400);
    expect((await createDoc(tokenA, "lead", leadA, "Quotation", { objectPath: "/objects/uploads/whatever", fileName: "x.txt", fileSize: 1, mimeType: "text/plain" })).status).toBe(400);
  });
});

describe("B25 — downloads are authenticated API URLs", () => {
  let docId = 0;
  let objectId = "";
  const content = Buffer.from(`download me ${SUFFIX}\n`.repeat(50));

  beforeAll(async () => {
    const r = await reserve(tokenA, "report.txt", "text/plain", content.length);
    expect((await putBytes(r, tokenA, content)).status).toBe(200);
    const created = await createDoc(tokenA, "lead", leadA, "Proposal", { objectPath: r.objectPath, fileName: "report.txt", fileSize: content.length, mimeType: "text/plain" });
    expect(created.status).toBe(201);
    docId = (await json(created)).id;
    objectId = r.objectPath.replace("/objects/", "");
  });

  it("returns a credential-free API URL and serves the bytes with safe headers (HEAD supported)", async () => {
    const res = await api("GET", `/documents/${docId}/download`, tokenA);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.url).toBe(`http://localhost/api/files/${objectId}`);
    expect(body.fileName).toBe("report.txt");
    expectNoInternals(JSON.stringify(body));

    const file = await getBytes(body.url, tokenA);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(file.headers.get("content-length")).toBe(String(content.length));
    expect(file.headers.get("content-disposition")).toMatch(/^inline; filename="report.txt"/);
    expect(file.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("referrer-policy")).toBe("no-referrer");
    for (const h of file.headers.entries()) expectNoInternals(h.join(": "));
    expect(Buffer.from(await file.arrayBuffer()).equals(content)).toBe(true);

    const head = await getBytes(body.url, tokenA, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(content.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("refuses unauthenticated, foreign-tenant, platform-operator and query-credential requests", async () => {
    const { url } = await json(await api("GET", `/documents/${docId}/download`, tokenA));
    expect((await getBytes(url, null)).status).toBe(401);
    expect((await getBytes(url, tokenB)).status).toBe(404);
    expect((await getBytes(url, platformToken)).status).toBe(403);
    const q = await getBytes(`${url}?t=anything`, tokenA);
    expect(q.status).toBe(403);
    expect((await json(q)).code).toBe("STORAGE_QUERY_CREDENTIAL_REJECTED");
    expect((await getBytes(`http://localhost:80/api/files/${randomUUID()}`, tokenA)).status).toBe(404);
    expect((await api("GET", `/documents/${docId}/download`, tokenB)).status).toBe(404);
  });

  it("never exposes storage internals in document payloads", async () => {
    const detail = await json(await api("GET", `/documents/${docId}`, tokenA));
    expectNoInternals(JSON.stringify(detail));
    expect(detail.currentVersion.objectPath).toMatch(/^\/objects\/[0-9a-f-]{36}$/);
    expect(detail.currentVersion.fileSize).toBe(content.length);
  });
});

describe("B25 — scans, exports and logos use the same boundary", () => {
  it("stores the scan image through the boundary, serves it with auth only, and tombstones a replaced image", async () => {
    const jpg = await jpeg(96, 64);
    const res = await api("POST", "/scans", tokenA, { imageData: `data:image/jpeg;base64,${jpg.toString("base64")}`, appLanguage: "en" });
    expect([200, 201]).toContain(res.status);
    const scanId = (await json(res)).id ?? (await json(res)).scanId;
    expect(scanId).toBeTruthy();
    let stored = "";
    await waitFor(async () => {
      const [s] = await db.select({ imageUrl: scansTable.imageUrl }).from(scansTable).where(eq(scansTable.id, scanId));
      stored = s?.imageUrl ?? "";
      return /^\/objects\/[0-9a-f-]{36}$/.test(stored);
    }, "stored scan image (fire-and-forget upload)");
    const [first] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, stored));
    expect(first.kind).toBe("scan_image");
    expect(first.state).toBe("active");
    expect(first.entityType).toBe("scan");
    expect(first.entityId).toBe(scanId);
    expect(existsSync(onDisk(first.storageKey))).toBe(true);

    const img = await fetch(`${BASE}/scans/${scanId}/image`, { headers: { Authorization: `Bearer ${tokenA}` } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("content-length")).toBe(String(first.sizeBytes));
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await img.arrayBuffer()).byteLength).toBe(first.sizeBytes);
    expect((await fetch(`${BASE}/scans/${scanId}/image`, { headers: { Authorization: `Bearer ${tokenB}` } })).status).toBe(404);
    expect((await fetch(`${BASE}/scans/${scanId}/image`)).status).toBe(401);
    const scanJson = JSON.stringify(await json(await api("GET", `/scans/${scanId}`, tokenA)));
    expectNoInternals(scanJson);
    expect(scanJson).not.toContain("/objects/");

    const replaced = await api("POST", `/scans/${scanId}/replace-image`, tokenA, { imageData: `data:image/png;base64,${(await png(96, 64)).toString("base64")}`, appLanguage: "en" });
    expect([200, 422, 502]).toContain(replaced.status); // OCR outcome is the stub's business; the image swap is what we verify
    const [s2] = await db.select({ imageUrl: scansTable.imageUrl }).from(scansTable).where(eq(scansTable.id, scanId));
    expect(s2.imageUrl).toMatch(/^\/objects\/[0-9a-f-]{36}$/);
    expect(s2.imageUrl).not.toBe(stored);
    const [old] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.id, first.id));
    expect(["deleting", "deleted"]).toContain(old.state);
    await waitFor(async () => !existsSync(onDisk(first.storageKey)), "replaced scan image removed from disk", 5000);
    const [fresh] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, s2.imageUrl!));
    expect(fresh.state).toBe("active");
    expect(existsSync(onDisk(fresh.storageKey))).toBe(true);
  });

  it("writes export artifacts through the boundary and hands out authenticated download URLs", async () => {
    const res = await api("POST", "/exports", tokenA, { entityType: "contact", format: "csv" });
    expect(res.status).toBe(201);
    const run = await json(res);
    expect(run.status).toBe("completed");
    expect(run.downloadUrl).toMatch(/^http:\/\/localhost(:80)?\/api\/files\/[0-9a-f-]{36}$/);
    expectNoInternals(JSON.stringify(run));
    const [er] = await db.select().from(exportRunsTable).where(eq(exportRunsTable.id, run.id));
    expect(er.objectPath).toMatch(/^\/objects\/[0-9a-f-]{36}$/);
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, er.objectPath!));
    expect(row.kind).toBe("export");
    expect(row.state).toBe("active");
    expect(row.entityType).toBe("export_run");
    expect(row.entityId).toBe(run.id);
    expect(row.sizeBytes).toBe(er.fileSize);
    const file = await getBytes(run.downloadUrl, tokenA);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^inline; filename=|^attachment; filename=/);
    expect(file.headers.get("content-disposition")).toContain(er.fileName!);
    expect(file.headers.get("content-length")).toBe(String(er.fileSize));
    expect((await file.arrayBuffer()).byteLength).toBe(er.fileSize);
    expect((await getBytes(run.downloadUrl, null)).status).toBe(401);
    expect((await getBytes(run.downloadUrl, tokenB)).status).toBe(404);
    const again = await api("GET", `/exports/runs/${run.id}/download`, tokenA);
    expect(again.status).toBe(200);
    expect((await json(again)).url).toMatch(/\/api\/files\//);
    expect((await api("GET", `/exports/runs/${run.id}/download`, tokenB)).status).toBe(404);
  });

  it("stores logos through the boundary; a replaced logo is tombstoned and its file removed; the public route stays tenant-bound", async () => {
    const up1 = await uploadLogo(tokenA, await png(200, 200), "image/png");
    expect(up1.status).toBe(200);
    const logo1 = (await json(up1)).logoUrl as string;
    expect(logo1).toMatch(new RegExp(`^/api/branding/logos/${companyA}/[0-9a-f]{32}$`));
    expect((await fetch(`http://localhost:80${logo1}`)).status).toBe(200);
    const [co] = await db.select({ key: companiesTable.brandLogoKey }).from(companiesTable).where(eq(companiesTable.id, companyA));
    const [row1] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, co.key!));
    expect(row1.kind).toBe("branding_logo");
    expect(row1.state).toBe("active");
    expect(row1.entityType).toBe("company");
    expect(existsSync(onDisk(row1.storageKey))).toBe(true);
    const id1 = logo1.split("/").pop()!;
    expect((await fetch(`http://localhost:80/api/branding/logos/${companyB}/${id1}`)).status).toBe(404);

    const up2 = await uploadLogo(tokenA, await png(120, 120), "image/png");
    expect(up2.status).toBe(200);
    const logo2 = (await json(up2)).logoUrl as string;
    expect(logo2).not.toBe(logo1);
    expect((await fetch(`http://localhost:80${logo1}`)).status).toBe(404);
    expect((await fetch(`http://localhost:80${logo2}`)).status).toBe(200);
    const [old] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.id, row1.id));
    expect(["deleting", "deleted"]).toContain(old.state);
    await waitFor(async () => !existsSync(onDisk(row1.storageKey)), "replaced logo removed from disk", 5000);

    // storage failure on replace: previous logo untouched (B18 contract preserved through the new boundary)
    const failed = await fetch(`${BASE}/organization/branding/logo`, { method: "POST", headers: { "Content-Type": "image/png", Authorization: `Bearer ${tokenA}`, "x-branding-test-storage-fail": "1" }, body: new Uint8Array(await png(64, 64)) });
    expect(failed.status).toBe(503);
    expect((await json(failed)).code).toBe("BRANDING_STORAGE_UNAVAILABLE");
    expect((await fetch(`http://localhost:80${logo2}`)).status).toBe(200);
  });
});

describe("B25 — lifecycle, readiness and metrics", () => {
  it("company deletion tombstones every object and the durable purge removes the files", async () => {
    const bytes = Buffer.from("company B file");
    const r = await reserve(tokenB, "b.txt", "text/plain", bytes.length);
    expect((await putBytes(r, tokenB, bytes)).status).toBe(200);
    const created = await createDoc(tokenB, "company", companyB, "Company Profile", { objectPath: r.objectPath, fileName: "b.txt", fileSize: bytes.length, mimeType: "text/plain" });
    expect(created.status).toBe(201);
    const docB = (await json(created)).id;
    const { url } = await json(await api("GET", `/documents/${docB}/download`, tokenB));
    expect((await getBytes(url, tokenB)).status).toBe(200);
    expect((await uploadLogo(tokenB, await png(80, 80), "image/png")).status).toBe(200);
    const before = await rowsFor(companyB);
    const live = before.filter((x) => x.state === "active");
    expect(live.length).toBeGreaterThanOrEqual(2);
    for (const row of live) expect(existsSync(onDisk(row.storageKey))).toBe(true);

    const del = await api("DELETE", `/companies/${companyB}`, platformToken);
    expect(del.status).toBe(200);
    companyBDeleted = true;
    const after = await rowsFor(companyB);
    expect(after.length).toBe(before.length);
    for (const row of after) expect(["deleting", "deleted"]).toContain(row.state);
    await waitFor(async () => {
      const rows = await rowsFor(companyB);
      return rows.every((x) => x.state === "deleted") && live.every((x) => !existsSync(onDisk(x.storageKey)));
    }, "company purge job removed every file", 20_000);
  });

  it("readiness probes the filesystem driver and leaves nothing behind; health is unchanged", async () => {
    const ready = await fetch(`${BASE}/readyz`);
    expect(ready.status).toBe(200);
    const body = await json(ready);
    expect(body.checks.storage).toBe("ok");
    expect(body.checks.database).toBe("ok");
    expect(body.status).toBe("ok");
    const healthDir = path.join(ROOT, "health");
    expect(existsSync(healthDir) ? readdirSync(healthDir) : []).toEqual([]);
    expect(await json(await fetch(`${BASE}/healthz`))).toEqual({ status: "ok" });
  });

  it("the operator metrics snapshot carries the storage block (counters only)", async () => {
    const res = await api("GET", "/metrics", platformToken);
    expect(res.status).toBe(200);
    const m = await json(res);
    expect(m.storage.driver).toBe("fs");
    expect(m.storage.legacyFallback).toBe(false);
    expect(m.storage.mirror).toBe(false);
    expect(m.storage.legacyReads).toBe("off");
    for (const k of ["primaryFailures", "legacyFallbackReads", "mirrorFailures", "migrationVerifyFailures", "deleteFailures", "legacyRegistrations"]) {
      expect(Number.isInteger(m.storage[k]) && m.storage[k] >= 0, k).toBe(true);
    }
    expect(m.storage.primaryFailures).toBeGreaterThanOrEqual(2); // the two armed failures above
    expect(Number.isInteger(m.storage.pendingUploads)).toBe(true);
    expect(Number.isInteger(m.storage.pendingDeletes)).toBe(true);
    expect(Number.isInteger(m.storage.retainedLegacyObjects)).toBe(true);
    expectNoInternals(JSON.stringify(m));
    expect((await api("GET", "/metrics", tokenA)).status).toBe(403);
  });

  it("teardown guard: the deleted tenant is gone", async () => {
    expect(companyBDeleted).toBe(true);
    const rows = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyB));
    expect(rows).toHaveLength(0);
  });
});
