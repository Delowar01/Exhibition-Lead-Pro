// Batch 11 — Lead Conversion & Opportunity Closure. The Lead IS the sales
// opportunity: open = any stage other than won/lost. This suite proves the
// full lifecycle against the live API: the one-open-opportunity-per-contact
// rule (won and lost both UNBLOCK a new opportunity — the Batch 11 fix),
// Closed Won / Closed Lost transitions with history + system activities,
// reopening with preserved history, open-pipeline math (currency-normalized,
// won/lost excluded, reopen restores), and tenant isolation.
//
// All fixtures live in throwaway tenants torn down in afterAll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  leadActivitiesTable,
  pipelineStagesTable,
  loginAttemptsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `b11qa-${SUFFIX}.test`;
const DOMAIN_B = `b11qab-${SUFFIX}.test`;

let companyId = 0;
let companyBId = 0;
let adminToken = "";
let adminBToken = "";
let contactAId = 0;
let contactBId = 0;
let contactB2Id = 0;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}

async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createLead(token: string, body: Record<string, unknown>) {
  return api("POST", "/leads", token, body);
}

async function setStage(token: string, leadId: number, stage: string) {
  return api("PATCH", `/leads/${leadId}`, token, { stage });
}

async function pipelineTotal(token: string): Promise<{ totalValue: number; stages: any[] }> {
  const res = await api("GET", "/leads/pipeline", token);
  expect(res.status).toBe(200);
  return res.json();
}

async function activities(token: string, leadId: number): Promise<any[]> {
  const res = await api("GET", `/leads/${leadId}/activities`, token);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.activities ?? body;
}

beforeAll(async () => {
  const platformToken = await loginToken(PLATFORM);

  const co = await api("POST", "/companies", platformToken, { name: `B11 QA ${SUFFIX}`, plan: "professional" });
  expect(co.status).toBe(201);
  companyId = (await co.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const adm = await api("POST", "/users", platformToken, { email: `qa-admin@${DOMAIN}`, name: "B11 Admin", role: "primary_admin", password: PW, companyId });
  expect(adm.status).toBe(201);
  adminToken = await loginToken({ email: `qa-admin@${DOMAIN}`, password: PW });

  const coB = await api("POST", "/companies", platformToken, { name: `B11 QA B ${SUFFIX}`, plan: "professional" });
  companyBId = (await coB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  const admB = await api("POST", "/users", platformToken, { email: `qa-admin@${DOMAIN_B}`, name: "B11 Admin B", role: "primary_admin", password: PW, companyId: companyBId });
  expect(admB.status).toBe(201);
  adminBToken = await loginToken({ email: `qa-admin@${DOMAIN_B}`, password: PW });

  const [a, b, b2] = await db
    .insert(contactsTable)
    .values([
      { companyId, fullName: "B11 Contact A", contactCompany: "Acme" },
      { companyId, fullName: "B11 Contact B", contactCompany: "Globex" },
      { companyId: companyBId, fullName: "B11 Contact B2", contactCompany: "Initech" },
    ])
    .returning({ id: contactsTable.id });
  contactAId = a.id;
  contactBId = b.id;
  contactB2Id = b2.id;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(pipelineStagesTable).where(eq(pipelineStagesTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN_B}`));
});

// Lifecycle state threaded through the ordered tests below.
let lead1 = 0; // contact A: open → won → reopened
let lead2 = 0; // contact A: open → lost → reopened
let lead3 = 0; // contact A: stays open
let leadB = 0; // contact B: open, SAR (currency check)

describe("one OPEN opportunity per contact (the Batch 11 rule fix)", () => {
  it("creates an open opportunity", async () => {
    const res = await createLead(adminToken, { contactId: contactAId, stage: "prospect", value: 1000, currency: "USD" });
    expect(res.status).toBe(201);
    lead1 = (await res.json()).id;
  });

  it("blocks a second simultaneous open opportunity (409 with existingId)", async () => {
    const res = await createLead(adminToken, { contactId: contactAId, stage: "prospect", value: 999 });
    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(lead1);
  });

  it("Closed Won: moving to won records history + system activity, keeps everything intact", async () => {
    const res = await setStage(adminToken, lead1, "won");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe("won");
    const stageRow = body.history.find((h: any) => h.fieldName === "stage" && h.newValue === "won");
    expect(stageRow).toBeTruthy();
    expect(stageRow.oldValue).toBe("prospect");
    expect(stageRow.changedBy).toBeTruthy();
    expect(stageRow.changedAt).toBeTruthy();

    const acts = await activities(adminToken, lead1);
    const wonAct = acts.find((a: any) => a.type === "won");
    expect(wonAct).toBeTruthy();
    expect(wonAct.source).toBe("system");

    // Linked contact and the lead itself remain fully available — no duplicate
    // customer/contact record is created by winning.
    expect((await api("GET", `/contacts/${contactAId}`, adminToken)).status).toBe(200);
    expect((await api("GET", `/leads/${lead1}`, adminToken)).status).toBe(200);
    const [{ n }] = await db
      .select({ n: contactsTable.id })
      .from(contactsTable)
      .where(eq(contactsTable.id, contactAId))
      .then((rows) => [{ n: rows.length }]);
    expect(n).toBe(1);
  });

  it("a WON opportunity does not block a new one for the same contact", async () => {
    const res = await createLead(adminToken, { contactId: contactAId, stage: "prospect", value: 2000, currency: "USD" });
    expect(res.status).toBe(201);
    lead2 = (await res.json()).id;
  });

  it("Closed Lost: moving to lost records history + system activity", async () => {
    const res = await setStage(adminToken, lead2, "lost");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe("lost");
    expect(body.history.some((h: any) => h.fieldName === "stage" && h.oldValue === "prospect" && h.newValue === "lost")).toBe(true);
    const acts = await activities(adminToken, lead2);
    expect(acts.some((a: any) => a.type === "lost" && a.source === "system")).toBe(true);
  });

  it("a LOST opportunity does not block a new one either", async () => {
    const res = await createLead(adminToken, { contactId: contactAId, stage: "qualified", value: 3000, currency: "USD" });
    expect(res.status).toBe(201);
    lead3 = (await res.json()).id;
  });

  it("the new open opportunity blocks another simultaneous one again", async () => {
    const res = await createLead(adminToken, { contactId: contactAId, stage: "prospect" });
    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(lead3);
  });
});

describe("open-pipeline math (currency-normalized; won/lost excluded)", () => {
  it("counts only open opportunities, converting currencies to USD", async () => {
    const created = await createLead(adminToken, { contactId: contactBId, stage: "negotiation", value: 7500, currency: "SAR" });
    expect(created.status).toBe(201);
    leadB = (await created.json()).id;

    const { totalValue, stages } = await pipelineTotal(adminToken);
    // Open: lead3 (3000 USD) + leadB (7500 SAR = 2000 USD) = 5000. A naive sum
    // would add 7500; including closed deals would add 1000 + 2000 more.
    expect(totalValue).toBe(5000);

    const wonStage = stages.find((s: any) => s.stage === "won");
    const lostStage = stages.find((s: any) => s.stage === "lost");
    expect(wonStage.leads.map((l: any) => l.id)).toContain(lead1);
    expect(lostStage.leads.map((l: any) => l.id)).toContain(lead2);
  });
});

describe("reopening a closed opportunity", () => {
  it("won → open: transition recorded, previous history preserved", async () => {
    const res = await setStage(adminToken, lead1, "qualified");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe("qualified");
    const stageRows = body.history.filter((h: any) => h.fieldName === "stage");
    expect(stageRows.some((h: any) => h.oldValue === "prospect" && h.newValue === "won")).toBe(true); // preserved
    expect(stageRows.some((h: any) => h.oldValue === "won" && h.newValue === "qualified")).toBe(true); // new

    const acts = await activities(adminToken, lead1);
    expect(acts.some((a: any) => a.type === "won")).toBe(true); // win record kept
    expect(acts.some((a: any) => a.type === "stage_change" && a.metadata?.from === "won" && a.metadata?.to === "qualified")).toBe(true);
  });

  it("lost → open: same guarantees", async () => {
    const res = await setStage(adminToken, lead2, "negotiation");
    expect(res.status).toBe(200);
    const body = await res.json();
    const stageRows = body.history.filter((h: any) => h.fieldName === "stage");
    expect(stageRows.some((h: any) => h.oldValue === "prospect" && h.newValue === "lost")).toBe(true);
    expect(stageRows.some((h: any) => h.oldValue === "lost" && h.newValue === "negotiation")).toBe(true);
    const acts = await activities(adminToken, lead2);
    expect(acts.some((a: any) => a.type === "lost")).toBe(true);
  });

  it("reopened opportunities return to the open pipeline total", async () => {
    const { totalValue } = await pipelineTotal(adminToken);
    // 5000 + reopened lead1 (1000) + reopened lead2 (2000) = 8000.
    expect(totalValue).toBe(8000);
  });
});

describe("tenant isolation for the lifecycle", () => {
  it("cross-tenant lead access and stage changes are refused (404)", async () => {
    expect((await api("GET", `/leads/${lead1}`, adminBToken)).status).toBe(404);
    expect((await setStage(adminBToken, lead1, "won")).status).toBe(404);
  });

  it("cross-tenant contact reference on create is rejected (400)", async () => {
    const res = await createLead(adminBToken, { contactId: contactAId, stage: "prospect" });
    expect(res.status).toBe(400);
  });

  it("cross-tenant stageId reference is rejected (400)", async () => {
    // Ensure tenant B has stages, grab one of THEIR stage ids…
    const stagesB = await api("GET", "/pipeline/stages", adminBToken).then((r) => r.json());
    const foreignStageId = stagesB.stages[0].id;
    // …then try to use it from tenant A on tenant A's lead.
    const res = await api("PATCH", `/leads/${lead3}`, adminToken, { stageId: foreignStageId });
    expect(res.status).toBe(400);
  });

  it("tenant B's own lifecycle works and never sees tenant A history", async () => {
    const created = await createLead(adminBToken, { contactId: contactB2Id, stage: "prospect", value: 10 });
    expect(created.status).toBe(201);
    const idB = (await created.json()).id;
    expect((await setStage(adminBToken, idB, "won")).status).toBe(200);
    const { totalValue } = await pipelineTotal(adminBToken);
    expect(totalValue).toBe(0); // their only lead is won — open pipeline empty
  });
});
