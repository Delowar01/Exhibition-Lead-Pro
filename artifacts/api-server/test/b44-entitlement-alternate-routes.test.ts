import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, auditLogsTable, plansTable, planVersionsTable, documentsTable, documentVersionsTable, scansTable, organizationsTable, aiConversationsTable, aiMessagesTable, loginAttemptsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";
import { alertEligibleCompanyIds } from "../src/lib/workflow-alerts.js";
import { assertKindEntitled, featureForKind } from "../src/services/storage.service.js";
import { isNfcSource } from "../src/services/contacts.service.js";
import { updateContact } from "../src/services/contacts.service.js";
import { buildPrincipal } from "../src/lib/workflows/principal.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

// Release corrections E1 / E2 / E3 / M4 — a plan feature that an ENFORCED plan
// version denies must not be reachable through a second entry point, and a
// legacy (grandfathered) tenant must keep exactly the access it had.
//
//   E1  documents               — /organizations/:id/documents and the private
//                                 byte routes (/files/:id, /files/uploads/:id)
//   E2  nfc.capture             — the contact create / update path the NFC
//                                 capture flow really uses (no /scans call)
//   E3  workflow / executive    — inside the AI Assistant: intents, suggestions,
//       intelligence              capability flags, and the recurring alert sweep
//   M4  ai.assistant +          — the assistant routes need BOTH (deny wins);
//       ai.command_center         the operator is warned when only one is on
//
// One tenant is moved from a legacy version to an enforced one MID-TEST, so every
// "denied" assertion is made on data the tenant itself created while entitled.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b44alt-${SUFFIX}.test`;
const DENY = `b44-deny-${SUFFIX}`; // enforced: documents, nfc.capture, workflow + executive intelligence OFF; assistant ON
const SPLIT = `b44-split-${SUFFIX}`; // enforced: ai.assistant ON, ai.command_center OFF
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"] as const;
const DENIED = ["documents", "nfc.capture", "workflow.intelligence", "executive.intelligence"] as const;
const CONTACT_DOC_CATEGORY = "Business Card";
const matrix = (off: readonly string[]) => Object.fromEntries(FEATURES.map((k) => [k, !off.includes(k)]));

let platformToken = "";
let dAdmin = ""; // company D primary_admin (legacy first, then enforced-deny)
let dViewer = ""; // company D admin WITHOUT organizations.view (RBAC precedence)
let lAdmin = ""; // company L primary_admin (legacy throughout)
let sAdmin = ""; // company S primary_admin (assistant on, command center off)
let companyD = 0;
let companyL = 0;
let companyS = 0;
const companyIds: number[] = [];
let denyV1 = 0;
let splitV1 = 0;

// Fixtures created while D was still entitled.
let dOrgId = 0;
let dContactId = 0;
let dNfcContactId = 0;
let dDocId = 0;
let dFileUrl = "";
let dPendingUpload: { uploadURL: string; uploadToken: string } | null = null;
let lOrgId = 0;
let lFileUrl = "";
let dHistoryConversation = 0; // workflow + executive answers stored while D was entitled

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
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, res.body.id));
  return res.body.id as number;
}
async function createUser(email: string, role: string, companyId: number) {
  const res = await api("POST", "/users", platformToken, { email, name: email.split("@")[0], role, companyId, password: PW });
  expect(res.status, res.text).toBe(201);
  return res.body.id as number;
}
async function publishPlan(id: string, off: readonly string[]) {
  const created = await api("POST", "/platform/plans", platformToken, {
    id,
    name: `${id}`,
    limits: { contacts: null, events: null, admins: null, employees: null, scans: null, storageMb: null },
    features: matrix(off),
    featureEnforcement: "enforced",
    trialPolicy: { trialDays: 14, eligible: true, oncePerCompany: true, endOutcome: "blocked", readOnlyGraceDays: 0 },
  });
  expect(created.status, created.text).toBe(201);
  const versionId = created.body.draft.id as number;
  const published = await api("POST", `/platform/plans/${id}/versions/${versionId}/publish`, platformToken);
  expect(published.status, published.text).toBe(200);
  return versionId;
}
async function reserveUpload(token: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  const res = await api("POST", "/documents/upload-url", token, { fileName: "note.txt", contentType: "text/plain", size: bytes.byteLength });
  expect(res.status, res.text).toBe(200);
  return { ...(res.body as { uploadURL: string; uploadToken: string; objectPath: string }), bytes };
}
const putBytes = (token: string, target: { uploadURL: string; uploadToken: string }, bytes: Buffer) =>
  fetch(target.uploadURL, { method: "PUT", headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}`, "X-Storage-Capability": target.uploadToken }, body: bytes });
async function uploadDocument(token: string, contactId: number, content: string) {
  const target = await reserveUpload(token, content);
  const put = await putBytes(token, target, target.bytes);
  expect(put.status, await put.text()).toBe(200);
  const doc = await api("POST", "/documents", token, { entityType: "contact", entityId: contactId, category: CONTACT_DOC_CATEGORY, name: `Quote ${SUFFIX}`, label: "V1", objectPath: target.objectPath, fileName: "note.txt", fileSize: target.bytes.byteLength, mimeType: "text/plain" });
  expect(doc.status, doc.text).toBe(201);
  const dl = await api("GET", `/documents/${doc.body.id}/download`, token);
  expect(dl.status, dl.text).toBe(200);
  return { docId: doc.body.id as number, url: dl.body.url as string };
}
const getBytes = (url: string, token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const expectFeatureDenied = (res: { status: number; body: any; text: string }, feature: string, planVersionId: number) => {
  expect(res.status, res.text).toBe(403);
  expect(res.body.code).toBe("FEATURE_NOT_ENTITLED");
  expect(res.body.context).toEqual({ feature, planVersionId, enforcement: "enforced" });
};
async function ask(token: string, content: string) {
  const conv = await api("POST", "/ai/assistant/conversations", token, {});
  expect(conv.status, conv.text).toBe(201);
  const res = await api("POST", `/ai/assistant/conversations/${conv.body.id}/messages`, token, { content });
  expect(res.status, res.text).toBe(200);
  return res.body.assistantMessage as { content: string; intent: string; data: Record<string, any>; evidence: unknown[]; suggestedActions: Array<{ target: string }>; source: string };
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  denyV1 = await publishPlan(DENY, DENIED);
  splitV1 = await publishPlan(SPLIT, ["ai.command_center"]);

  companyD = await createCompany(`QA B44 Deny ${SUFFIX}`, "free");
  companyL = await createCompany(`QA B44 Legacy ${SUFFIX}`, "free");
  companyS = await createCompany(`QA B44 Split ${SUFFIX}`, SPLIT);
  await createUser(`d-admin@${DOMAIN}`, "primary_admin", companyD);
  const viewerId = await createUser(`d-viewer@${DOMAIN}`, "admin", companyD);
  await db.update(usersTable).set({ permissions: { contacts: ["view", "create", "edit"], documents: ["view"] } }).where(eq(usersTable.id, viewerId));
  await createUser(`l-admin@${DOMAIN}`, "primary_admin", companyL);
  await createUser(`s-admin@${DOMAIN}`, "primary_admin", companyS);
  dAdmin = await login(`d-admin@${DOMAIN}`);
  dViewer = await login(`d-viewer@${DOMAIN}`);
  lAdmin = await login(`l-admin@${DOMAIN}`);
  sAdmin = await login(`s-admin@${DOMAIN}`);

  // ── While company D is still LEGACY (every feature allowed) it builds real data. ──
  for (const [token, set] of [
    [dAdmin, (orgId: number, contactId: number, url: string, docId: number) => ((dOrgId = orgId), (dContactId = contactId), (dFileUrl = url), (dDocId = docId))],
    [lAdmin, (orgId: number, _c: number, url: string) => ((lOrgId = orgId), (lFileUrl = url))],
  ] as const) {
    const org = await api("POST", "/organizations", token, { name: `Org ${SUFFIX}-${token === dAdmin ? "d" : "l"}` });
    expect(org.status, org.text).toBe(201);
    const contact = await api("POST", "/contacts", token, { firstName: "Doc", lastName: `Owner ${SUFFIX}`, organizationId: org.body.id });
    expect(contact.status, contact.text).toBe(201);
    const { docId, url } = await uploadDocument(token, contact.body.id, `bytes of ${SUFFIX}`);
    set(org.body.id, contact.body.id, url, docId);
  }
  // An upload target reserved (not yet used) while entitled.
  const pending = await reserveUpload(dAdmin, "late bytes");
  dPendingUpload = { uploadURL: pending.uploadURL, uploadToken: pending.uploadToken };
  // An NFC contact captured while entitled.
  const nfc = await api("POST", "/contacts", dAdmin, { firstName: "Tapped", lastName: `Before ${SUFFIX}`, source: "nfc" });
  expect(nfc.status, nfc.text).toBe(201);
  dNfcContactId = nfc.body.id;

  // Answers the assistant stored for D while it still had both engines.
  const conv = await api("POST", "/ai/assistant/conversations", dAdmin, {});
  expect(conv.status, conv.text).toBe(201);
  dHistoryConversation = conv.body.id;
  for (const q of ["What are my priorities today?", "Give me an executive summary", "Show contacts"]) {
    const sent = await api("POST", `/ai/assistant/conversations/${dHistoryConversation}/messages`, dAdmin, { content: q });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body.assistantMessage.data.featureDenied).toBeUndefined();
  }

  // ── The Platform Owner now moves company D onto the ENFORCED version. ──
  const assign = await api("POST", `/platform/subscriptions/${companyD}/plan`, platformToken, { plan: DENY, confirmFeatureDowngrade: true });
  expect(assign.status, assign.text).toBe(200);
  expect(assign.body.planVersionId).toBe(denyV1);
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* best-effort teardown on a disposable database */
    }
  };
  if (companyIds.length) {
    await quiet(() => db.delete(aiConversationsTable).where(inArray(aiConversationsTable.companyId, companyIds)));
    await quiet(() => db.delete(documentVersionsTable).where(inArray(documentVersionsTable.companyId, companyIds)));
    await quiet(() => db.delete(documentsTable).where(inArray(documentsTable.companyId, companyIds)));
    await quiet(() => db.delete(scansTable).where(inArray(scansTable.companyId, companyIds)));
    await quiet(() => db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds)));
    await quiet(() => db.delete(organizationsTable).where(inArray(organizationsTable.companyId, companyIds)));
    await quiet(() => db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds)));
    await quiet(() => db.delete(usersTable).where(inArray(usersTable.companyId, companyIds)));
    await quiet(() => db.delete(companiesTable).where(inArray(companiesTable.id, companyIds)));
  }
  await quiet(() => db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`)));
  await quiet(() => db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`)));
  await quiet(() => db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [DENY, SPLIT])));
  await quiet(() => db.delete(plansTable).where(inArray(plansTable.id, [DENY, SPLIT])));
});

describe("E1 — documents cannot be read or written through another route", () => {
  it("the tenant's entitlements now deny exactly the four features", async () => {
    const me = (await api("GET", "/auth/me", dAdmin)).body;
    expect(me.entitlements.featureEnforcement).toBe("enforced");
    expect(me.entitlements.planVersionId).toBe(denyV1);
    for (const k of FEATURES) expect(me.entitlements.features[k], k).toBe(!(DENIED as readonly string[]).includes(k));
  });

  it("the module itself is denied (existing gate) — and so is the organization's document list", async () => {
    expectFeatureDenied(await api("GET", "/documents", dAdmin), "documents", denyV1);
    expectFeatureDenied(await api("GET", `/documents/${dDocId}/download`, dAdmin), "documents", denyV1);
    expectFeatureDenied(await api("GET", `/organizations/${dOrgId}/documents`, dAdmin), "documents", denyV1);
  });

  it("the rest of the organization workspace stays available (only the document read is gated)", async () => {
    for (const path of [`/organizations/${dOrgId}`, `/organizations/${dOrgId}/contacts`, `/organizations/${dOrgId}/leads`, `/organizations/${dOrgId}/timeline`, "/organizations"]) {
      const res = await api("GET", path, dAdmin);
      expect(res.status, `${path}: ${res.text}`).toBe(200);
    }
  });

  it("the bytes of a document uploaded while entitled are no longer served by the private file route", async () => {
    const res = await getBytes(dFileUrl, dAdmin);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEATURE_NOT_ENTITLED");
    expect(body.context).toEqual({ feature: "documents", planVersionId: denyV1, enforcement: "enforced" });
    expect(JSON.stringify(body)).not.toContain(`bytes of ${SUFFIX}`);
    const head = await fetch(dFileUrl, { method: "HEAD", headers: { Authorization: `Bearer ${dAdmin}` } });
    expect(head.status).toBe(403);
  });

  it("an upload target reserved before the plan change is not honoured afterwards", async () => {
    const put = await putBytes(dAdmin, dPendingUpload!, Buffer.from("late bytes", "utf8"));
    expect(put.status).toBe(403);
    expect(((await put.json()) as any).code).toBe("FEATURE_NOT_ENTITLED");
    // ...and a new target cannot be reserved at all.
    expectFeatureDenied(await api("POST", "/documents/upload-url", dAdmin, { fileName: "x.txt", contentType: "text/plain", size: 4 }), "documents", denyV1);
  });

  it("RBAC keeps precedence: a user without organizations.view gets the permission denial, not the entitlement one", async () => {
    const res = await api("GET", `/organizations/${dOrgId}/documents`, dViewer);
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe("FEATURE_NOT_ENTITLED");
  });

  it("tenant isolation keeps precedence: a foreign tenant's file is 404 (never 403), whatever either tenant's plan says", async () => {
    expect((await getBytes(dFileUrl, lAdmin)).status).toBe(404); // entitled tenant, foreign object
    expect((await getBytes(lFileUrl, dAdmin)).status).toBe(404); // denied tenant, foreign object: still no existence disclosure
    expect((await api("GET", `/organizations/${dOrgId}/documents`, lAdmin)).status).toBe(404);
  });

  it("LEGACY tenant: every one of those routes still works exactly as before", async () => {
    const list = await api("GET", `/organizations/${lOrgId}/documents`, lAdmin);
    expect(list.status, list.text).toBe(200);
    expect(Array.isArray(list.body) ? list.body.length : (list.body.data ?? list.body.documents ?? []).length).toBeGreaterThan(0);
    const bytes = await getBytes(lFileUrl, lAdmin);
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe(`bytes of ${SUFFIX}`);
    const target = await reserveUpload(lAdmin, "legacy late bytes");
    expect((await putBytes(lAdmin, target, target.bytes)).status).toBe(200);
  });

  it("the byte route maps each object kind to the feature that owns it (documents, executive reports); other kinds are not plan-gated", () => {
    expect(featureForKind("document")).toBe("documents");
    expect(featureForKind("report")).toBe("executive.intelligence");
    for (const kind of ["export", "scan_image", "branding_logo"] as const) expect(featureForKind(kind), kind).toBeNull();
    const user = (features: Record<string, boolean>, enforcement: string) => ({ role: "primary_admin", companyId: 1, entitlements: { planVersionId: 7, featureEnforcement: enforcement, features } }) as unknown as AuthUser;
    const allOn = Object.fromEntries(FEATURES.map((k) => [k, true]));
    expect(() => assertKindEntitled(user(allOn, "legacy"), "report")).not.toThrow();
    expect(() => assertKindEntitled(user({ ...allOn, "executive.intelligence": false }, "enforced"), "report")).toThrowError(/Executive Intelligence is not included/);
    expect(() => assertKindEntitled(user({ ...allOn, documents: false }, "enforced"), "document")).toThrowError(/Documents is not included/);
    // a denied feature never blocks an object kind it does not own
    expect(() => assertKindEntitled(user({ ...allOn, documents: false, "executive.intelligence": false }, "enforced"), "scan_image")).not.toThrow();
    expect(() => assertKindEntitled(user({ ...allOn, documents: false, "executive.intelligence": false }, "enforced"), "export")).not.toThrow();
  });
});

describe("E2 — NFC capture is enforced on the contact path it really uses", () => {
  const countContacts = async () => (await db.select({ id: contactsTable.id }).from(contactsTable).where(eq(contactsTable.companyId, companyD))).length;

  it("a contact declared as an NFC capture is refused before anything is written (any spelling of the source)", async () => {
    const before = await countContacts();
    for (const source of ["nfc", "NFC", "  Nfc  "]) {
      expectFeatureDenied(await api("POST", "/contacts", dAdmin, { firstName: "Tapped", lastName: `After ${SUFFIX}`, source }), "nfc.capture", denyV1);
    }
    // the explicit duplicate resolutions of the same capture are refused too
    expectFeatureDenied(await api("POST", "/contacts", dAdmin, { firstName: "Tapped", source: "nfc", dedupeResolution: "add_interaction", matchedContactId: dContactId }), "nfc.capture", denyV1);
    expectFeatureDenied(await api("POST", "/contacts", dAdmin, { firstName: "Tapped", source: "nfc", dedupeResolution: "create_separate" }), "nfc.capture", denyV1);
    expect(await countContacts()).toBe(before);
  });

  it("ordinary manual contact creation — and every other capture source — is NOT blocked", async () => {
    for (const body of [
      { firstName: "Manual", lastName: `One ${SUFFIX}` },
      { firstName: "Manual", lastName: `Two ${SUFFIX}`, source: "manual" },
      { firstName: "Manual", lastName: `Three ${SUFFIX}`, source: null },
      { firstName: "Qr", lastName: `Four ${SUFFIX}`, source: "qr" },
      { firstName: "Sig", lastName: `Five ${SUFFIX}`, source: "signature" },
      { firstName: "Show", lastName: `Six ${SUFFIX}`, source: "Trade show: NFC Forum" }, // a free-text lead source merely mentioning the word
    ]) {
      const res = await api("POST", "/contacts", dAdmin, body);
      expect(res.status, `${JSON.stringify(body)}: ${res.text}`).toBe(201);
    }
  });

  it("an existing contact cannot be re-labelled as an NFC capture, while ordinary edits keep working", async () => {
    expectFeatureDenied(await api("PATCH", `/contacts/${dContactId}`, dAdmin, { source: "nfc" }), "nfc.capture", denyV1);
    const edit = await api("PATCH", `/contacts/${dContactId}`, dAdmin, { notes: `edited ${SUFFIX}` });
    expect(edit.status, edit.text).toBe(200);
    const [row] = await db.select().from(contactsTable).where(eq(contactsTable.id, dContactId));
    expect(row.source).toBeNull();
  });

  it("a contact captured by NFC while the tenant was entitled stays fully editable (an edit is not a new capture)", async () => {
    const edit = await api("PATCH", `/contacts/${dNfcContactId}`, dAdmin, { notes: `kept ${SUFFIX}`, source: "nfc" });
    expect(edit.status, edit.text).toBe(200);
    expect((await api("GET", `/contacts/${dNfcContactId}`, dAdmin)).status).toBe(200);
  });

  it("the scan route keeps its own NFC gate, and camera capture stays ungated", async () => {
    expectFeatureDenied(await api("POST", "/scans", dAdmin, { imageData: "not-an-image", captureSource: "nfc" }), "nfc.capture", denyV1);
    const camera = await api("POST", "/scans", dAdmin, { imageData: "not-an-image", captureSource: "camera" });
    expect(camera.status).toBe(400);
    expect(camera.body.code).not.toBe("FEATURE_NOT_ENTITLED");
  });

  it("LEGACY tenant: an NFC capture saves exactly as before and is recorded as an NFC interaction that consumes no scan quota", async () => {
    const scansUsed = async () => ((await api("GET", "/subscriptions/usage", lAdmin)).body.resources as Array<{ resource: string; used: number }>).find((r) => r.resource === "scans")!.used;
    const usedBefore = await scansUsed();
    const res = await api("POST", "/contacts", lAdmin, { firstName: "Legacy", lastName: `Tap ${SUFFIX}`, source: "nfc" });
    expect(res.status, res.text).toBe(201);
    let rows: Array<{ captureSource: string | null; extractionMethod: string | null }> = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      rows = await db.select({ captureSource: scansTable.captureSource, extractionMethod: scansTable.extractionMethod }).from(scansTable).where(and(eq(scansTable.companyId, companyL), eq(scansTable.contactId, res.body.id)));
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows).toEqual([{ captureSource: "nfc", extractionMethod: "manual" }]);
    expect(await scansUsed()).toBe(usedBefore); // the interaction record is not an OCR scan
    const relabel = await api("PATCH", `/contacts/${res.body.id}`, lAdmin, { source: "nfc", notes: "ok" });
    expect(relabel.status, relabel.text).toBe(200);
  });

  it("a workflow automation (background principal without request entitlements) follows the TENANT's plan: legacy keeps working, a denied tenant is refused", async () => {
    // legacy tenant: an automation that sets source = nfc on a contact keeps succeeding
    const legacyContact = await api("POST", "/contacts", lAdmin, { firstName: "Auto", lastName: `Legacy ${SUFFIX}` });
    expect(legacyContact.status, legacyContact.text).toBe(201);
    const legacyPrincipal = await buildPrincipal(companyL, null);
    expect(legacyPrincipal.entitlements).toBeNull();
    const updated = await updateContact(legacyPrincipal, legacyContact.body.id, { source: "nfc" });
    expect(updated.source).toBe("nfc");
    // denied tenant: the same automation is refused with the feature denial, and nothing is written
    const deniedPrincipal = await buildPrincipal(companyD, null);
    await expect(updateContact(deniedPrincipal, dContactId, { source: "nfc" })).rejects.toMatchObject({ statusCode: 403, code: "FEATURE_NOT_ENTITLED" });
    const [row] = await db.select().from(contactsTable).where(eq(contactsTable.id, dContactId));
    expect(row.source).toBeNull();
    // ...while an automation that edits anything else is untouched
    await expect(updateContact(deniedPrincipal, dContactId, { notes: `automation ${SUFFIX}` })).resolves.toBeTruthy();
  });

  it("the source test is exact: only the NFC capture mode is gated", () => {
    for (const v of ["nfc", "NFC", " nfc ", "Nfc"]) expect(isNfcSource(v), JSON.stringify(v)).toBe(true);
    for (const v of [null, undefined, "", "manual", "qr", "card", "nfc-forum", "nfc import", 1, {}]) expect(isNfcSource(v), JSON.stringify(v)).toBe(false);
  });
});

describe("E3 — Workflow and Executive Intelligence cannot be reached through the AI Assistant", () => {
  const WORKFLOW_ASKS = ["What are my priorities today?", "Show opportunities at risk", "Where are the bottlenecks in our pipeline?", "How is the team workload?"];
  const EXECUTIVE_ASKS = ["Give me an executive summary", "Show me the revenue forecast"];

  it("the assistant itself stays available to the tenant (its own features are on)", async () => {
    expect((await api("GET", "/ai/assistant/conversations", dAdmin)).status).toBe(200);
    // ...while the direct module routes are denied, as before.
    expectFeatureDenied(await api("GET", "/ai/workflow/overview", dAdmin), "workflow.intelligence", denyV1);
    expectFeatureDenied(await api("GET", "/ai/executive/dashboard", dAdmin), "executive.intelligence", denyV1);
  });

  it("every workflow intent answers with the plan denial and carries no workflow data", async () => {
    for (const q of WORKFLOW_ASKS) {
      const m = await ask(dAdmin, q);
      expect(m.data, q).toEqual({ featureDenied: "workflow.intelligence", code: "FEATURE_NOT_ENTITLED" });
      expect(m.content, q).toContain("Workflow Intelligence is not included in your organization's plan");
      expect(m.evidence, q).toEqual([]);
      expect(m.suggestedActions, q).toEqual([]);
      expect(m.source, q).toBe("deterministic"); // never LLM-phrased
    }
  });

  it("every executive intent answers with the plan denial and carries no forecast / summary", async () => {
    for (const q of EXECUTIVE_ASKS) {
      const m = await ask(dAdmin, q);
      expect(m.data, q).toEqual({ featureDenied: "executive.intelligence", code: "FEATURE_NOT_ENTITLED" });
      expect(m.content, q).toContain("Executive Intelligence is not included in your organization's plan");
      expect(m.evidence, q).toEqual([]);
      expect(m.suggestedActions, q).toEqual([]);
      expect(m.source, q).toBe("deterministic");
    }
  });

  it("the denial is localized and intents of features the plan grants keep working", async () => {
    const conv = await api("POST", "/ai/assistant/conversations", dAdmin, {});
    const ar = await api("POST", `/ai/assistant/conversations/${conv.body.id}/messages`, dAdmin, { content: "What are my priorities today?", language: "ar" });
    expect(ar.status, ar.text).toBe(200);
    expect(ar.body.assistantMessage.data).toEqual({ featureDenied: "workflow.intelligence", code: "FEATURE_NOT_ENTITLED" });
    const search = await ask(dAdmin, "Show contacts");
    expect(search.data.featureDenied).toBeUndefined();
    expect(Array.isArray(search.data.contacts)).toBe(true);
  });

  it("suggestions, capability flags and the help overview no longer offer the denied engines", async () => {
    const s = (await api("GET", "/ai/assistant/suggestions", dAdmin)).body;
    const prompts = (s.prompts as Array<{ prompt: string }>).map((p) => p.prompt);
    for (const q of ["What are my priorities today?", "Show opportunities at risk", "Where are the bottlenecks in our pipeline?", "Give me an executive summary", "Show me the revenue forecast"]) expect(prompts, q).not.toContain(q);
    expect(prompts).toContain('Show contacts from "..."'); // an ungated suggestion is still there
    expect(s.modules.workflow).toBe(false);
    expect(s.modules.executive).toBe(false);
    expect(s.modules.insights).toBe(true);
    expect(s.modules.copilot).toBe(true);
    const help = await ask(dAdmin, "hello there");
    expect(help.intent).toBe("help");
    expect(JSON.stringify(help.data.capabilities)).not.toMatch(/priorities|Executive summaries/);
    expect(help.suggestedActions).toEqual([]); // both quick prompts are workflow prompts
  });

  it("answers stored while the tenant was entitled are no longer served from the conversation history or the recent-activity list", async () => {
    const conv = await api("GET", `/ai/assistant/conversations/${dHistoryConversation}`, dAdmin);
    expect(conv.status, conv.text).toBe(200);
    const answers = (conv.body.messages as Array<{ role: string; intent: string; content: string; data: Record<string, any>; evidence: unknown[]; suggestedActions: unknown[] }>).filter((m) => m.role === "assistant");
    expect(answers.map((m) => m.intent)).toEqual(["priorities", "executive_summary", "search_contacts"]);
    expect(answers[0].data).toEqual({ featureDenied: "workflow.intelligence", code: "FEATURE_NOT_ENTITLED" });
    expect(answers[0].content).toBe("Workflow Intelligence is not included in your organization's plan.");
    expect(answers[1].data).toEqual({ featureDenied: "executive.intelligence", code: "FEATURE_NOT_ENTITLED" });
    expect(answers[1].content).toBe("Executive Intelligence is not included in your organization's plan.");
    for (const m of answers.slice(0, 2)) expect([m.evidence, m.suggestedActions]).toEqual([[], []]);
    // an answer of a feature the plan still grants is served unchanged, and the user's own questions stay readable
    expect(Array.isArray(answers[2].data.contacts)).toBe(true);
    expect((conv.body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["What are my priorities today?", "Give me an executive summary", "Show contacts"]);
    const recent = (await api("GET", "/ai/assistant/suggestions", dAdmin)).body.recentActivity as Array<{ intent: string; content: string }>;
    for (const r of recent.filter((x) => ["priorities", "risks", "bottlenecks", "workload"].includes(x.intent))) expect(r.content).toBe("Workflow Intelligence is not included in your organization's plan.");
    for (const r of recent.filter((x) => ["forecast", "executive_summary"].includes(x.intent))) expect(r.content).toBe("Executive Intelligence is not included in your organization's plan.");
    // the stored rows themselves are untouched (nothing is deleted or rewritten)
    const stored = await db.select().from(aiMessagesTable).where(eq(aiMessagesTable.conversationId, dHistoryConversation));
    expect(stored.filter((m) => m.role === "assistant" && m.intent === "priorities")[0].data).not.toHaveProperty("featureDenied");
  });

  it("the recurring workflow alert sweep skips the denied tenant and keeps the legacy one", async () => {
    const eligible = await alertEligibleCompanyIds();
    expect(eligible).not.toContain(companyD);
    expect(eligible).toContain(companyL);
  });

  it("LEGACY tenant: the same questions are answered from real data and every suggestion is offered", async () => {
    const priorities = await ask(lAdmin, "What are my priorities today?");
    expect(priorities.data.featureDenied).toBeUndefined();
    expect(Array.isArray(priorities.data.risks)).toBe(true);
    const summary = await ask(lAdmin, "Give me an executive summary");
    expect(summary.data.featureDenied).toBeUndefined();
    expect(summary.data.summary).toBeTruthy();
    const s = (await api("GET", "/ai/assistant/suggestions", lAdmin)).body;
    const prompts = (s.prompts as Array<{ prompt: string }>).map((p) => p.prompt);
    expect(prompts).toEqual(expect.arrayContaining(["What are my priorities today?", "Give me an executive summary", "Show me the revenue forecast"]));
    expect(s.modules).toMatchObject({ workflow: true, executive: true, insights: true, copilot: true });
    const help = await ask(lAdmin, "hello there");
    expect(help.suggestedActions.map((a) => a.target)).toEqual(["What are my priorities today?", "Show opportunities at risk"]);
  });
});

describe("M4 — the assistant routes need BOTH ai.assistant and ai.command_center", () => {
  it("a version that grants only one of the two denies the assistant routes, naming the missing feature (deny wins, RBAC untouched)", async () => {
    const me = (await api("GET", "/auth/me", sAdmin)).body;
    expect(me.entitlements.features["ai.assistant"]).toBe(true);
    expect(me.entitlements.features["ai.command_center"]).toBe(false);
    for (const [method, path] of [
      ["GET", "/ai/assistant/conversations"],
      ["GET", "/ai/assistant/suggestions"],
      ["POST", "/ai/assistant/conversations"],
    ] as const) {
      expectFeatureDenied(await api(method, path, sAdmin, method === "POST" ? {} : undefined), "ai.command_center", splitV1);
    }
  });

  it("the operator is warned at validation when exactly one of the two is enabled — and not when they agree", async () => {
    const draft = await api("POST", `/platform/plans/${SPLIT}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    const id = draft.body.id as number;
    const codes = async () => ((await api("POST", `/platform/plans/${SPLIT}/versions/${id}/validate`, platformToken)).body.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(await codes()).toContain("ASSISTANT_FEATURES_COUPLED");
    const both = await api("PATCH", `/platform/plans/${SPLIT}/versions/${id}`, platformToken, { features: matrix([]) });
    expect(both.status, both.text).toBe(200);
    expect(await codes()).not.toContain("ASSISTANT_FEATURES_COUPLED");
    const neither = await api("PATCH", `/platform/plans/${SPLIT}/versions/${id}`, platformToken, { features: matrix(["ai.assistant", "ai.command_center"]) });
    expect(neither.status, neither.text).toBe(200);
    expect(await codes()).not.toContain("ASSISTANT_FEATURES_COUPLED");
    // recorded-only (legacy) flags never trigger it: nothing is enforced
    const legacy = await api("PATCH", `/platform/plans/${SPLIT}/versions/${id}`, platformToken, { features: matrix(["ai.assistant"]), featureEnforcement: "legacy" });
    expect(legacy.status, legacy.text).toBe(200);
    expect(await codes()).not.toContain("ASSISTANT_FEATURES_COUPLED");
    expect((await api("DELETE", `/platform/plans/${SPLIT}/versions/${id}`, platformToken)).status).toBe(200);
  });
});
