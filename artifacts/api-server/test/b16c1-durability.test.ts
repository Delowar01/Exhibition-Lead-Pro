// Batch 16 — Correction 1: the workflow event durability boundary.
//
//   db.transaction(tx) { CRM mutation ; persistWorkflowRuns(events, tx) }  → COMMIT
//   enqueueWorkflowRuns(runs)                                              → after commit
//
// Proves, with the real services called from THIS process (so faults can be
// injected) and the live API for the ordinary path:
//   • a forced workflow-persistence failure rolls back the matching CRM
//     mutation (lead create/update/assign incl. round-robin, contact
//     create/update) — nothing is swallowed, the error propagates unchanged;
//   • an enqueue failure after the commit leaves a durable `queued` run that is
//     already visible to other connections at enqueue time;
//   • orphan recovery completes that work exactly once;
//   • a successful matching mutation can never exist without its run;
//   • committed import batches (contacts and leads) share the same boundary.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray, like, notInArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  leadHistoryTable,
  leadTagsTable,
  tagsTable,
  teamsTable,
  assignmentCursorsTable,
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
  loginAttemptsTable,
} from "@workspace/db";
import { __setWorkflowDispatchFaultsForTests } from "../src/lib/workflows/dispatch.js";
import { executeRun, WORKFLOW_RUN_JOB } from "../src/lib/workflows/engine.js";
import { recoverOrphanedWorkflowRuns } from "../src/lib/workflows/recovery.js";
import * as leadsService from "../src/services/leads.service.js";
import * as contactsService from "../src/services/contacts.service.js";
import * as importService from "../src/services/import.service.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";
import type { JobQueue, JobOptions } from "../src/lib/jobs/types.js";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b16c1-${SUFFIX}.test`;
const PERSIST_BOOM = `b16c1 forced workflow persistence failure ${SUFFIX}`;
const ENQUEUE_BOOM = `b16c1 forced enqueue failure ${SUFFIX}`;

let platformToken = "";
let adminToken = "";
let companyId = 0;
let adminId = 0;
let emp1Id = 0;
let tagA = 0;
let admin: AuthUser;

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

// The service-layer principal for direct calls: the same shape requireAuth
// builds from the fresh user row (primary_admin of the throwaway tenant).
function principal(id: number, email: string): AuthUser {
  return {
    id, email, name: "B16C1 Admin", role: "primary_admin", companyId, permissions: {},
    contactVisibility: "all", companyVisibility: "all", selectedUserIds: [], isActive: true,
    companyStatus: "active", readOnly: false, accessibleCompanies: [companyId], sessionId: null,
  };
}

type Spec = { trigger: Record<string, unknown>; conditions?: unknown[]; actions: unknown[] };
const createdDefinitions: Array<{ id: number; token: string }> = [];
async function createDefinition(token: string, name: string, spec: Spec) {
  const res = await api("POST", "/workflows", token, { name: `${name} ${SUFFIX}`, ...spec });
  expect(res.status, await res.clone().text()).toBe(201);
  const d = await res.json();
  createdDefinitions.push({ id: d.id, token });
  const pub = await api("POST", `/workflows/${d.id}/publish`, token, { revision: d.revision });
  expect(pub.status, await pub.clone().text()).toBe(200);
  return pub.json();
}

// Every fault is cleared and every definition archived after each test so
// nothing leaks into the next test (or into the other suites).
afterEach(async () => {
  __setWorkflowDispatchFaultsForTests({});
  while (createdDefinitions.length > 0) {
    const { id, token } = createdDefinitions.pop()!;
    const cur = await api("GET", `/workflows/${id}`, token);
    if (cur.status !== 200) continue;
    const d = await cur.json();
    if (d.status === "archived") continue;
    await api("POST", `/workflows/${id}/archive`, token, { revision: d.revision });
  }
});

function forcePersistFailure() {
  __setWorkflowDispatchFaultsForTests({ persist: () => { throw new Error(PERSIST_BOOM); } });
}

// Enqueue fault: records every run handed to the enqueue step and, at that very
// moment, reads the run back on a DIFFERENT pool connection. Under READ
// COMMITTED that read only sees the row if its transaction has already
// committed — i.e. it proves "enqueue happens after commit". Then it throws,
// which is the "enqueue failed after commit" scenario.
type Seen = Array<{ id: number; visibleAtEnqueue: Promise<typeof workflowRunsTable.$inferSelect | undefined> }>;
function captureEnqueueFailures(): Seen {
  const seen: Seen = [];
  __setWorkflowDispatchFaultsForTests({
    enqueue: (run) => {
      seen.push({ id: run.id, visibleAtEnqueue: db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, run.id)).then((r) => r[0]) });
      throw new Error(ENQUEUE_BOOM);
    },
  });
  return seen;
}

function fakeQueue() {
  const calls: Array<{ name: string; payload: unknown; opts?: JobOptions }> = [];
  const q: JobQueue = {
    driver: "fake",
    register: () => undefined,
    enqueue: async (name, payload, opts) => { calls.push({ name, payload, opts }); },
    start: () => undefined,
    stop: async () => undefined,
    stats: () => ({ pending: 0, active: 0, enqueued: calls.length, completed: 0, failed: 0, deadLettered: 0 }),
  };
  return { q, calls };
}

async function runsForDef(definitionId: number) {
  return db.select().from(workflowRunsTable).where(eq(workflowRunsTable.workflowDefinitionId, definitionId));
}
async function actionRunsFor(runId: number) {
  return db.select().from(workflowActionRunsTable).where(eq(workflowActionRunsTable.runId, runId));
}
async function leadTagIds(leadId: number): Promise<number[]> {
  const rows = await db.select({ tagId: leadTagsTable.tagId }).from(leadTagsTable).where(eq(leadTagsTable.leadId, leadId));
  return rows.map((r) => r.tagId).sort();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function count(table: any, where: SQL | undefined) {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(table).where(where);
  return Number(row?.c ?? 0);
}
async function ageRun(id: number) {
  await db.update(workflowRunsTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(workflowRunsTable.id, id));
}

async function newContact(over: Record<string, unknown> = {}) {
  const [row] = await db.insert(contactsTable).values({ companyId, fullName: `B16C1 Contact ${Math.random().toString(36).slice(2, 7)}`, contactCompany: "Acme", email: `c-${Math.random().toString(36).slice(2, 8)}@${DOMAIN}`, ...over }).returning();
  return row;
}
async function apiLead(body: Record<string, unknown>) {
  const res = await api("POST", "/leads", adminToken, { title: "B16C1 lead", ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}
async function apiContact(body: Record<string, unknown>) {
  const res = await api("POST", "/contacts", adminToken, { dedupeResolution: "create_separate", ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}

beforeAll(async () => {
  expect(process.env.SMTP_HOST ?? "", "tests must run without an SMTP provider").toBe("");
  platformToken = await loginToken(PLATFORM);
  const co = await api("POST", "/companies", platformToken, { name: `B16C1 QA ${SUFFIX}`, plan: "professional" });
  expect(co.status).toBe(201);
  companyId = (await co.json()).id as number;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const mkUser = async (email: string, name: string, role: string) => {
    const res = await api("POST", "/users", platformToken, { email, name, role, password: PW, companyId });
    expect(res.status, `create ${email}`).toBe(201);
    return (await res.json()).id as number;
  };
  adminId = await mkUser(`qa-admin@${DOMAIN}`, "B16C1 Admin", "primary_admin");
  emp1Id = await mkUser(`qa-emp@${DOMAIN}`, "B16C1 Employee", "employee");
  adminToken = await loginToken({ email: `qa-admin@${DOMAIN}`, password: PW });
  admin = principal(adminId, `qa-admin@${DOMAIN}`);
  const t1 = await api("POST", "/tags", adminToken, { name: `b16c1-tag-${SUFFIX}` });
  tagA = (await t1.json()).id;
});

afterAll(async () => {
  __setWorkflowDispatchFaultsForTests({});
  if (companyId) {
    await db.delete(workflowRunsTable).where(eq(workflowRunsTable.companyId, companyId));
    await db.delete(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.companyId, companyId));
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.companyId, companyId));
    await db.delete(leadTagsTable).where(eq(leadTagsTable.companyId, companyId));
    await db.delete(followUpsTable).where(eq(followUpsTable.companyId, companyId));
    await db.delete(tasksTable).where(eq(tasksTable.companyId, companyId));
    await db.delete(contactStatusHistoryTable).where(eq(contactStatusHistoryTable.companyId, companyId));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId)); // lead_history cascades
    await db.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
    await db.delete(assignmentCursorsTable).where(eq(assignmentCursorsTable.companyId, companyId));
    await db.delete(tagsTable).where(eq(tagsTable.companyId, companyId));
    await db.delete(pipelineStagesTable).where(eq(pipelineStagesTable.companyId, companyId));
    await db.delete(notificationsTable).where(eq(notificationsTable.companyId, companyId));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
    await db.delete(teamsTable).where(eq(teamsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%${DOMAIN}`));
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a forced workflow-persistence failure rolls back the matching CRM mutation", () => {
  it("lead create: no lead, no lifecycle activity, no run — and the error is not swallowed", async () => {
    const def = await createDefinition(adminToken, "R lead.created", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const contact = await newContact();
    const title = `B16C1 rolled back ${SUFFIX}`;
    const activitiesBefore = await count(leadActivitiesTable, eq(leadActivitiesTable.companyId, companyId));
    forcePersistFailure();
    await expect(leadsService.createLead(admin, { contactId: contact.id, title, value: 5 })).rejects.toThrow(PERSIST_BOOM);
    expect(await db.select().from(leadsTable).where(and(eq(leadsTable.companyId, companyId), eq(leadsTable.title, title)))).toEqual([]);
    expect(await count(leadActivitiesTable, eq(leadActivitiesTable.companyId, companyId))).toBe(activitiesBefore);
    expect(await runsForDef(def.id)).toEqual([]);
    // with the fault cleared the very same call succeeds (the failure was the injected one, nothing else)
    __setWorkflowDispatchFaultsForTests({});
    captureEnqueueFailures();
    const ok = await leadsService.createLead(admin, { contactId: contact.id, title, value: 5 });
    expect(ok.conflict).toBe(false);
    expect((await runsForDef(def.id)).length).toBe(1);
  });

  it("lead update: field, history rows and activities all roll back with the run", async () => {
    const def = await createDefinition(adminToken, "R lead.updated", { trigger: { type: "lead.updated", config: { fields: ["priority"] } }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await apiLead({ value: 10 });
    const historyBefore = await count(leadHistoryTable, eq(leadHistoryTable.leadId, lead.id));
    const activitiesBefore = await count(leadActivitiesTable, eq(leadActivitiesTable.leadId, lead.id));
    forcePersistFailure();
    await expect(leadsService.updateLead(admin, lead.id, { priority: "high", stage: "qualified" })).rejects.toThrow(PERSIST_BOOM);
    const [fresh] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    expect(fresh.priority).toBeNull();
    expect(fresh.stage).toBe(lead.stage);
    expect(await count(leadHistoryTable, eq(leadHistoryTable.leadId, lead.id))).toBe(historyBefore);
    expect(await count(leadActivitiesTable, eq(leadActivitiesTable.leadId, lead.id))).toBe(activitiesBefore);
    expect(await runsForDef(def.id)).toEqual([]);
  });

  it("lead assignment (manual): owner, history and activity roll back with the run", async () => {
    const def = await createDefinition(adminToken, "R lead.assigned", { trigger: { type: "lead.assigned" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const lead = await apiLead({ value: 10 });
    forcePersistFailure();
    await expect(leadsService.assignLead(admin, lead.id, { assignedToId: emp1Id })).rejects.toThrow(PERSIST_BOOM);
    const [fresh] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    expect(fresh.assignedToId).toBeNull();
    expect(await count(leadHistoryTable, eq(leadHistoryTable.leadId, lead.id))).toBe(0);
    expect(await count(leadActivitiesTable, and(eq(leadActivitiesTable.leadId, lead.id), eq(leadActivitiesTable.type, "assignment")))).toBe(0);
    expect(await runsForDef(def.id)).toEqual([]);
  });

  it("lead assignment (round-robin): the locked rotation joins the boundary and rolls back too", async () => {
    const def = await createDefinition(adminToken, "R round robin", { trigger: { type: "lead.assigned" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const teamRes = await api("POST", "/teams", adminToken, { name: `B16C1 team ${SUFFIX}` });
    expect(teamRes.status, await teamRes.clone().text()).toBe(201);
    const teamId = (await teamRes.json()).id as number;
    const members = await api("POST", `/teams/${teamId}/members`, adminToken, { userIds: [emp1Id] });
    expect(members.status, await members.clone().text()).toBe(200);
    const lead = await apiLead({ value: 10 });
    forcePersistFailure();
    await expect(leadsService.assignLead(admin, lead.id, { strategy: "round_robin", teamId })).rejects.toThrow(PERSIST_BOOM);
    const [fresh] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    expect(fresh.assignedToId).toBeNull();
    expect(fresh.teamId).toBeNull();
    // the rotation cursor advanced inside the same transaction → rolled back as well
    expect(await db.select().from(assignmentCursorsTable).where(and(eq(assignmentCursorsTable.companyId, companyId), eq(assignmentCursorsTable.teamId, teamId)))).toEqual([]);
    expect(await count(leadHistoryTable, eq(leadHistoryTable.leadId, lead.id))).toBe(0);
    expect(await runsForDef(def.id)).toEqual([]);
    // and without the fault the same assignment commits together with its run
    __setWorkflowDispatchFaultsForTests({});
    const seen = captureEnqueueFailures();
    const assigned = await leadsService.assignLead(admin, lead.id, { strategy: "round_robin", teamId });
    expect(assigned.assignedToId).toBe(emp1Id);
    const [cursor] = await db.select().from(assignmentCursorsTable).where(and(eq(assignmentCursorsTable.companyId, companyId), eq(assignmentCursorsTable.teamId, teamId)));
    expect(cursor.position).toBe(1);
    const runs = await runsForDef(def.id);
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ status: "queued", triggerType: "lead.assigned", entityId: lead.id, enqueueGeneration: 1 });
    expect(seen.map((s) => s.id)).toEqual([runs[0].id]);
  });

  it("contact create: no contact, no status history, no run", async () => {
    const def = await createDefinition(adminToken, "R contact.created", { trigger: { type: "contact.created" }, actions: [{ type: "contact.add_tag", config: { tag: "never" } }] });
    const email = `rollback-${SUFFIX}@${DOMAIN}`;
    forcePersistFailure();
    await expect(contactsService.createContact(admin, { firstName: "Ada", lastName: "Lovelace", email, dedupeResolution: "create_separate" })).rejects.toThrow(PERSIST_BOOM);
    expect(await db.select().from(contactsTable).where(and(eq(contactsTable.companyId, companyId), eq(contactsTable.email, email)))).toEqual([]);
    expect(await runsForDef(def.id)).toEqual([]);
  });

  it("contact update: status and run roll back together", async () => {
    const def = await createDefinition(adminToken, "R contact.status", { trigger: { type: "contact.status_changed", config: { toStatus: "won" } }, actions: [{ type: "contact.update_fields", config: { fields: { leadTemperature: "hot" } } }] });
    const contact = await apiContact({ firstName: "Grace", lastName: `Hopper${SUFFIX}`, email: `grace-${SUFFIX}@${DOMAIN}` });
    const historyBefore = await count(contactStatusHistoryTable, eq(contactStatusHistoryTable.contactId, contact.id));
    forcePersistFailure();
    await expect(contactsService.updateContact(admin, contact.id, { status: "won" })).rejects.toThrow(PERSIST_BOOM);
    const [fresh] = await db.select().from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(fresh.status).toBe(contact.status);
    expect(fresh.leadTemperature).toBeNull();
    expect(await count(contactStatusHistoryTable, eq(contactStatusHistoryTable.contactId, contact.id))).toBe(historyBefore);
    expect(await runsForDef(def.id)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("an enqueue failure after the commit leaves durable, recoverable work", () => {
  let recoverableRunId = 0;
  let recoverableLeadId = 0;
  let recoverableDefId = 0;

  it("the mutation and its run are committed before the enqueue is attempted; the enqueue failure is not surfaced", async () => {
    const def = await createDefinition(adminToken, "Q lead.created", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    recoverableDefId = def.id;
    const contact = await newContact();
    const seen = captureEnqueueFailures();
    const out = await leadsService.createLead(admin, { contactId: contact.id, title: `B16C1 queued ${SUFFIX}`, value: 7 });
    expect(out.conflict).toBe(false);
    if (out.conflict) throw new Error("unreachable");
    recoverableLeadId = out.lead.id;
    // the lead is durable
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, out.lead.id));
    expect(lead).toBeTruthy();
    // exactly one run was handed to the enqueue step, and it was ALREADY
    // committed at that moment (visible from another connection)
    expect(seen.length).toBe(1);
    const atEnqueue = await seen[0].visibleAtEnqueue;
    expect(atEnqueue).toMatchObject({ status: "queued", entityType: "lead", entityId: out.lead.id, enqueueGeneration: 1 });
    recoverableRunId = seen[0].id;
    const runs = await runsForDef(def.id);
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ id: recoverableRunId, status: "queued", enqueueGeneration: 1, startedAt: null, completedAt: null });
    const actions = await actionRunsFor(recoverableRunId);
    expect(actions.map((a) => a.status)).toEqual(["pending"]);
    // nothing executed yet
    expect(await leadTagIds(out.lead.id)).toEqual([]);
  });

  it("recovery finds the persisted work and completes it exactly once", async () => {
    // (the definition was archived after the previous test — the captured
    // snapshot/revision on the run is what executes, as in Batch 16)
    const { q, calls } = fakeQueue();
    // within the grace period nothing is touched
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(0);
    await ageRun(recoverableRunId);
    const sweep = await recoverOrphanedWorkflowRuns(q);
    expect(sweep.requeued).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ name: WORKFLOW_RUN_JOB, payload: { runId: recoverableRunId, companyId }, opts: { dedupeKey: `${WORKFLOW_RUN_JOB}:${recoverableRunId}:2` } });
    // the job the recovery enqueued executes the run once
    expect(await executeRun(recoverableRunId, { attempts: 1, maxAttempts: 5 })).toBe("completed");
    expect(await leadTagIds(recoverableLeadId)).toEqual([tagA]);
    // a duplicate delivery of the same job is a no-op (idempotent, no second tag row)
    expect(await executeRun(recoverableRunId, { attempts: 1, maxAttempts: 5 })).toBe("noop");
    expect(await leadTagIds(recoverableLeadId)).toEqual([tagA]);
    const [row] = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, recoverableRunId));
    expect(row.status).toBe("completed");
    expect(row.enqueueGeneration).toBe(2);
    const actions = await actionRunsFor(recoverableRunId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "completed", attempts: 1 });
    // still exactly one run for the definition; a completed run is never recovered again
    expect((await runsForDef(recoverableDefId)).length).toBe(1);
    await ageRun(recoverableRunId);
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(0);
    expect(calls.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("a successful matching mutation cannot exist without its durable run", () => {
  it("through the live API the run row exists the moment the response returns (lead create, stage change, contact create)", async () => {
    const created = await createDefinition(adminToken, "S lead.created", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    const stage = await createDefinition(adminToken, "S stage", { trigger: { type: "lead.stage_changed", config: { toStageKey: "qualified" } }, actions: [{ type: "lead.update_fields", config: { fields: { priority: "stage-hit" } } }] });
    const contactDef = await createDefinition(adminToken, "S contact.created", { trigger: { type: "contact.created" }, actions: [{ type: "contact.add_tag", config: { tag: "auto" } }] });

    const lead = await apiLead({ value: 10 });
    let runs = await runsForDef(created.id);
    expect(runs.filter((r) => r.entityId === lead.id).length).toBe(1);

    expect((await api("PATCH", `/leads/${lead.id}`, adminToken, { stage: "qualified" })).status).toBe(200);
    runs = await runsForDef(stage.id);
    expect(runs.filter((r) => r.entityId === lead.id).length).toBe(1);

    const contact = await apiContact({ firstName: "Linus", lastName: `T${SUFFIX}`, email: `linus-${SUFFIX}@${DOMAIN}` });
    runs = await runsForDef(contactDef.id);
    expect(runs.filter((r) => r.entityId === contact.id).length).toBe(1);

    // and the ordinary path still executes them through the API's queue
    const deadline = Date.now() + 8000;
    let done = false;
    while (Date.now() < deadline && !done) {
      const all = await db.select().from(workflowRunsTable).where(inArray(workflowRunsTable.workflowDefinitionId, [created.id, stage.id, contactDef.id]));
      done = all.length === 3 && all.every((r) => r.status === "completed");
      if (!done) await sleep(100);
    }
    expect(done, "all three runs completed").toBe(true);
    expect(await leadTagIds(lead.id)).toEqual([tagA]);
  });

  it("every run in the tenant points at an entity that exists (no run without its mutation)", async () => {
    const leadRuns = await db.select({ entityId: workflowRunsTable.entityId }).from(workflowRunsTable).where(and(eq(workflowRunsTable.companyId, companyId), eq(workflowRunsTable.entityType, "lead")));
    const contactRuns = await db.select({ entityId: workflowRunsTable.entityId }).from(workflowRunsTable).where(and(eq(workflowRunsTable.companyId, companyId), eq(workflowRunsTable.entityType, "contact")));
    expect(leadRuns.length + contactRuns.length).toBeGreaterThan(0);
    const leadIds = (await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.companyId, companyId))).map((r) => r.id);
    const contactIds = (await db.select({ id: contactsTable.id }).from(contactsTable).where(eq(contactsTable.companyId, companyId))).map((r) => r.id);
    expect(leadRuns.filter((r) => !leadIds.includes(r.entityId))).toEqual([]);
    expect(contactRuns.filter((r) => !contactIds.includes(r.entityId))).toEqual([]);
    // and no run of this tenant belongs to a foreign company's entity
    const foreign = await db.select({ id: workflowRunsTable.id }).from(workflowRunsTable).where(and(eq(workflowRunsTable.companyId, companyId), eq(workflowRunsTable.entityType, "lead"), leadIds.length ? notInArray(workflowRunsTable.entityId, leadIds) : sql`true`));
    expect(foreign).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("committed import batches share the atomic boundary", () => {
  const contactCsv = Buffer.from(`first,email\nImportA,import-a-${SUFFIX}@${DOMAIN}\nImportB,import-b-${SUFFIX}@${DOMAIN}\n`).toString("base64");
  const contactEmails = [`import-a-${SUFFIX}@${DOMAIN}`, `import-b-${SUFFIX}@${DOMAIN}`];
  const leadTitles = [`B16C1 import lead A ${SUFFIX}`, `B16C1 import lead B ${SUFFIX}`];
  const leadCsv = Buffer.from(`title,value\n${leadTitles[0]},10\n${leadTitles[1]},20\n`).toString("base64");

  it("contacts: a persistence failure rolls back the whole batch; otherwise batch + runs commit together and recover", async () => {
    const def = await createDefinition(adminToken, "I contact.created", { trigger: { type: "contact.created" }, actions: [{ type: "contact.add_tag", config: { tag: "imported" } }] });
    forcePersistFailure();
    await expect(importService.commit(admin, { entityType: "contact", file: contactCsv, mapping: { first: "firstName", email: "email" } })).rejects.toThrow(PERSIST_BOOM);
    expect(await db.select().from(contactsTable).where(and(eq(contactsTable.companyId, companyId), inArray(contactsTable.email, contactEmails)))).toEqual([]);
    expect(await runsForDef(def.id)).toEqual([]);

    __setWorkflowDispatchFaultsForTests({});
    const seen = captureEnqueueFailures();
    const result = await importService.commit(admin, { entityType: "contact", file: contactCsv, mapping: { first: "firstName", email: "email" } });
    expect(result).toMatchObject({ imported: 2, skippedErrors: 0, totalRows: 2 });
    const imported = await db.select().from(contactsTable).where(and(eq(contactsTable.companyId, companyId), inArray(contactsTable.email, contactEmails)));
    expect(imported.length).toBe(2);
    const runs = await runsForDef(def.id);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.entityId).sort()).toEqual(imported.map((c) => c.id).sort());
    expect(runs.every((r) => r.status === "queued" && r.enqueueGeneration === 1)).toBe(true);
    expect(seen.length).toBe(2);
    for (const s of seen) expect((await s.visibleAtEnqueue)?.status).toBe("queued"); // committed before enqueue

    // recovery completes both exactly once
    const { q, calls } = fakeQueue();
    for (const r of runs) await ageRun(r.id);
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(2);
    expect(calls.length).toBe(2);
    for (const r of runs) expect(await executeRun(r.id, { attempts: 1, maxAttempts: 5 })).toBe("completed");
    for (const r of runs) expect(await executeRun(r.id, { attempts: 1, maxAttempts: 5 })).toBe("noop");
    const tagged = await db.select().from(contactsTable).where(inArray(contactsTable.id, imported.map((c) => c.id)));
    for (const c of tagged) expect(JSON.parse(c.tags ?? "[]")).toEqual(["imported"]);
    for (const r of runs) await ageRun(r.id);
    expect((await recoverOrphanedWorkflowRuns(q)).requeued).toBe(0);
  });

  it("leads: a persistence failure rolls back the whole batch; otherwise batch + runs commit together", async () => {
    const def = await createDefinition(adminToken, "I lead.created", { trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] });
    forcePersistFailure();
    await expect(importService.commit(admin, { entityType: "lead", file: leadCsv, mapping: { title: "title", value: "value" } })).rejects.toThrow(PERSIST_BOOM);
    expect(await db.select().from(leadsTable).where(and(eq(leadsTable.companyId, companyId), inArray(leadsTable.title, leadTitles)))).toEqual([]);
    expect(await runsForDef(def.id)).toEqual([]);

    __setWorkflowDispatchFaultsForTests({});
    const seen = captureEnqueueFailures();
    const result = await importService.commit(admin, { entityType: "lead", file: leadCsv, mapping: { title: "title", value: "value" } });
    expect(result).toMatchObject({ imported: 2, skippedErrors: 0, totalRows: 2 });
    const imported = await db.select().from(leadsTable).where(and(eq(leadsTable.companyId, companyId), inArray(leadsTable.title, leadTitles)));
    expect(imported.length).toBe(2);
    const runs = await runsForDef(def.id);
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.entityId).sort()).toEqual(imported.map((l) => l.id).sort());
    expect(runs.every((r) => r.status === "queued")).toBe(true);
    expect(seen.length).toBe(2);
    for (const s of seen) expect((await s.visibleAtEnqueue)?.status).toBe("queued");
    for (const l of imported) expect(await leadTagIds(l.id)).toEqual([]); // nothing executed: durable work only
  });
});
