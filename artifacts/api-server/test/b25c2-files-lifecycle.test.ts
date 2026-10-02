// B25 Correction 2 — a stable, credential-free file URL is only as good as the
// LIVE feature association behind it. Against the LIVE API with the filesystem
// driver: every private download re-proves, at byte time, that a current
// feature row of the tenant still carries the object as its current file —
// document version of a non-deleted document, completed export run, ready
// executive report, current scan image, current managed logo — on top of the
// current session, tenant access, active inventory row and feature permission.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
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
  executiveReportsTable,
  scansTable,
  storageObjectsTable,
  auditLogsTable,
  rolesTable,
  businessCardsTable,
} from "@workspace/db";
import * as storage from "../src/services/storage.service.js";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b25c2qa-${SUFFIX}.test`;
const ADMIN_A = `admin-a@${DOMAIN}`;
const EMP_A = `emp-a@${DOMAIN}`;
const ADMIN_B = `admin-b@${DOMAIN}`;

let platformToken = "";
let tokenA = "";
let tokenEmp = "";
let tokenB = "";
let companyA = 0;
let companyB = 0;
let leadA = 0;
const createdRefs: Array<{ companyId: number; kind: storage.ObjectRef["kind"]; reference: string }> = [];

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
async function getBytes(url: string, token: string | null) {
  return fetch(url, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
const fileUrl = (objectId: string) => `http://localhost:80/api/files/${objectId}`;
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer();
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 30 } } }).jpeg().toBuffer();

async function store(companyId: number, input: Omit<storage.StoreBufferInput, "companyId">) {
  const stored = await storage.storeBuffer({ companyId, ...input });
  createdRefs.push({ companyId, kind: input.kind, reference: stored.reference });
  return stored;
}

async function uploadDocument(token: string, content: string, fileName = "life.txt") {
  const bytes = Buffer.from(content);
  const r = await api("POST", "/documents/upload-url", token, { fileName, contentType: "text/plain", size: bytes.length });
  expect(r.status).toBe(200);
  const { uploadURL, uploadToken, objectPath } = await json(r);
  const put = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}`, "X-Storage-Capability": uploadToken }, body: bytes });
  expect(put.status).toBe(200);
  const created = await api("POST", "/documents", token, { entityType: "lead", entityId: leadA, category: "Quotation", objectPath, fileName, fileSize: bytes.length, mimeType: "text/plain" });
  expect(created.status).toBe(201);
  const doc = await json(created);
  const dl = await api("GET", `/documents/${doc.id}/download`, token);
  expect(dl.status).toBe(200);
  const { url } = await json(dl);
  return { docId: doc.id as number, url: url as string, objectPath: objectPath as string, bytes };
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const coA = await api("POST", "/companies", platformToken, { name: `QA B25C2 A ${SUFFIX}`, plan: "professional" });
  expect(coA.status).toBe(201);
  companyA = (await json(coA)).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyA));
  expect((await api("POST", "/users", platformToken, { email: ADMIN_A, name: "QA Admin A", role: "primary_admin", companyId: companyA, password: PW })).status).toBe(201);
  tokenA = await login(ADMIN_A);
  expect((await api("POST", "/users", tokenA, { email: EMP_A, name: "QA Emp A", role: "employee", password: PW })).status).toBe(201);
  tokenEmp = await login(EMP_A);
  const coB = await api("POST", "/companies", platformToken, { name: `QA B25C2 B ${SUFFIX}`, plan: "professional" });
  expect(coB.status).toBe(201);
  companyB = (await json(coB)).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyB));
  expect((await api("POST", "/users", platformToken, { email: ADMIN_B, name: "QA Admin B", role: "primary_admin", companyId: companyB, password: PW })).status).toBe(201);
  tokenB = await login(ADMIN_B);
  const c = await api("POST", "/contacts", tokenA, { firstName: "B25C2", lastName: "Target", email: `target@${DOMAIN}` });
  expect(c.status).toBe(201);
  const l = await api("POST", "/leads", tokenA, { title: `QA B25C2 lead ${SUFFIX}`, contactId: (await json(c)).id });
  expect(l.status).toBe(201);
  leadA = (await json(l)).id;
});

afterAll(async () => {
  for (const ref of createdRefs) await storage.deleteByReference(ref).catch(() => undefined);
  for (const cid of [companyA, companyB].filter(Boolean)) {
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(executiveReportsTable).where(eq(executiveReportsTable.companyId, cid));
    await db.delete(exportRunsTable).where(eq(exportRunsTable.companyId, cid));
    await db.update(documentsTable).set({ currentVersionId: null }).where(eq(documentsTable.companyId, cid));
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, cid));
    await db.delete(documentsTable).where(eq(documentsTable.companyId, cid));
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

describe("6. live feature association on every private download", () => {
  it("document: soft-delete → the copied URL answers 404; restore → it works again for the same version", async () => {
    const { docId, url, bytes } = await uploadDocument(tokenA, `soft ${SUFFIX}`);
    expect(url).not.toContain("?");
    const ok = await getBytes(url, tokenA);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(bytes)).toBe(true);

    expect((await api("DELETE", `/documents/${docId}`, tokenA)).status).toBe(200);
    expect((await getBytes(url, tokenA)).status).toBe(404);

    expect((await api("POST", `/documents/${docId}/restore`, tokenA)).status).toBe(200);
    const again = await getBytes(url, tokenA);
    expect(again.status).toBe(200);
    expect(Buffer.from(await again.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("document: the feature association removed (version + document hard-deleted) → 404 immediately, even though the inventory row is still active", async () => {
    const { docId, url, objectPath } = await uploadDocument(tokenA, `hard ${SUFFIX}`);
    expect((await getBytes(url, tokenA)).status).toBe(200);
    await db.update(documentsTable).set({ currentVersionId: null }).where(eq(documentsTable.id, docId));
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.documentId, docId));
    await db.delete(documentsTable).where(eq(documentsTable.id, docId));
    const [row] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.reference, objectPath));
    expect(row.state).toBe("active");
    expect((await getBytes(url, tokenA)).status).toBe(404);
    createdRefs.push({ companyId: companyA, kind: "document", reference: objectPath });
  });

  it("scan image: the scan's current image moved elsewhere (or the scan was deleted) → the old object's URL fails immediately", async () => {
    const [scan] = await db.insert(scansTable).values({ companyId: companyA, userId: null, status: "completed", imageUrl: null } as never).returning({ id: scansTable.id });
    const stored = await store(companyA, { kind: "scan_image", contentType: "image/jpeg", buffer: await jpeg(40, 30), entityType: "scan", entityId: scan.id });
    await db.update(scansTable).set({ imageUrl: stored.reference }).where(eq(scansTable.id, scan.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(200);

    await db.update(scansTable).set({ imageUrl: `/objects/${randomUUID()}` }).where(eq(scansTable.id, scan.id)); // replaced
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
    await db.update(scansTable).set({ imageUrl: stored.reference }).where(eq(scansTable.id, scan.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(200);
    await db.update(scansTable).set({ deletedAt: new Date() }).where(eq(scansTable.id, scan.id)); // scan soft-deleted
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
  });

  it("branding logo: only the company's CURRENT managed logo is served privately; the public logo route stays the explicit exception", async () => {
    const stored = await store(companyA, { kind: "branding_logo", contentType: "image/png", buffer: await png(64, 64), entityType: "company", entityId: companyA, extension: "png" });
    await db.update(companiesTable).set({ brandLogoKey: stored.reference, brandLogoContentType: "image/png" }).where(eq(companiesTable.id, companyA));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(200);
    expect((await getBytes(fileUrl(stored.objectId), null)).status).toBe(401); // the private byte route is never public
    const id = stored.reference.split("/")[2].split(".")[0];
    expect((await fetch(`${BASE}/branding/logos/${companyA}/${id}`)).status).toBe(200); // public by design, no auth

    await db.update(companiesTable).set({ brandLogoKey: `branding/${companyA}/${"f".repeat(32)}.png` }).where(eq(companiesTable.id, companyA)); // replaced
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
    expect((await fetch(`${BASE}/branding/logos/${companyA}/${id}`)).status).toBe(404);
    await db.update(companiesTable).set({ brandLogoKey: null, brandLogoContentType: null }).where(eq(companiesTable.id, companyA));
  });

  it("export run: status or reference changed → the old URL fails; foreign tenant 404; missing permission 403; platform owner 403", async () => {
    const stored = await store(companyA, { kind: "export", contentType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
    const [run] = await db
      .insert(exportRunsTable)
      .values({ companyId: companyA, entityType: "contact", format: "csv", status: "completed", objectPath: stored.reference, fileName: "contacts.csv" })
      .returning({ id: exportRunsTable.id });
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(200);
    expect((await getBytes(fileUrl(stored.objectId), tokenB)).status).toBe(404);
    expect((await getBytes(fileUrl(stored.objectId), tokenEmp)).status).toBe(403);
    expect((await getBytes(fileUrl(stored.objectId), platformToken)).status).toBe(403);

    await db.update(exportRunsTable).set({ status: "failed" }).where(eq(exportRunsTable.id, run.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
    await db.update(exportRunsTable).set({ status: "completed", objectPath: `/objects/${randomUUID()}` }).where(eq(exportRunsTable.id, run.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
  });

  it("executive report: only a READY report that still carries the reference is downloadable", async () => {
    const stored = await store(companyA, { kind: "report", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") });
    const [rep] = await db
      .insert(executiveReportsTable)
      .values({ companyId: companyA, reportType: "executive_summary", periodKey: `2026-${SUFFIX}`, status: "ready", objectPath: stored.reference, fileName: "summary.pdf" })
      .returning({ id: executiveReportsTable.id });
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(200);
    await db.update(executiveReportsTable).set({ status: "failed" }).where(eq(executiveReportsTable.id, rep.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
    await db.update(executiveReportsTable).set({ status: "ready" }).where(eq(executiveReportsTable.id, rep.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(200);
    await db.delete(executiveReportsTable).where(eq(executiveReportsTable.id, rep.id));
    expect((await getBytes(fileUrl(stored.objectId), tokenA)).status).toBe(404);
  });
});
