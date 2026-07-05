// Stage 3 Phase 3B — Enterprise Document Management (integration).
//
// Exercises the full document lifecycle against the LIVE API (localhost:80),
// mirroring the other integration suites: upload (presigned PUT → object
// storage) → create → download (content verified) → versioning (never
// overwrite) → metadata → rename/move → search/filters → soft delete/restore,
// plus RBAC (permission-gated writes), tenant isolation (cross-tenant 404), and
// the platform_owner privacy firewall (403 on every /documents endpoint).
//
// All fixtures live under throwaway tenants created via the platform owner and
// are torn down in afterAll, so demo accounts and existing data are untouched.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  eventsTable,
  documentsTable,
  documentVersionsTable,
  loginAttemptsTable,
  sessionsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `docsqa-${SUFFIX}.test`;
const FOREIGN_DOMAIN = `docsqa-foreign-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const EMP_EMAIL = `qa-emp@${DOMAIN}`;
const FOREIGN_ADMIN_EMAIL = `qa-admin@${FOREIGN_DOMAIN}`;

let platformToken = "";
let orgToken = "";
let empToken = "";
let foreignToken = "";

let companyId = 0;
let foreignCompanyId = 0;
let adminId = 0;
let empId = 0;
let contactId = 0;
let leadId = 0;
let eventId = 0;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function login(creds: { email: string; password: string }): Promise<{ token: string; companyId: number; userId: number }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, companyId: body.user.companyId, userId: body.user.id };
}

async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Presigned PUT upload helper: mirrors the real client flow (request upload URL →
// PUT bytes directly to object storage → echo back the normalized objectPath).
async function uploadFile(
  token: string,
  content: string,
  opts: { fileName?: string; mimeType?: string } = {},
): Promise<{ objectPath: string; fileName: string; fileSize: number; mimeType: string }> {
  const fileName = opts.fileName ?? "file.txt";
  const mimeType = opts.mimeType ?? "text/plain";
  const bytes = Buffer.from(content, "utf8");
  const fileSize = bytes.byteLength;

  const urlRes = await api("POST", "/documents/upload-url", token, { fileName, contentType: mimeType, size: fileSize });
  if (urlRes.status !== 200) throw new Error(`upload-url failed: ${urlRes.status}`);
  const { uploadURL, objectPath } = await urlRes.json();

  const put = await fetch(uploadURL, { method: "PUT", body: bytes });
  if (!put.ok) throw new Error(`PUT to object storage failed: ${put.status}`);

  return { objectPath, fileName, fileSize, mimeType };
}

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  const platform = await login(PLATFORM);
  platformToken = platform.token;

  // ── Primary tenant ──
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Docs ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const createAdmin = await api("POST", "/users", platformToken, {
    email: ADMIN_EMAIL,
    name: "QA Docs Admin",
    role: "primary_admin",
    companyId,
    password: PW,
  });
  expect(createAdmin.status).toBe(201);
  adminId = (await createAdmin.json()).id;
  orgToken = (await login({ email: ADMIN_EMAIL, password: PW })).token;

  const createEmp = await api("POST", "/users", orgToken, { email: EMP_EMAIL, name: "QA Docs Employee", role: "employee", password: PW });
  expect(createEmp.status).toBe(201);
  empId = (await createEmp.json()).id;
  empToken = (await login({ email: EMP_EMAIL, password: PW })).token;

  // Attach targets (contact / lead / event) under the primary tenant.
  const c = await api("POST", "/contacts", orgToken, { firstName: "Doc", lastName: "Target", email: `doc-target@${DOMAIN}` });
  expect(c.status).toBe(201);
  contactId = (await c.json()).id;

  const l = await api("POST", "/leads", orgToken, { title: `QA Opportunity ${SUFFIX}`, contactId });
  expect(l.status).toBe(201);
  leadId = (await l.json()).id;

  const e = await api("POST", "/events", orgToken, { name: `QA Event ${SUFFIX}` });
  expect(e.status).toBe(201);
  eventId = (await e.json()).id;

  // ── Foreign tenant (for cross-tenant isolation) ──
  const foreignCo = await api("POST", "/companies", platformToken, { name: `QA Docs Foreign ${SUFFIX}`, plan: "professional" });
  expect(foreignCo.status).toBe(201);
  foreignCompanyId = (await foreignCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, foreignCompanyId));

  const foreignAdmin = await api("POST", "/users", platformToken, {
    email: FOREIGN_ADMIN_EMAIL,
    name: "QA Foreign Admin",
    role: "primary_admin",
    companyId: foreignCompanyId,
    password: PW,
  });
  expect(foreignAdmin.status).toBe(201);
  foreignToken = (await login({ email: FOREIGN_ADMIN_EMAIL, password: PW })).token;
});

afterAll(async () => {
  // Documents/versions cascade on company delete, but purge explicitly first so
  // the FKs to users don't block user teardown and nothing lingers if the
  // company delete is skipped.
  for (const cid of [companyId, foreignCompanyId].filter(Boolean)) {
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, cid));
    await db.delete(documentsTable).where(eq(documentsTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(eventsTable).where(eq(eventsTable.companyId, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${FOREIGN_DOMAIN}`));
  for (const cid of [companyId, foreignCompanyId].filter(Boolean)) {
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.companyId, cid));
    const ids = users.map((u) => u.id);
    if (ids.length) await db.delete(sessionsTable).where(inArray(sessionsTable.userId, ids));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("Documents — category catalog", () => {
  it("exposes the per-entity category catalog", async () => {
    const res = await api("GET", "/documents/categories", orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.company)).toBe(true);
    expect(body.lead).toContain("Quotation");
    expect(body.contact).toContain("Business Card");
    expect(body.event).toContain("Images");
  });
});

describe("Documents — upload validation (MIME + size)", () => {
  it("rejects an unsupported MIME type (400)", async () => {
    const res = await api("POST", "/documents/upload-url", orgToken, {
      fileName: "evil.exe",
      contentType: "application/x-msdownload",
      size: 100,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a file over the 25MB cap (413)", async () => {
    const res = await api("POST", "/documents/upload-url", orgToken, {
      fileName: "big.pdf",
      contentType: "application/pdf",
      size: 26 * 1024 * 1024,
    });
    expect(res.status).toBe(413);
  });
});

describe("Documents — create, download, metadata", () => {
  let docId = 0;
  const originalContent = "Quotation V1 — original body";

  it("uploads and creates a document (201) with first version + metadata", async () => {
    const file = await uploadFile(orgToken, originalContent, { fileName: "quotation-v1.txt" });
    const res = await api("POST", "/documents", orgToken, {
      entityType: "lead",
      entityId: leadId,
      category: "Quotation",
      name: "Project Quotation",
      description: "Initial quote",
      label: "V1",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    docId = body.id;
    expect(body.companyId).toBe(companyId);
    expect(body.entityType).toBe("lead");
    expect(body.entityId).toBe(leadId);
    expect(body.name).toBe("Project Quotation");
    expect(body.category).toBe("Quotation");
    expect(body.versionCount).toBe(1);
    expect(body.currentVersion.versionNumber).toBe(1);
    // Metadata enrichment: uploader, creator, entity name, file attributes.
    expect(body.currentVersion.fileSize).toBe(file.fileSize);
    expect(body.currentVersion.mimeType).toBe("text/plain");
    expect(body.currentVersion.uploadedByName).toBe("QA Docs Admin");
    expect(body.createdByName).toBe("QA Docs Admin");
    expect(body.entityName).toBe(`QA Opportunity ${SUFFIX}`);
  });

  it("returns a signed download URL whose content matches the upload", async () => {
    const res = await api("GET", `/documents/${docId}/download`, orgToken);
    expect(res.status).toBe(200);
    const { url, fileName, mimeType } = await res.json();
    expect(fileName).toBe("quotation-v1.txt");
    expect(mimeType).toBe("text/plain");
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(originalContent);
  });

  it("fetches the document with full version history", async () => {
    const res = await api("GET", `/documents/${docId}`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(docId);
    expect(body.versions.length).toBe(1);
    expect(body.versions[0].versionNumber).toBe(1);
  });

  it("rejects an invalid category for the entity type (400)", async () => {
    const file = await uploadFile(orgToken, "x");
    const res = await api("POST", "/documents", orgToken, {
      entityType: "event",
      entityId: eventId,
      category: "Quotation", // not valid for event
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    expect(res.status).toBe(400);
  });

  it("rejects attaching to a non-existent entity (400)", async () => {
    const file = await uploadFile(orgToken, "x");
    const res = await api("POST", "/documents", orgToken, {
      entityType: "lead",
      entityId: 999999,
      category: "Quotation",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    expect(res.status).toBe(400);
  });
});

describe("Documents — versioning (never overwrite)", () => {
  let docId = 0;
  let v1Id = 0;
  const v1Content = "BOQ V1 body";
  const v2Content = "BOQ V2 body — revised";

  beforeAll(async () => {
    const file = await uploadFile(orgToken, v1Content, { fileName: "boq.txt" });
    const res = await api("POST", "/documents", orgToken, {
      entityType: "lead",
      entityId: leadId,
      category: "BOQ",
      name: "BOQ",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    const body = await res.json();
    docId = body.id;
    v1Id = body.currentVersion.id;
  });

  it("appends a new version and repoints current without overwriting v1", async () => {
    const file = await uploadFile(orgToken, v2Content, { fileName: "boq-final.txt" });
    const res = await api("POST", `/documents/${docId}/versions`, orgToken, {
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      label: "Final",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.versionCount).toBe(2);
    expect(body.currentVersion.versionNumber).toBe(2);
    expect(body.currentVersion.label).toBe("Final");
  });

  it("lists all versions newest-first", async () => {
    const res = await api("GET", `/documents/${docId}/versions`, orgToken);
    expect(res.status).toBe(200);
    const { versions } = await res.json();
    expect(versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
  });

  it("still serves the ORIGINAL v1 bytes (immutable history)", async () => {
    const res = await api("GET", `/documents/${docId}/versions/${v1Id}/download`, orgToken);
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(await (await fetch(url)).text()).toBe(v1Content);
  });

  it("serves the current v2 bytes via the default download", async () => {
    const res = await api("GET", `/documents/${docId}/download`, orgToken);
    const { url } = await res.json();
    expect(await (await fetch(url)).text()).toBe(v2Content);
  });

  it("assigns unique monotonic version numbers under concurrent uploads", async () => {
    // Fire 5 add-version requests in parallel at the same document. The unique
    // (document_id, version_number) constraint + repo retry must yield 5 distinct
    // consecutive numbers with no collision/500 and a coherent currentVersionId.
    const files = await Promise.all(
      Array.from({ length: 5 }, (_, i) => uploadFile(orgToken, `concurrent ${i}`, { fileName: `c${i}.txt` })),
    );
    const results = await Promise.all(
      files.map((f) =>
        api("POST", `/documents/${docId}/versions`, orgToken, {
          objectPath: f.objectPath,
          fileName: f.fileName,
          fileSize: f.fileSize,
          mimeType: f.mimeType,
        }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const listRes = await api("GET", `/documents/${docId}/versions`, orgToken);
    const { versions } = await listRes.json();
    const numbers = versions.map((v: { versionNumber: number }) => v.versionNumber).sort((a: number, b: number) => a - b);
    // 2 pre-existing (v1, v2) + 5 concurrent = 7 unique consecutive numbers.
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(numbers).size).toBe(numbers.length);

    const docRes = await api("GET", `/documents/${docId}`, orgToken);
    const doc = await docRes.json();
    expect(doc.currentVersion.versionNumber).toBe(7);
  });
});

describe("Documents — rename & move", () => {
  let docId = 0;

  beforeAll(async () => {
    const file = await uploadFile(orgToken, "movable");
    const res = await api("POST", "/documents", orgToken, {
      entityType: "contact",
      entityId: contactId,
      category: "Business Card",
      name: "Card",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    docId = (await res.json()).id;
  });

  it("renames a document", async () => {
    const res = await api("PATCH", `/documents/${docId}`, orgToken, { name: "Renamed Card" });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Renamed Card");
  });

  it("rejects an empty name (400)", async () => {
    const res = await api("PATCH", `/documents/${docId}`, orgToken, { name: "   " });
    expect(res.status).toBe(400);
  });

  it("moves a document to another entity + valid destination category", async () => {
    const res = await api("PATCH", `/documents/${docId}`, orgToken, {
      entityType: "company",
      entityId: companyId,
      category: "Company Profile",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entityType).toBe("company");
    expect(body.entityId).toBe(companyId);
    expect(body.category).toBe("Company Profile");
  });

  it("rejects a move whose category is invalid for the destination (400)", async () => {
    const res = await api("PATCH", `/documents/${docId}`, orgToken, {
      entityType: "event",
      entityId: eventId,
      category: "Company Profile", // not valid for event
    });
    expect(res.status).toBe(400);
  });
});

describe("Documents — search & filters", () => {
  const tag = `srch${SUFFIX}`;
  beforeAll(async () => {
    const f1 = await uploadFile(orgToken, "alpha", { fileName: `${tag}-alpha.pdf`, mimeType: "application/pdf" });
    await api("POST", "/documents", orgToken, {
      entityType: "lead",
      entityId: leadId,
      category: "Proposal",
      name: `Proposal ${tag}`,
      objectPath: f1.objectPath,
      fileName: f1.fileName,
      fileSize: f1.fileSize,
      mimeType: f1.mimeType,
    });
    const f2 = await uploadFile(orgToken, "beta", { fileName: `${tag}-beta.txt` });
    await api("POST", "/documents", orgToken, {
      entityType: "event",
      entityId: eventId,
      category: "Images",
      name: `Event Shot ${tag}`,
      objectPath: f2.objectPath,
      fileName: f2.fileName,
      fileSize: f2.fileSize,
      mimeType: f2.mimeType,
    });
  });

  it("free-text search matches document name", async () => {
    const res = await api("GET", `/documents?q=Proposal%20${tag}`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents.length).toBeGreaterThanOrEqual(1);
    expect(body.documents.every((d: { name: string }) => d.name.includes(tag))).toBe(true);
  });

  it("filters by entityType + entityId", async () => {
    const res = await api("GET", `/documents?entityType=event&entityId=${eventId}`, orgToken);
    const body = await res.json();
    expect(body.documents.length).toBeGreaterThanOrEqual(1);
    expect(body.documents.every((d: { entityType: string; entityId: number }) => d.entityType === "event" && d.entityId === eventId)).toBe(true);
  });

  it("filters by category", async () => {
    const res = await api("GET", `/documents?category=Proposal`, orgToken);
    const body = await res.json();
    expect(body.documents.every((d: { category: string }) => d.category === "Proposal")).toBe(true);
  });

  it("filters by MIME type", async () => {
    const res = await api("GET", `/documents?mimeType=application/pdf`, orgToken);
    const body = await res.json();
    expect(body.documents.length).toBeGreaterThanOrEqual(1);
    expect(body.documents.every((d: { currentVersion: { mimeType: string } | null }) => d.currentVersion?.mimeType === "application/pdf")).toBe(true);
  });
});

describe("Documents — soft delete & restore", () => {
  let docId = 0;

  beforeAll(async () => {
    const file = await uploadFile(orgToken, "deletable");
    const res = await api("POST", "/documents", orgToken, {
      entityType: "contact",
      entityId: contactId,
      category: "Other Attachments",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    docId = (await res.json()).id;
  });

  it("soft-deletes and hides the document from the default list", async () => {
    const del = await api("DELETE", `/documents/${docId}`, orgToken);
    expect(del.status).toBe(200);

    const list = await api("GET", `/documents?entityType=contact&entityId=${contactId}`, orgToken);
    const body = await list.json();
    expect(body.documents.some((d: { id: number }) => d.id === docId)).toBe(false);

    // Still fetchable via includeDeleted.
    const withDeleted = await api("GET", `/documents?entityType=contact&entityId=${contactId}&includeDeleted=true`, orgToken);
    const wd = await withDeleted.json();
    expect(wd.documents.some((d: { id: number }) => d.id === docId)).toBe(true);
  });

  it("restores the document back into the default list", async () => {
    const restore = await api("POST", `/documents/${docId}/restore`, orgToken);
    expect(restore.status).toBe(200);
    expect((await restore.json()).deletedAt).toBeNull();

    const list = await api("GET", `/documents?entityType=contact&entityId=${contactId}`, orgToken);
    const body = await list.json();
    expect(body.documents.some((d: { id: number }) => d.id === docId)).toBe(true);
  });

  it("rejects restoring a document that is not deleted (400)", async () => {
    const res = await api("POST", `/documents/${docId}/restore`, orgToken);
    expect(res.status).toBe(400);
  });
});

describe("Documents — RBAC (permission-gated writes)", () => {
  it("blocks an employee without documents.create from requesting an upload URL (403)", async () => {
    const res = await api("POST", "/documents/upload-url", empToken, { fileName: "x.txt", contentType: "text/plain", size: 4 });
    expect(res.status).toBe(403);
  });

  it("blocks an employee without documents.create from creating a document (403)", async () => {
    const res = await api("POST", "/documents", empToken, {
      entityType: "lead",
      entityId: leadId,
      category: "Quotation",
      objectPath: "/objects/uploads/whatever",
      fileName: "x.txt",
      fileSize: 4,
      mimeType: "text/plain",
    });
    expect(res.status).toBe(403);
  });

  it("allows an employee to read documents (open tenant-scoped reads)", async () => {
    const res = await api("GET", "/documents", empToken);
    expect(res.status).toBe(200);
  });

  it("grants documents permissions via a custom role, then allows create", async () => {
    const role = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Doc Manager ${SUFFIX}`,
      permissions: [
        { module: "documents", action: "view" },
        { module: "documents", action: "create" },
      ],
    });
    expect(role.status).toBe(201);
    const roleId = (await role.json()).id;
    expect((await api("PUT", `/users/${empId}/roles`, orgToken, { roleIds: [roleId] })).status).toBe(200);

    const grantedToken = (await login({ email: EMP_EMAIL, password: PW })).token;
    const file = await uploadFile(grantedToken, "granted");
    const res = await api("POST", "/documents", grantedToken, {
      entityType: "lead",
      entityId: leadId,
      category: "Quotation",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    expect(res.status).toBe(201);

    // Revoke so teardown and other assertions stay clean.
    await api("PUT", `/users/${empId}/roles`, orgToken, { roleIds: [] });
  });
});

describe("Documents — tenant isolation (cross-tenant 404)", () => {
  let docId = 0;

  beforeAll(async () => {
    const file = await uploadFile(orgToken, "isolated");
    const res = await api("POST", "/documents", orgToken, {
      entityType: "lead",
      entityId: leadId,
      category: "Quotation",
      objectPath: file.objectPath,
      fileName: file.fileName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
    });
    docId = (await res.json()).id;
  });

  it("does not leak a document to another tenant", async () => {
    expect((await api("GET", `/documents/${docId}`, foreignToken)).status).toBe(404);
    expect((await api("GET", `/documents/${docId}/download`, foreignToken)).status).toBe(404);
    expect((await api("PATCH", `/documents/${docId}`, foreignToken, { name: "hijack" })).status).toBe(404);
    expect((await api("DELETE", `/documents/${docId}`, foreignToken)).status).toBe(404);
    expect((await api("POST", `/documents/${docId}/versions`, foreignToken, {
      objectPath: "/objects/uploads/x",
      fileName: "x.txt",
      fileSize: 4,
      mimeType: "text/plain",
    })).status).toBe(404);
  });

  it("does not list another tenant's documents", async () => {
    const res = await api("GET", `/documents?entityType=lead&entityId=${leadId}`, foreignToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents.some((d: { id: number }) => d.id === docId)).toBe(false);
  });
});

describe("Documents — platform_owner privacy firewall (403)", () => {
  const GET_PATHS = ["/documents", "/documents/categories", "/documents/1", "/documents/1/versions", "/documents/1/download"];
  it.each(GET_PATHS)("GET %s is blocked for platform_owner", async (path) => {
    const res = await api("GET", path, platformToken);
    expect(res.status).toBe(403);
  });

  it("POST /documents/upload-url is blocked for platform_owner", async () => {
    const res = await api("POST", "/documents/upload-url", platformToken, { fileName: "x.txt", contentType: "text/plain", size: 4 });
    expect(res.status).toBe(403);
  });

  it("POST /documents is blocked for platform_owner", async () => {
    const res = await api("POST", "/documents", platformToken, {
      entityType: "company",
      entityId: companyId,
      category: "Company Profile",
      objectPath: "/objects/uploads/x",
      fileName: "x.txt",
      fileSize: 4,
      mimeType: "text/plain",
    });
    expect(res.status).toBe(403);
  });
});
