// Batch 16 — Workflow Engine. Proves against the live API (+ direct DB / engine
// module access from this process for the retry/resume/recovery/tenancy cases
// that cannot be driven through HTTP):
//   triggers (all 7 + config filters), lifecycle (draft/archived never execute,
//   captured revision survives unpublish+edit), conditions (AND, non-match),
//   engine (one run per event, DB-level dedupe, JobQueue usage, strict action
//   order, resume after transient retry, exhausted retries, deterministic
//   failure, orphan recovery), every action type, recipient resolution and
//   skips, invalid explicit references, loop safety, REAL dual-company tenancy,
//   the run-history API, and "no AI".
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  leadTagsTable,
  tagsTable,
  tasksTable,
  followUpsTable,
  notificationsTable,
  auditLogsTable,
  leadActivitiesTable,
  contactStatusHistoryTable,
  pipelineStagesTable,
  workflowDefinitionsTable,
  workflowRunsTable,
  workflowActionRunsTable,
  aiInvocationsTable,
  loginAttemptsTable,
} from "@workspace/db";
import { dispatchWorkflowEvents } from "../src/lib/workflows/dispatch.js";
import { executeRun, WORKFLOW_RUN_JOB } from "../src/lib/workflows/engine.js";
import { leadCreatedEvent } from "../src/lib/workflows/events.js";
import { recoverOrphanedWorkflowRuns } from "../src/lib/workflows/recovery.js";
import { WorkflowFailure } from "../src/lib/workflows/errors.js";
import type { ActionExecutor } from "../src/lib/workflows/actions.js";
import type { JobQueue, JobOptions } from "../src/lib/jobs/types.js";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b16qa-${SUFFIX}.test`;
const DOMAIN_B = `b16qab-${SUFFIX}.test`;

let platformToken = "";
let companyId = 0;
let companyBId = 0;
let adminToken = "";
let empToken = "";
let adminBToken = "";
let adminId = 0;
let emp1Id = 0;
let adminBId = 0;
let tagA = 0;
let tagA2 = 0;
let tagB = 0;
let stageKeys: string[] = [];
let apiContactCreations = 0;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Spec = { trigger: Record<string, unknown>; conditions?: unknown[]; actions: unknown[] };
// Every definition a test publishes is archived after the test (afterEach below)
// so definitions of earlier tests never fire on later tests' CRM mutations.
const createdDefinitions: Array<{ id: number; token: string }> = [];
async function createDefinition(token: string, name: string, spec: Spec, publish = true) {
  const res = await api("POST", "/workflows", token, { name: `${name} ${SUFFIX}`, ...spec });
  expect(res.status, await res.clone().text()).toBe(201);
  const d = await res.json();
  createdDefinitions.push({ id: d.id, token });
  if (!publish) return d;
  const pub = await api("POST", `/workflows/${d.id}/publish`, token, { revision: d.revision });
  expect(pub.status, await pub.clone().text()).toBe(200);
  return pub.json();
}

afterEach(async () => {
  while (createdDefinitions.length > 0) {
    const { id, token } = createdDefinitions.pop()!;
    const cur = await api("GET", `/workflows/${id}`, token);
    if (cur.status !== 200) continue;
    const d = await cur.json();
    if (d.status === "archived") continue;
    await api("POST", `/workflows/${id}/archive`, token, { revision: d.revision });
  }
});

async function runsFor(definitionId: number, token = adminToken) {
  const res = await api("GET", `/workflows/runs?workflowDefinitionId=${definitionId}`, token);
  expect(res.status).toBe(200);
  return (await res.json()).items as Array<Record<string, any>>;
}

// Waits until the definition has `expected` runs and none is queued/running.
async function waitForRuns(definitionId: number, expected: number, timeoutMs = 8000) {
  const start = Date.now();
  let items: Array<Record<string, any>> = [];
  while (Date.now() - start < timeoutMs) {
    items = await runsFor(definitionId);
    if (items.length >= expected && items.every((r) => r.status === "completed" || r.status === "failed")) return items;
    await sleep(100);
  }
  return items;
}

async function runDetail(id: number, token = adminToken) {
  const res = await api("GET", `/workflows/runs/${id}`, token);
  expect(res.status).toBe(200);
  return res.json();
}

async function newContact(cid: number, over: Record<string, unknown> = {}) {
  const [row] = await db.insert(contactsTable).values({ companyId: cid, fullName: `B16 Contact ${Math.random().toString(36).slice(2, 7)}`, contactCompany: "Acme", email: `c-${Math.random().toString(36).slice(2, 8)}@${DOMAIN}`, ...over }).returning();
  return row;
}

async function createLead(token: string, body: Record<string, unknown>) {
  const res = await api("POST", "/leads", token, { title: "B16 lead", ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}

async function leadTagIds(leadId: number): Promise<number[]> {
  const rows = await db.select({ tagId: leadTagsTable.tagId }).from(leadTagsTable).where(eq(leadTagsTable.leadId, leadId));
  return rows.map((r) => r.tagId).sort();
}

async function jobStats(): Promise<{ enqueued: number }> {
  const res = await api("GET", "/metrics", platformToken);
  expect(res.status).toBe(200);
  return (await res.json()).jobs;
}

// A queue double for engine-level tests: records enqueues, never executes.
function fakeQueue() {
  const calls: Array<{ name: string; payload: unknown; opts?: JobOptions }> = [];
  const q: JobQueue = {
    driver: "fake",
    register: () => undefined,
    enqueue: async (name, payload, opts) => {
      calls.push({ name, payload, opts });
    },
    start: () => undefined,
    stop: async () => undefined,
    stats: () => ({ pending: 0, active: 0, enqueued: calls.length, completed: 0, failed: 0, deadLettered: 0 }),
  };
  return { q, calls };
}

// Creates a QUEUED run in THIS process (its queue never executes), so the engine
// can be driven explicitly with executeRun.
async function queuedRunFor(definitionId: number, leadRow: { id: number }) {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadRow.id));
  const { q } = fakeQueue();
  const out = await dispatchWorkflowEvents([leadCreatedEvent(lead, adminId)], { queue: q });
  const [run] = await db.select().from(workflowRunsTable).where(and(eq(workflowRunsTable.workflowDefinitionId, definitionId), inArray(workflowRunsTable.id, out.runIds.length ? out.runIds : [-1])));
  expect(run, "run created for definition").toBeTruthy();
  return run;
}

beforeAll(async () => {
  expect(process.env.SMTP_HOST ?? "", "tests must run without an SMTP provider").toBe("");
  platformToken = await loginToken(PLATFORM);
  const mkCompany = async (name: string) => {
    const co = await api("POST", "/companies", platformToken, { name, plan: "professional" });
    expect(co.status).toBe(201);
    const id = (await co.json()).id as number;
    await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, id));
    return id;
  };
  const mkUser = async (email: string, name: string, role: string, cid: number) => {
    const res = await api("POST", "/users", platformToken, { email, name, role, password: PW, companyId: cid });
    expect(res.status, `create ${email}`).toBe(201);
    return (await res.json()).id as number;
  };
  companyId = await mkCompany(`B16 QA ${SUFFIX}`);
  companyBId = await mkCompany(`B16 QA B ${SUFFIX}`);
  adminId = await mkUser(`qa-admin@${DOMAIN}`, "B16 Admin", "primary_admin", companyId);
  emp1Id = await mkUser(`qa-emp@${DOMAIN}`, "B16 Employee", "employee", companyId);
  await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, emp1Id));
  adminBId = await mkUser(`qa-admin@${DOMAIN_B}`, "B16 Admin B", "primary_admin", companyBId);
  adminToken = await loginToken({ email: `qa-admin@${DOMAIN}`, password: PW });
  empToken = await loginToken({ email: `qa-emp@${DOMAIN}`, password: PW });
  adminBToken = await loginToken({ email: `qa-admin@${DOMAIN_B}`, password: PW });
  const t1 = await api("POST", "/tags", adminToken, { name: `b16-hot-${SUFFIX}` });
  tagA = (await t1.json()).id;
  const t2 = await api("POST", "/tags", adminToken, { name: `b16-alt-${SUFFIX}` });
  tagA2 = (await t2.json()).id;
  const t3 = await api("POST", "/tags", adminBToken, { name: `b16-foreign-${SUFFIX}` });
  tagB = (await t3.json()).id;
  const stages = await api("GET", "/pipeline/stages", adminToken);
  stageKeys = ((await stages.json()).stages as Array<{ key: string }>).map((s) => s.key);
  expect(stageKeys).toContain("qualified");
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(workflowRunsTable).where(eq(workflowRunsTable.companyId, cid));
    await db.delete(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.companyId, cid));
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.companyId, cid));
    await db.delete(leadTagsTable).where(eq(leadTagsTable.companyId, cid));
    await db.delete(followUpsTable).where(eq(followUpsTable.companyId, cid));
    await db.delete(tasksTable).where(eq(tasksTable.companyId, cid));
    await db.delete(contactStatusHistoryTable).where(eq(contactStatusHistoryTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(tagsTable).where(eq(tagsTable.companyId, cid));
    await db.delete(pipelineStagesTable).where(eq(pipelineStagesTable.companyId, cid));
    await db.delete(notificationsTable).where(eq(notificationsTable.companyId, cid));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%${DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%${DOMAIN_B}`));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("triggers", () => {
  it("lead.created executes a published definition exactly once and applies the action", async () => {
    const def = await createDefinition(adminToken, "T lead.created", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const before = await jobStats();
    const contact = await newContact(companyId);
    const lead = await createLead(adminToken, { contactId: contact.id, value: 2000, source: "event" });
    const runs = await waitForRuns(def.id, 1);
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ status: "completed", triggerType: "lead.created", entityType: "lead", entityId: lead.id, definitionRevision: def.revision, actorUserId: adminId, workflowName: def.name });
    expect(runs[0].actionSummary).toEqual({ total: 1, completed: 1, skipped: 0, failed: 0 });
    expect(await leadTagIds(lead.id)).toEqual([tagA]);
    const after = await jobStats();
    expect(after.enqueued).toBeGreaterThan(before.enqueued); // the run travelled through the existing JobQueue
    const detail = await runDetail(runs[0].id);
    expect(detail.actions[0]).toMatchObject({ actionIndex: 0, actionType: "lead.add_tag", status: "completed", attempts: 1, result: { tagId: tagA } });
    // duplicate protection: the same event produced one run row only
    const rows = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.workflowDefinitionId, def.id));
    expect(rows.length).toBe(1);
  });

  it("lead.updated honors the changed-field filter", async () => {
    const def = await createDefinition(adminToken, "T lead.updated", { trigger: { type: "lead.updated", config: { fields: ["priority"] } }, actions: [{ type: "lead.add_tag", config: { tagId: tagA2 } }] });
    const lead = await createLead(adminToken, { value: 10 });
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { title: "renamed" })).status).toBe(200);
    await sleep(400);
    expect((await runsFor(def.id)).length).toBe(0);
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { priority: "high" })).status).toBe(200);
    const runs = await waitForRuns(def.id, 1);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("completed");
    expect(await leadTagIds(lead.id)).toEqual([tagA2]);
  });

  it("lead.stage_changed supplies from/to and honors toStageKey", async () => {
    const def = await createDefinition(adminToken, "T stage", { trigger: { type: "lead.stage_changed", config: { toStageKey: "qualified" } }, actions: [{ type: "lead.update_fields", config: { fields: { priority: "stage-hit" } } }] });
    const lead = await createLead(adminToken, { value: 10 });
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { stage: "negotiation" })).status).toBe(200);
    await sleep(400);
    expect((await runsFor(def.id)).length).toBe(0);
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { stage: "qualified" })).status).toBe(200);
    const runs = await waitForRuns(def.id, 1);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("completed");
    const fresh = await (await api("GET", `/leads/${lead.id}`, adminToken)).json();
    expect(fresh.priority).toBe("stage-hit");
    expect(fresh.stage).toBe("qualified");
  });

  it("lead.assigned fires only when the owner actually changes", async () => {
    const def = await createDefinition(adminToken, "T assigned", { trigger: { type: "lead.assigned" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await createLead(adminToken, { value: 10 });
    expect((await api("POST", `/leads/${lead.id}/assign`, adminToken, { assignedToId: adminId })).status).toBe(200);
    const runs = await waitForRuns(def.id, 1);
    expect(runs.length).toBe(1);
    // same owner again → no owner change → no new run
    expect((await api("POST", `/leads/${lead.id}/assign`, adminToken, { assignedToId: adminId })).status).toBe(200);
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { title: "no owner change" })).status).toBe(200);
    await sleep(400);
    expect((await runsFor(def.id)).length).toBe(1);
    // reassigning to someone else fires again
    expect((await api("POST", `/leads/${lead.id}/assign`, adminToken, { assignedToId: emp1Id })).status).toBe(200);
    expect((await waitForRuns(def.id, 2)).length).toBe(2);
  });

  it("contact.created, contact.updated and contact.status_changed (from/to) fire from the contact endpoints", async () => {
    const created = await createDefinition(adminToken, "T contact.created", { trigger: { type: "contact.created" }, actions: [{ type: "contact.add_tag", config: { tag: "auto-created" } }] });
    const updated = await createDefinition(adminToken, "T contact.updated", { trigger: { type: "contact.updated", config: { fields: ["status"] } }, actions: [{ type: "contact.add_tag", config: { tag: "status-touched" } }] });
    const won = await createDefinition(adminToken, "T status won", { trigger: { type: "contact.status_changed", config: { toStatus: "won" } }, actions: [{ type: "contact.update_fields", config: { fields: { leadTemperature: "hot" } } }] });
    const res = await api("POST", "/contacts", adminToken, { firstName: "Grace", lastName: `Hopper${SUFFIX}`, email: `grace-${SUFFIX}@${DOMAIN}`, dedupeResolution: "create_separate" });
    apiContactCreations++;
    expect(res.status, await res.clone().text()).toBe(201);
    const contact = await res.json();
    expect((await waitForRuns(created.id, 1))[0].status).toBe("completed");
    let fresh = await (await api("GET", `/contacts/${contact.id}`, adminToken)).json();
    expect(fresh.tags).toContain("auto-created");
    // status new → won: both the updated (fields=[status]) and the status_changed(toStatus=won) definitions fire
    expect((await api("PATCH", `/contacts/${contact.id}`, adminToken, { status: "won" })).status).toBe(200);
    expect((await waitForRuns(updated.id, 1))[0].status).toBe("completed");
    expect((await waitForRuns(won.id, 1))[0].status).toBe("completed");
    fresh = await (await api("GET", `/contacts/${contact.id}`, adminToken)).json();
    expect(fresh.tags).toContain("status-touched");
    expect(fresh.leadTemperature).toBe("hot");
    // won → lost: toStatus=won no longer matches; the updated definition fires again
    expect((await api("PATCH", `/contacts/${contact.id}`, adminToken, { status: "lost" })).status).toBe(200);
    expect((await waitForRuns(updated.id, 2)).length).toBe(2);
    await sleep(300);
    expect((await runsFor(won.id)).length).toBe(1);
    // a name-only edit does not match fields=[status]
    expect((await api("PATCH", `/contacts/${contact.id}`, adminToken, { jobTitle: "CTO" })).status).toBe(200);
    await sleep(300);
    expect((await runsFor(updated.id)).length).toBe(2);
  });

  it("a non-matching trigger type creates no run", async () => {
    const def = await createDefinition(adminToken, "T contact only", { trigger: { type: "contact.created" }, actions: [{ type: "contact.add_tag", config: { tag: "x" } }] });
    await createLead(adminToken, { value: 10 });
    await sleep(400);
    expect((await runsFor(def.id)).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("lifecycle", () => {
  it("draft and archived definitions never execute; published does", async () => {
    const draft = await createDefinition(adminToken, "L draft", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] }, false);
    const archivedDef = await createDefinition(adminToken, "L archived", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const arc = await api("POST", `/workflows/${archivedDef.id}/archive`, adminToken, { revision: archivedDef.revision });
    expect(arc.status).toBe(200);
    const published = await createDefinition(adminToken, "L published", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA2 } }] });
    const lead = await createLead(adminToken, { value: 10 });
    expect((await waitForRuns(published.id, 1)).length).toBe(1);
    expect((await runsFor(draft.id)).length).toBe(0);
    expect((await runsFor(archivedDef.id)).length).toBe(0);
    expect(await leadTagIds(lead.id)).toEqual([tagA2]);
  });

  it("a queued run executes the CAPTURED revision even after unpublish + edit", async () => {
    const def = await createDefinition(adminToken, "L snapshot", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const capturedRevision = def.revision as number;
    // Queue a run in THIS process (never executed here), then change the definition.
    const lead = await createLead(adminBToken === "" ? adminToken : adminToken, { value: 10 }); // (API process runs its own run for this lead)
    await waitForRuns(def.id, 1);
    const [leadRow] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    await db.delete(leadTagsTable).where(eq(leadTagsTable.leadId, lead.id)); // reset the tag the API run added
    const { q } = fakeQueue();
    const out = await dispatchWorkflowEvents([leadCreatedEvent(leadRow, adminId)], { queue: q });
    expect(out.runIds.length).toBe(1);
    const runId = out.runIds[0];
    const [queued] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, runId));
    expect(queued.status).toBe("queued");
    expect(queued.definitionRevision).toBe(capturedRevision);

    // unpublish → edit (revision moves on) → the queued run must not follow
    const un = await api("POST", `/workflows/${def.id}/unpublish`, adminToken, { revision: capturedRevision });
    expect(un.status).toBe(200);
    const draft = await un.json();
    const edit = await api("PATCH", `/workflows/${def.id}`, adminToken, { revision: draft.revision, actions: [{ type: "lead.add_tag", config: { tagId: tagA2 } }] });
    expect(edit.status).toBe(200);
    const edited = await edit.json();
    expect(edited.revision).toBeGreaterThan(capturedRevision + 1);

    expect(await executeRun(runId, { attempts: 1, maxAttempts: 5 })).toBe("completed");
    expect(await leadTagIds(lead.id)).toEqual([tagA]); // revision-N behaviour, not the edited draft
    const detail = await runDetail(runId);
    expect(detail.definitionRevision).toBe(capturedRevision);
    expect(detail.actions[0].result).toEqual({ tagId: tagA });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("conditions", () => {
  it("multiple conditions are AND; a non-match creates no run", async () => {
    const def = await createDefinition(adminToken, "C and", {
      trigger: { type: "lead.created" },
      conditions: [
        { field: "value", operator: "greater_than", value: 1000 },
        { field: "source", operator: "in", value: ["event", "referral"] },
        { field: "assignedToId", operator: "is_empty" },
      ],
      actions: [{ type: "lead.add_tag", config: { tagId: tagA } }],
    });
    await createLead(adminToken, { value: 500, source: "event" });
    await createLead(adminToken, { value: 5000, source: "web" });
    await createLead(adminToken, { value: 5000, source: "event", assignedToId: adminId });
    await sleep(500);
    expect((await runsFor(def.id)).length).toBe(0);
    const match = await createLead(adminToken, { value: 5000, source: "referral" });
    const runs = await waitForRuns(def.id, 1);
    expect(runs.length).toBe(1);
    expect(runs[0].entityId).toBe(match.id);
    expect(await leadTagIds(match.id)).toEqual([tagA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("engine", () => {
  it("the same event dispatched twice creates exactly one run (database-enforced)", async () => {
    const def = await createDefinition(adminToken, "E dedupe", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await createLead(adminToken, { value: 10 });
    await waitForRuns(def.id, 1);
    const [row] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    const { q, calls } = fakeQueue();
    const event = leadCreatedEvent(row, adminId, "same-event-id");
    const first = await dispatchWorkflowEvents([event], { queue: q });
    const second = await dispatchWorkflowEvents([event], { queue: q });
    expect(first.runIds.length).toBe(1);
    expect(second.runIds.length).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ name: WORKFLOW_RUN_JOB, payload: { runId: first.runIds[0], companyId }, opts: { dedupeKey: `${WORKFLOW_RUN_JOB}:${first.runIds[0]}:1` } });
    const rows = await db.select().from(workflowRunsTable).where(and(eq(workflowRunsTable.workflowDefinitionId, def.id), eq(workflowRunsTable.eventKey, `lead.created:lead:${lead.id}:same-event-id`)));
    expect(rows.length).toBe(1);
  });

  it("actions execute strictly in array order", async () => {
    const def = await createDefinition(adminToken, "E order", {
      trigger: { type: "lead.created" },
      actions: [
        { type: "task.create", config: { title: `B16 first ${SUFFIX}`, assignee: { kind: "actor" } } },
        { type: "lead.add_tag", config: { tagId: tagA } },
        { type: "task.create", config: { title: `B16 third ${SUFFIX}`, assignee: { kind: "actor" } } },
        { type: "notification.create", config: { title: "fourth", recipient: { kind: "actor" } } },
      ],
    });
    const contact = await newContact(companyId);
    await createLead(adminToken, { contactId: contact.id, value: 10 });
    const runs = await waitForRuns(def.id, 1);
    expect(runs[0].status).toBe("completed");
    const detail = await runDetail(runs[0].id);
    expect(detail.actions.map((a: any) => [a.actionIndex, a.actionType, a.status])).toEqual([
      [0, "task.create", "completed"],
      [1, "lead.add_tag", "completed"],
      [2, "task.create", "completed"],
      [3, "notification.create", "completed"],
    ]);
    for (let i = 1; i < detail.actions.length; i++) {
      expect(new Date(detail.actions[i].startedAt).getTime()).toBeGreaterThanOrEqual(new Date(detail.actions[i - 1].completedAt).getTime());
    }
    const tasks = await db.select().from(tasksTable).where(and(eq(tasksTable.companyId, companyId), like(tasksTable.title, `B16 % ${SUFFIX}`)));
    const first = tasks.find((t) => t.title.startsWith("B16 first"))!;
    const third = tasks.find((t) => t.title.startsWith("B16 third"))!;
    expect(first.id).toBeLessThan(third.id);
  });

  it("a transient failure retries and resumes after the completed action without repeating it", async () => {
    const def = await createDefinition(adminToken, "E resume", {
      trigger: { type: "lead.created" },
      actions: [
        { type: "lead.add_tag", config: { tagId: tagA } },
        { type: "task.create", config: { title: "flaky", assignee: { kind: "actor" } } },
        { type: "notification.create", config: { title: "after", recipient: { kind: "actor" } } },
      ],
    });
    const lead = await createLead(adminToken, { value: 10 });
    await waitForRuns(def.id, 1);
    await db.delete(leadTagsTable).where(eq(leadTagsTable.leadId, lead.id));
    const run = await queuedRunFor(def.id, lead);

    const calls: string[] = [];
    let flakyCalls = 0;
    const executors: Partial<Record<string, ActionExecutor>> = {
      "lead.add_tag": async (config, ctx) => {
        calls.push("tag");
        const real = (await import("../src/lib/workflows/actions.js")).ACTION_EXECUTORS["lead.add_tag"];
        return real(config, ctx);
      },
      "task.create": async () => {
        calls.push("task");
        flakyCalls++;
        if (flakyCalls === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        return { fake: true };
      },
      "notification.create": async () => {
        calls.push("notify");
        return { fake: true };
      },
    };
    await expect(executeRun(run.id, { attempts: 1, maxAttempts: 5 }, { executors: executors as any })).rejects.toThrow("connection reset");
    let actions = await db.select().from(workflowActionRunsTable).where(eq(workflowActionRunsTable.runId, run.id)).orderBy(workflowActionRunsTable.actionIndex);
    expect(actions.map((a) => a.status)).toEqual(["completed", "pending", "pending"]);
    expect(actions[1].attempts).toBe(1);
    expect(actions[1].error).toMatchObject({ code: "TRANSIENT", retryable: true });
    let [r] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, run.id));
    expect(r.status).toBe("running");
    expect(r.lockExpiresAt).toBeNull();

    // second delivery (the queue's retry)
    expect(await executeRun(run.id, { attempts: 2, maxAttempts: 5 }, { executors: executors as any })).toBe("completed");
    expect(calls).toEqual(["tag", "task", "task", "notify"]); // the completed tag action was NOT repeated
    actions = await db.select().from(workflowActionRunsTable).where(eq(workflowActionRunsTable.runId, run.id)).orderBy(workflowActionRunsTable.actionIndex);
    expect(actions.map((a) => [a.status, a.attempts])).toEqual([["completed", 1], ["completed", 2], ["completed", 1]]);
    [r] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, run.id));
    expect(r.status).toBe("completed");
    expect(await leadTagIds(lead.id)).toEqual([tagA]);
    // a third delivery is a no-op
    expect(await executeRun(run.id, { attempts: 3, maxAttempts: 5 }, { executors: executors as any })).toBe("noop");
    expect(calls.length).toBe(4);
  });

  it("the final transient attempt persists a sanitized failure; a deterministic failure fails immediately", async () => {
    const def = await createDefinition(adminToken, "E fail", { trigger: { type: "lead.created" }, actions: [{ type: "task.create", config: { title: "x", assignee: { kind: "actor" } } }] });
    const lead = await createLead(adminToken, { value: 10 });
    await waitForRuns(def.id, 1);
    const exhausted = await queuedRunFor(def.id, { id: lead.id });
    const boom = async () => {
      throw new Error("smtp password=secret rejected");
    };
    expect(await executeRun(exhausted.id, { attempts: 5, maxAttempts: 5 }, { executors: { "task.create": boom } as any })).toBe("failed");
    let detail = await runDetail(exhausted.id);
    expect(detail.status).toBe("failed");
    expect(detail.error).toMatchObject({ code: "RETRIES_EXHAUSTED", underlyingCode: "UNEXPECTED", actionIndex: 0, actionType: "task.create" });
    expect(JSON.stringify(detail)).not.toContain("secret");
    expect(detail.actions[0].status).toBe("failed");

    const lead2 = await createLead(adminToken, { value: 10 });
    await waitForRuns(def.id, 2);
    const deterministic = await queuedRunFor(def.id, { id: lead2.id });
    const bad = async () => {
      throw new WorkflowFailure("REFERENCE_INVALID", "configured user #999 is gone");
    };
    expect(await executeRun(deterministic.id, { attempts: 1, maxAttempts: 5 }, { executors: { "task.create": bad } as any })).toBe("failed");
    detail = await runDetail(deterministic.id);
    expect(detail.error).toMatchObject({ code: "REFERENCE_INVALID", errorClass: "WorkflowFailure", retryable: false, actionIndex: 0 });
    expect(detail.actions[0].attempts).toBe(1);
  });

  it("orphan recovery re-enqueues queued/abandoned runs without duplicating them", async () => {
    const def = await createDefinition(adminToken, "E orphan", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await createLead(adminToken, { value: 10 });
    await waitForRuns(def.id, 1);
    const run = await queuedRunFor(def.id, { id: lead.id });
    const { q, calls } = fakeQueue();
    // fresh run: within the grace period → not touched
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(0);
    await db.update(workflowRunsTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(workflowRunsTable.id, run.id));
    const first = await recoverOrphanedWorkflowRuns(q);
    expect(first.requeued).toBe(1);
    expect(calls[0]).toMatchObject({ name: WORKFLOW_RUN_JOB, payload: { runId: run.id, companyId }, opts: { dedupeKey: `${WORKFLOW_RUN_JOB}:${run.id}:2` } });
    // the sweep refreshed updated_at, so the very next sweep leaves it alone
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(0);
    await db.update(workflowRunsTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(workflowRunsTable.id, run.id));
    await recoverOrphanedWorkflowRuns(q);
    expect(calls[1].opts?.dedupeKey).toBe(`${WORKFLOW_RUN_JOB}:${run.id}:3`);
    const rows = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.workflowDefinitionId, def.id));
    expect(rows.filter((r) => r.entityId === lead.id).length).toBe(2); // the API's own run + the one queued here; recovery added none
    // executing the recovered run still produces one result
    expect(await executeRun(run.id, { attempts: 1, maxAttempts: 5 })).toBe("completed");
    expect(await leadTagIds(lead.id)).toEqual([tagA]);
    // completed runs are never recovered
    await db.update(workflowRunsTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(workflowRunsTable.id, run.id));
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("actions", () => {
  it("every lead/contact action type succeeds against the existing services", async () => {
    const leadDef = await createDefinition(adminToken, "A lead actions", {
      trigger: { type: "lead.created" },
      actions: [
        { type: "lead.assign_owner", config: { strategy: "manual", assignedToId: emp1Id } },
        { type: "lead.update_fields", config: { fields: { stage: "qualified", priority: "p1", currency: "EUR" } } },
        { type: "lead.add_tag", config: { tagId: tagA } },
        { type: "lead.add_tag", config: { tagId: tagA2 } },
        { type: "lead.remove_tag", config: { tagId: tagA2 } },
        { type: "task.create", config: { title: `B16 owner task ${SUFFIX}`, type: "call", dueInDays: 2, dueTime: "09:30", assignee: { kind: "record_owner" } } },
        { type: "follow_up.create", config: { scheduleInDays: 3, scheduledTime: "10:00", notes: "auto", assignee: { kind: "user", userId: adminId } } },
        { type: "notification.create", config: { title: `B16 notify ${SUFFIX}`, body: "hello", recipient: { kind: "user", userId: adminId } } },
        { type: "email.send", config: { to: { kind: "contact" }, subject: "Welcome", body: "Thanks for visiting" } },
      ],
    });
    const contact = await newContact(companyId, { email: `mail-${SUFFIX}@${DOMAIN}` });
    const lead = await createLead(adminToken, { contactId: contact.id, value: 10 });
    const runs = await waitForRuns(leadDef.id, 1);
    expect(runs[0].status, JSON.stringify(runs[0].error)).toBe("completed");
    const detail = await runDetail(runs[0].id);
    expect(detail.actions.map((a: any) => a.status)).toEqual(Array(9).fill("completed"));
    const fresh = await (await api("GET", `/leads/${lead.id}`, adminToken)).json();
    expect(fresh.assignedToId).toBe(emp1Id);
    expect(fresh.stage).toBe("qualified");
    expect(fresh.priority).toBe("p1");
    expect(fresh.currency).toBe("EUR");
    expect(await leadTagIds(lead.id)).toEqual([tagA]);
    const [task] = await db.select().from(tasksTable).where(and(eq(tasksTable.companyId, companyId), eq(tasksTable.title, `B16 owner task ${SUFFIX}`)));
    expect(task).toMatchObject({ assignedToId: emp1Id, contactId: contact.id, type: "call", dueTime: "09:30", assignedById: adminId });
    expect(task.dueDate).toBe(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
    const [fu] = await db.select().from(followUpsTable).where(and(eq(followUpsTable.companyId, companyId), eq(followUpsTable.contactId, contact.id)));
    expect(fu).toMatchObject({ status: "pending", assignedToId: adminId, scheduledTime: "10:00", createdById: adminId });
    const [mirror] = await db.select({ followUpDate: contactsTable.followUpDate }).from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(mirror.followUpDate).toBe(fu.scheduledDate);
    const [notif] = await db.select().from(notificationsTable).where(and(eq(notificationsTable.userId, adminId), eq(notificationsTable.title, `B16 notify ${SUFFIX}`)));
    expect(notif).toMatchObject({ category: "workflows", companyId, link: `/admin/leads/${lead.id}` });
    expect((notif.metadata as any).workflowActionKey).toBe(`wf:${runs[0].id}:7`);
    expect(detail.actions[8].result).toMatchObject({ queued: true, recipientKind: "contact" });
    // timeline entries for the task/follow-up were emitted by the shared services
    const acts = await db.select({ type: leadActivitiesTable.type }).from(leadActivitiesTable).where(eq(leadActivitiesTable.contactId, contact.id));
    expect(acts.map((a) => a.type)).toEqual(expect.arrayContaining(["task_created", "follow_up_scheduled"]));

    const contactDef = await createDefinition(adminToken, "A contact actions", {
      trigger: { type: "contact.created" },
      actions: [
        { type: "contact.assign_owner", config: { assignedToId: emp1Id } },
        { type: "contact.update_fields", config: { fields: { status: "contacted", statusComment: "auto", city: "Dubai", leadTemperature: "warm" } } },
        { type: "contact.add_tag", config: { tag: "auto" } },
        { type: "contact.add_tag", config: { tag: "gone" } },
        { type: "contact.remove_tag", config: { tag: "gone" } },
        { type: "notification.create", config: { title: "owner ping", recipient: { kind: "record_owner" } } },
      ],
    });
    const res = await api("POST", "/contacts", adminToken, { firstName: "Linus", lastName: `T${SUFFIX}`, email: `linus-${SUFFIX}@${DOMAIN}`, tags: ["seed"], dedupeResolution: "create_separate" });
    apiContactCreations++;
    expect(res.status).toBe(201);
    const c = await res.json();
    const cruns = await waitForRuns(contactDef.id, 1);
    expect(cruns[0].status, JSON.stringify(cruns[0].error)).toBe("completed");
    const freshC = await (await api("GET", `/contacts/${c.id}`, adminToken)).json();
    expect(freshC).toMatchObject({ assignedToId: emp1Id, status: "contacted", city: "Dubai", leadTemperature: "warm" });
    expect(freshC.tags.sort()).toEqual(["auto", "seed"]);
    const hist = await db.select().from(contactStatusHistoryTable).where(eq(contactStatusHistoryTable.contactId, c.id));
    expect(hist.map((h) => h.toStatus)).toEqual(expect.arrayContaining(["new", "contacted"]));
    const [ownerNotif] = await db.select().from(notificationsTable).where(and(eq(notificationsTable.userId, emp1Id), eq(notificationsTable.title, "owner ping")));
    expect(ownerNotif).toBeTruthy(); // record_owner resolved to the owner assigned by action 0
  });

  it("a lead without a contact: task is created unlinked, follow-up and contact email are skipped, missing owner skips notification", async () => {
    const def = await createDefinition(adminToken, "A no contact", {
      trigger: { type: "lead.created" },
      actions: [
        { type: "task.create", config: { title: `B16 unlinked ${SUFFIX}`, assignee: { kind: "actor" } } },
        { type: "follow_up.create", config: { scheduleInDays: 1 } },
        { type: "email.send", config: { to: { kind: "contact" }, subject: "s", body: "b" } },
        { type: "notification.create", config: { title: "to owner", recipient: { kind: "record_owner" } } },
        { type: "lead.add_tag", config: { tagId: tagA } },
      ],
    });
    const lead = await createLead(adminToken, { value: 10 });
    const runs = await waitForRuns(def.id, 1);
    expect(runs[0].status).toBe("completed");
    const detail = await runDetail(runs[0].id);
    expect(detail.actions.map((a: any) => a.status)).toEqual(["completed", "skipped", "skipped", "skipped", "completed"]);
    expect(detail.actions[1].result.reason).toMatch(/no contact/);
    expect(detail.actions[2].result.reason).toMatch(/no contact/);
    expect(detail.actions[3].result.reason).toMatch(/no owner/);
    expect(detail.actionSummary).toEqual({ total: 5, completed: 2, skipped: 3, failed: 0 });
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.title, `B16 unlinked ${SUFFIX}`));
    expect(task.contactId).toBeNull();
    expect(await leadTagIds(lead.id)).toEqual([tagA]); // later actions still ran
  });

  it("an explicit reference that became invalid after publication fails the run deterministically", async () => {
    const t = await api("POST", "/tags", adminToken, { name: `b16-doomed-${SUFFIX}` });
    const doomed = (await t.json()).id as number;
    const def = await createDefinition(adminToken, "A doomed ref", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: doomed } }, { type: "lead.add_tag", config: { tagId: tagA } }] });
    expect((await api("DELETE", `/tags/${doomed}`, adminToken)).status).toBe(200);
    const lead = await createLead(adminToken, { value: 10 });
    const runs = await waitForRuns(def.id, 1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toMatchObject({ code: "REFERENCE_INVALID", actionIndex: 0, actionType: "lead.add_tag", retryable: false });
    const detail = await runDetail(runs[0].id);
    expect(detail.actions.map((a: any) => a.status)).toEqual(["failed", "pending"]); // action 1 never started
    expect(await leadTagIds(lead.id)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("loop safety", () => {
  it("a workflow-caused CRM mutation does not trigger another workflow", async () => {
    const a = await createDefinition(adminToken, "LS A", { trigger: { type: "lead.updated", config: { fields: ["priority"] } }, actions: [{ type: "lead.update_fields", config: { fields: { title: "auto-title" } } }] });
    const b = await createDefinition(adminToken, "LS B", { trigger: { type: "lead.updated", config: { fields: ["title"] } }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await createLead(adminToken, { value: 10 });
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { priority: "urgent" })).status).toBe(200);
    const runsA = await waitForRuns(a.id, 1);
    expect(runsA[0].status).toBe("completed");
    const fresh = await (await api("GET", `/leads/${lead.id}`, adminToken)).json();
    expect(fresh.title).toBe("auto-title"); // A ran and changed the title …
    await sleep(500);
    expect((await runsFor(b.id)).length).toBe(0); // … but B was NOT triggered by A's mutation
    expect(await leadTagIds(lead.id)).toEqual([]);
    // a HUMAN title edit still triggers B normally
    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { title: "human title" })).status).toBe(200);
    expect((await waitForRuns(b.id, 1)).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tenant isolation (real second company)", () => {
  it("a company A definition cannot execute against a company B entity", async () => {
    const def = await createDefinition(adminToken, "TI cross entity", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const [defRow] = await db.select().from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.id, def.id));
    const bLead = await createLead(adminBToken, { value: 10 });
    const [run] = await db
      .insert(workflowRunsTable)
      .values({ companyId, workflowDefinitionId: def.id, definitionRevision: defRow.revision, definitionSnapshot: { name: defRow.name, trigger: defRow.trigger, conditions: defRow.conditions, actions: defRow.actions }, triggerType: "lead.created", entityType: "lead", entityId: bLead.id, actorUserId: adminId, eventKey: `forged:${SUFFIX}`, status: "queued" })
      .returning();
    await db.insert(workflowActionRunsTable).values({ runId: run.id, companyId, actionIndex: 0, actionType: "lead.add_tag" });
    expect(await executeRun(run.id, { attempts: 1, maxAttempts: 5 })).toBe("failed");
    const detail = await runDetail(run.id);
    expect(detail.error).toMatchObject({ code: "ENTITY_NOT_IN_TENANT", retryable: false });
    expect(await leadTagIds(bLead.id)).toEqual([]);
  });

  it("no cross-tenant user/tag/stage reference can execute", async () => {
    const def = await createDefinition(adminToken, "TI cross ref", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await createLead(adminToken, { value: 10 });
    await waitForRuns(def.id, 1);
    await db.delete(leadTagsTable).where(eq(leadTagsTable.leadId, lead.id));
    const [defRow] = await db.select().from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.id, def.id));
    const forged = {
      companyId,
      workflowDefinitionId: def.id,
      definitionRevision: defRow.revision,
      triggerType: "lead.created",
      entityType: "lead",
      entityId: lead.id,
      actorUserId: adminId,
      status: "queued" as const,
    };
    const cases: Array<[string, unknown, string]> = [
      ["tag", { type: "lead.add_tag", config: { tagId: tagB } }, "REFERENCE_INVALID"],
      ["user", { type: "task.create", config: { title: "x", assignee: { kind: "user", userId: adminBId } } }, "REFERENCE_INVALID"],
      ["owner", { type: "lead.assign_owner", config: { strategy: "manual", assignedToId: adminBId } }, "REFERENCE_INVALID"],
      ["stage", { type: "lead.update_fields", config: { fields: { stage: "no_such_stage_key" } } }, "APP_400"],
    ];
    for (const [label, action, code] of cases) {
      const [run] = await db.insert(workflowRunsTable).values({ ...forged, definitionSnapshot: { name: label, trigger: defRow.trigger, conditions: [], actions: [action] }, eventKey: `forged:${label}:${SUFFIX}` }).returning();
      await db.insert(workflowActionRunsTable).values({ runId: run.id, companyId, actionIndex: 0, actionType: (action as { type: string }).type });
      expect(await executeRun(run.id, { attempts: 1, maxAttempts: 5 }), label).toBe("failed");
      const [r] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, run.id));
      expect((r.error as any).code, label).toBe(code);
    }
    expect(await leadTagIds(lead.id)).toEqual([]);
    const fresh = await (await api("GET", `/leads/${lead.id}`, adminToken)).json();
    expect(fresh.assignedToId).toBeNull();
    const bTasks = await db.select().from(tasksTable).where(eq(tasksTable.assignedToId, adminBId));
    expect(bTasks.length).toBe(0);
  });

  it("company B cannot read company A runs; company A history never contains B", async () => {
    const def = await createDefinition(adminToken, "TI history", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    await createLead(adminToken, { value: 10 });
    const runs = await waitForRuns(def.id, 1);
    expect((await api("GET", `/workflows/runs/${runs[0].id}`, adminBToken)).status).toBe(404);
    const bList = await (await api("GET", "/workflows/runs", adminBToken)).json();
    expect(bList.items.every((r: any) => r.companyId === companyBId)).toBe(true);
    expect(bList.items.map((r: any) => r.id)).not.toContain(runs[0].id);
    expect((await api("GET", `/workflows/runs?workflowDefinitionId=${def.id}`, adminBToken)).status).toBe(200);
    expect((await (await api("GET", `/workflows/runs?workflowDefinitionId=${def.id}`, adminBToken)).json()).items.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("run history API", () => {
  it("lists and filters own runs, returns ordered action results, and enforces workflows:view", async () => {
    const list = await (await api("GET", "/workflows/runs?status=completed&entityType=lead&page=1&pageSize=5", adminToken)).json();
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.length).toBeLessThanOrEqual(5);
    expect(list.pageSize).toBe(5);
    expect(list.items.every((r: any) => r.status === "completed" && r.entityType === "lead" && r.companyId === companyId)).toBe(true);
    const failed = await (await api("GET", "/workflows/runs?status=failed", adminToken)).json();
    expect(failed.items.every((r: any) => r.status === "failed")).toBe(true);
    expect((await api("GET", "/workflows/runs?status=exploded", adminToken)).status).toBe(400);
    const detail = await runDetail(list.items[0].id);
    expect(Array.isArray(detail.actions)).toBe(true);
    expect(detail.actions.map((a: any) => a.actionIndex)).toEqual(detail.actions.map((_: any, i: number) => i));
    expect(detail.eventKey).toBeTruthy();
    expect((await api("GET", "/workflows/runs/999999999", adminToken)).status).toBe(404);
    // RBAC: no workflows permission → 403; view → 200
    expect((await api("GET", "/workflows/runs", empToken)).status).toBe(403);
    expect((await api("GET", `/workflows/runs/${list.items[0].id}`, empToken)).status).toBe(403);
    await db.update(usersTable).set({ permissions: { workflows: ["view"] } }).where(eq(usersTable.id, emp1Id));
    try {
      expect((await api("GET", "/workflows/runs", empToken)).status).toBe(200);
      expect((await api("GET", `/workflows/runs/${list.items[0].id}`, empToken)).status).toBe(200);
    } finally {
      await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, emp1Id));
    }
    // platform owner is fenced off
    expect((await api("GET", "/workflows/runs", platformToken)).status).toBe(403);
    // no execution endpoints
    for (const path of [`/workflows/runs/${list.items[0].id}/retry`, `/workflows/runs/${list.items[0].id}/replay`, `/workflows/${detail.workflowDefinitionId}/run`, `/workflows/${detail.workflowDefinitionId}/execute`]) {
      expect([404, 405], path).toContain((await api("POST", path, adminToken, {})).status);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("no AI", () => {
  it("workflow execution recorded no AI invocation (only the pre-existing contact lead-scoring of POST /contacts appears)", async () => {
    const rows = await db
      .select({ feature: aiInvocationsTable.feature, entityType: aiInvocationsTable.entityType, n: sql<number>`count(*)::int` })
      .from(aiInvocationsTable)
      .where(inArray(aiInvocationsTable.companyId, [companyId, companyBId]))
      .groupBy(aiInvocationsTable.feature, aiInvocationsTable.entityType);
    // The two POST /contacts calls of this suite go through the EXISTING capture
    // pipeline, whose background lead scoring has always produced one ledger row per
    // created contact — that path predates B16 and is unchanged. Nothing else
    // (no lead feature, no assignee recommendation, no enrichment) may appear, and
    // no workflow-executed lead action ever produced a row.
    expect(rows.every((r) => r.feature === "lead_scoring" && r.entityType === "contact")).toBe(true);
    const total = rows.reduce((a, r) => a + r.n, 0);
    expect(total).toBe(apiContactCreations);
    const catalog = await (await api("GET", "/workflows/catalog", adminToken)).json();
    expect(catalog.actions.every((a: any) => !a.type.startsWith("ai"))).toBe(true);
    expect(JSON.stringify(catalog).toLowerCase()).not.toContain("gemini");
  });
});
