// Batch 11 — Lead Conversion & Opportunity Closure. The Lead IS the sales
// opportunity: open = any stage that is not a configured terminal stage
// (isWon/isLost flags; the literal keys "won"/"lost" only as legacy fallback).
// This suite proves the full lifecycle against the live API: the ONE open
// opportunity per contact rule on create AND on reopen (a closed lead cannot
// reopen while the contact has another open lead — 409 with existingId),
// Closed Won / Closed Lost transitions with history + system activities,
// reopening with preserved history, open-pipeline math (currency-normalized,
// terminal stages excluded, reopen restores), configurable custom terminal
// stages (closed_success/closed_failure), and tenant isolation.
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

// Full lead snapshot (stage + history) for no-mutation-on-rejection checks.
async function leadSnapshot(token: string, leadId: number): Promise<{ stage: string; historyCount: number; activityCount: number }> {
  const res = await api("GET", `/leads/${leadId}`, token);
  expect(res.status).toBe(200);
  const body = await res.json();
  const acts = await activities(token, leadId);
  return { stage: body.stage, historyCount: (body.history ?? []).length, activityCount: acts.length };
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

describe("reopening a closed opportunity (one open per contact enforced)", () => {
  it("cannot reopen a WON lead while the contact has another open opportunity (409 + existingId)", async () => {
    const before = await leadSnapshot(adminToken, lead1);
    expect(before.stage).toBe("won");

    const res = await setStage(adminToken, lead1, "qualified");
    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(lead3);

    // The rejected reopen must be a pure no-op: stage, history, and
    // activities of the closed lead are completely untouched.
    const after = await leadSnapshot(adminToken, lead1);
    expect(after).toEqual(before);
  });

  it("cannot reopen a LOST lead in the same situation either", async () => {
    const before = await leadSnapshot(adminToken, lead2);
    expect(before.stage).toBe("lost");
    const res = await setStage(adminToken, lead2, "negotiation");
    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(lead3);
    expect(await leadSnapshot(adminToken, lead2)).toEqual(before);
  });

  it("open → open moves on the open lead itself remain allowed", async () => {
    const res = await setStage(adminToken, lead3, "negotiation");
    expect(res.status).toBe(200);
    expect((await res.json()).stage).toBe("negotiation");
  });

  it("after the open opportunity closes, reopen succeeds with history preserved", async () => {
    // Close the blocking open lead…
    expect((await setStage(adminToken, lead3, "lost")).status).toBe(200);

    // …now the won lead can reopen: transition recorded, prior history kept.
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

  it("the reopened lead returns to the open pipeline total", async () => {
    const { totalValue } = await pipelineTotal(adminToken);
    // Open: reopened lead1 (1000 USD) + leadB (7500 SAR = 2000 USD) = 3000.
    // lead2 (lost) and lead3 (now lost) stay excluded.
    expect(totalValue).toBe(3000);
  });

  it("the reopened lead now blocks reopening the other closed lead (409 + existingId)", async () => {
    const res = await setStage(adminToken, lead2, "negotiation");
    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(lead1);
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

// ── Configurable terminal stages ─────────────────────────────────────────────
// Tenant-configured isWon/isLost flags are authoritative for closed semantics;
// the literal "won"/"lost" keys (exercised by every block above) remain only a
// legacy fallback. Runs in tenant B, whose only prior lead is won.
describe("custom terminal stages (isWon/isLost flags authoritative)", () => {
  let leadC1 = 0; // → closed_success (custom won)
  let leadC2 = 0; // → closed_failure (custom lost)
  let leadC3 = 0; // stays open to force the reopen conflict

  it("creates custom closed_success (isWon) and closed_failure (isLost) stages", async () => {
    const won = await api("POST", "/pipeline/stages", adminBToken, { name: "Closed Success", key: "closed_success", isWon: true });
    expect(won.status).toBe(201);
    const lost = await api("POST", "/pipeline/stages", adminBToken, { name: "Closed Failure", key: "closed_failure", isLost: true });
    expect(lost.status).toBe(201);
  });

  it("closing into a custom WON stage emits a 'won' system activity", async () => {
    const created = await createLead(adminBToken, { contactId: contactB2Id, stage: "prospect", value: 500, currency: "USD" });
    expect(created.status).toBe(201);
    leadC1 = (await created.json()).id;

    const res = await setStage(adminBToken, leadC1, "closed_success");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe("closed_success");
    expect(body.history.some((h: any) => h.fieldName === "stage" && h.oldValue === "prospect" && h.newValue === "closed_success")).toBe(true);

    const acts = await activities(adminBToken, leadC1);
    const wonAct = acts.find((a: any) => a.type === "won");
    expect(wonAct).toBeTruthy();
    expect(wonAct.source).toBe("system");
  });

  it("the custom terminal stage stays visible in the pipeline but is excluded from the open total", async () => {
    const { totalValue, stages } = await pipelineTotal(adminBToken);
    const successStage = stages.find((s: any) => s.stage === "closed_success");
    expect(successStage).toBeTruthy(); // custom stage must not disappear
    expect(successStage.leads.map((l: any) => l.id)).toContain(leadC1);
    expect(totalValue).toBe(0); // 500 sits in a flag-won stage → not open value
  });

  it("a custom-WON opportunity does not block a new one for the contact", async () => {
    const res = await createLead(adminBToken, { contactId: contactB2Id, stage: "prospect", value: 800, currency: "USD" });
    expect(res.status).toBe(201);
    leadC2 = (await res.json()).id;
  });

  it("closing into a custom LOST stage emits a 'lost' activity and unblocks the contact", async () => {
    const res = await setStage(adminBToken, leadC2, "closed_failure");
    expect(res.status).toBe(200);
    const acts = await activities(adminBToken, leadC2);
    expect(acts.some((a: any) => a.type === "lost" && a.source === "system")).toBe(true);

    const { totalValue, stages } = await pipelineTotal(adminBToken);
    expect(stages.find((s: any) => s.stage === "closed_failure").leads.map((l: any) => l.id)).toContain(leadC2);
    expect(totalValue).toBe(0); // custom lost excluded from open value too

    const next = await createLead(adminBToken, { contactId: contactB2Id, stage: "qualified", value: 600, currency: "USD" });
    expect(next.status).toBe(201);
    leadC3 = (await next.json()).id;
  });

  it("reopen conflict applies to custom terminals: 409 while another open lead exists", async () => {
    const before = await leadSnapshot(adminBToken, leadC1);
    expect(before.stage).toBe("closed_success");
    const res = await setStage(adminBToken, leadC1, "prospect");
    expect(res.status).toBe(409);
    expect((await res.json()).existingId).toBe(leadC3);
    expect(await leadSnapshot(adminBToken, leadC1)).toEqual(before); // untouched
  });

  it("after closing the open lead via a custom terminal, reopen succeeds and restores open value", async () => {
    expect((await setStage(adminBToken, leadC3, "closed_failure")).status).toBe(200);
    const res = await setStage(adminBToken, leadC1, "prospect");
    expect(res.status).toBe(200);
    const { totalValue } = await pipelineTotal(adminBToken);
    expect(totalValue).toBe(500); // reopened leadC1 back in the open pipeline
  });
});

// ── Final correction: strict stage-key resolution ────────────────────────────
// A supplied stage key must resolve to a LIVE configured stage (400 otherwise,
// nothing written); legacy rows with a NULL stageId still classify by flags
// when their key matches a live stage; a soft-deleted stage stops supplying
// authoritative flags (literal won/lost fallback only). Uses a fresh contact
// in tenant B; the pipeline there currently has leadC1 (prospect, 500) open
// and everything else closed.
describe("strict stage-key resolution & legacy classification", () => {
  let contactDId = 0;
  let leadV = 0; // → closed_success, then stageId NULLed, then stage deleted
  let leadW = 0; // stays open

  it("create with an unknown stage key → 400 and no lead is created", async () => {
    const [d] = await db
      .insert(contactsTable)
      .values([{ companyId: companyBId, fullName: "B11 Contact D", contactCompany: "Umbrella" }])
      .returning({ id: contactsTable.id });
    contactDId = d.id;

    const bad = await createLead(adminBToken, { contactId: contactDId, stage: "no_such_stage_b11", value: 400, currency: "USD" });
    expect(bad.status).toBe(400);

    // Proof nothing was created: an open lead would make this second create
    // 409 under the one-open-opportunity rule — it succeeds instead.
    const ok = await createLead(adminBToken, { contactId: contactDId, stage: "prospect", value: 400, currency: "USD" });
    expect(ok.status).toBe(201);
    leadV = (await ok.json()).id;
  });

  it("update with an unknown stage key → 400; stage, history and activities untouched", async () => {
    const before = await leadSnapshot(adminBToken, leadV);
    const res = await setStage(adminBToken, leadV, "totally_bogus_stage");
    expect(res.status).toBe(400);
    expect(await leadSnapshot(adminBToken, leadV)).toEqual(before);
  });

  it("a legacy lead with stageId NULL still counts as CLOSED when its key matches a live custom terminal stage", async () => {
    expect((await setStage(adminBToken, leadV, "closed_success")).status).toBe(200);
    // Simulate a legacy/stale row: key kept, FK link lost.
    await db.update(leadsTable).set({ stageId: null }).where(eq(leadsTable.id, leadV));

    // The one-open-opportunity check must treat leadV as closed via the live
    // closed_success flags — so a new opportunity for the contact is allowed.
    const res = await createLead(adminBToken, { contactId: contactDId, stage: "prospect", value: 300, currency: "USD" });
    expect(res.status).toBe(201);
    leadW = (await res.json()).id;

    // Consistent with getPipeline: leadV (400) stays excluded from the open
    // total and still shows in its stage column despite the NULL stageId.
    const { totalValue, stages } = await pipelineTotal(adminBToken);
    expect(totalValue).toBe(800); // leadC1 500 + leadW 300
    expect(stages.find((s: any) => s.stage === "closed_success").leads.map((l: any) => l.id)).toContain(leadV);
  });

  it("a soft-deleted terminal stage no longer supplies isWon/isLost flags (literal fallback only)", async () => {
    const { stages } = await api("GET", "/pipeline/stages", adminBToken).then((r) => r.json());
    const successStage = stages.find((s: any) => s.key === "closed_success");
    expect(successStage).toBeTruthy();
    expect((await api("DELETE", `/pipeline/stages/${successStage.id}`, adminBToken)).status).toBe(200);

    // "closed_success" now resolves to no live stage; the literal fallback does
    // not treat it as closed, so leadV counts as OPEN again — blocking a new
    // opportunity for the contact…
    const res = await createLead(adminBToken, { contactId: contactDId, stage: "prospect", value: 50, currency: "USD" });
    expect(res.status).toBe(409);
    expect([leadV, leadW]).toContain((await res.json()).existingId);

    // …and getPipeline agrees: leadV's 400 re-enters the open total.
    const { totalValue } = await pipelineTotal(adminBToken);
    expect(totalValue).toBe(1200); // leadC1 500 + leadW 300 + leadV 400
  });
});
