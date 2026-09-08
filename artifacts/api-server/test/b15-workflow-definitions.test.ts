// Batch 15 — Workflow Definitions (persistent definition/API foundation).
// Proves against the live API:
//   1. catalog + validation endpoints (no persistence, no execution)
//   2. create/get/list/update with deterministic action order + normalization
//   3. rejection of invalid names/triggers/conditions/actions/configs/size
//   4. cross-tenant references inside a config are rejected (400, precise path)
//   5. revision-based optimistic concurrency (409 on stale revision)
//   6. lifecycle: draft → published → draft → archived (terminal, read-only),
//      hard delete only for drafts; publishing requires ≥ 1 action
//   7. tenant isolation with a REAL second company (404 on every by-id path)
//   8. RBAC: employee without `workflows` permission cannot read or mutate;
//      `view` unlocks reads/validation only; platform_owner is fenced (403)
//   9. audit rows for create/update/publish/archive without action configs
//  10. definitions never execute anything and never enqueue a job
// All fixtures live in throwaway tenants torn down in afterAll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
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
  pipelineStagesTable,
  workflowDefinitionsTable,
  workflowRunsTable,
  workflowActionRunsTable,
  jobQueueTable,
  loginAttemptsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `b15qa-${SUFFIX}.test`;
const DOMAIN_B = `b15qab-${SUFFIX}.test`;

let platformToken = "";
let companyId = 0;
let companyBId = 0;
let adminToken = "";
let empToken = "";
let adminBToken = "";
let adminId = 0;
let empId = 0;
let adminBId = 0;
let tagA = 0;
let tagB = 0;
let stageKeyA = "";

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

function baseDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: `B15 rule ${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
    description: "Tag and follow up hot leads",
    trigger: { type: "lead.created", config: {} },
    conditions: [
      { field: "value", operator: "greater_than", value: 1000 },
      { field: "source", operator: "in", value: ["event", "referral"] },
    ],
    actions: [
      { type: "lead.add_tag", config: { tagId: tagA } },
      { type: "task.create", config: { title: "Call the new lead", dueInDays: 1, assignee: { kind: "record_owner" } } },
      { type: "notification.create", config: { title: "New hot lead", recipient: { kind: "user", userId: adminId } } },
    ],
    ...overrides,
  };
}

async function createDefinition(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api("POST", "/workflows", token, baseDefinition(overrides));
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: number; revision: number; status: string; actions: Array<{ type: string }>; [k: string]: unknown };
}

// Batch 16 note: published definitions now execute through the workflow engine.
// Before a test asserts "nothing happens", every definition this suite left
// published must be archived (a management action that executes nothing).
async function archiveAllPublished(token: string) {
  const list = await (await api("GET", "/workflows?status=published", token)).json();
  for (const d of list.items as Array<{ id: number; revision: number }>) {
    await api("POST", `/workflows/${d.id}/archive`, token, { revision: d.revision });
  }
}

beforeAll(async () => {
  platformToken = await loginToken(PLATFORM);

  const co = await api("POST", "/companies", platformToken, { name: `B15 QA ${SUFFIX}`, plan: "professional" });
  expect(co.status).toBe(201);
  companyId = (await co.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const mkUser = async (email: string, name: string, role: string, cid: number) => {
    const res = await api("POST", "/users", platformToken, { email, name, role, password: PW, companyId: cid });
    expect(res.status, `create ${email}`).toBe(201);
    return (await res.json()).id as number;
  };
  adminId = await mkUser(`qa-admin@${DOMAIN}`, "B15 Admin", "primary_admin", companyId);
  empId = await mkUser(`qa-emp@${DOMAIN}`, "B15 Employee", "employee", companyId);
  // Deny-by-default: the employee starts with NO workflows permission at all.
  await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, empId));
  adminToken = await loginToken({ email: `qa-admin@${DOMAIN}`, password: PW });
  empToken = await loginToken({ email: `qa-emp@${DOMAIN}`, password: PW });

  const coB = await api("POST", "/companies", platformToken, { name: `B15 QA B ${SUFFIX}`, plan: "professional" });
  expect(coB.status).toBe(201);
  companyBId = (await coB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  adminBId = await mkUser(`qa-admin@${DOMAIN_B}`, "B15 Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: `qa-admin@${DOMAIN_B}`, password: PW });

  const tA = await api("POST", "/tags", adminToken, { name: `b15-hot-${SUFFIX}` });
  expect(tA.status).toBe(201);
  tagA = (await tA.json()).id;
  const tB = await api("POST", "/tags", adminBToken, { name: `b15-foreign-${SUFFIX}` });
  expect(tB.status).toBe(201);
  tagB = (await tB.json()).id;

  const stages = await api("GET", "/pipeline/stages", adminToken);
  expect(stages.status).toBe(200);
  const list = (await stages.json()).stages as Array<{ key: string }>;
  expect(list.length).toBeGreaterThan(0);
  stageKeyA = list[0].key;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.companyId, cid));
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.companyId, cid));
    await db.delete(leadTagsTable).where(eq(leadTagsTable.companyId, cid));
    await db.delete(followUpsTable).where(eq(followUpsTable.companyId, cid));
    await db.delete(tasksTable).where(eq(tasksTable.companyId, cid));
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
describe("catalog + validation endpoints", () => {
  it("GET /workflows/catalog publishes triggers, condition fields/operators, actions, lifecycle and limits", async () => {
    const res = await api("GET", "/workflows/catalog", adminToken);
    expect(res.status).toBe(200);
    const c = await res.json();
    expect(c.schemaVersion).toBe(1);
    expect(c.triggers.map((t: { type: string }) => t.type)).toContain("lead.stage_changed");
    expect(c.conditionOperators.map((o: { operator: string }) => o.operator)).toEqual([
      "equals", "not_equals", "contains", "not_contains", "in", "not_in", "is_empty", "is_not_empty", "greater_than", "less_than",
    ]);
    expect(c.conditionFields.lead.find((f: { key: string }) => f.key === "value").operators).toContain("greater_than");
    expect(c.actions.map((a: { type: string }) => a.type)).toContain("task.create");
    expect(c.actions.find((a: { type: string }) => a.type === "lead.add_tag").configSchema.required).toEqual(["tagId"]);
    expect(c.lifecycle.archived.editable).toBe(false);
    expect(c.limits.maxActions).toBe(20);
    // No AI capability anywhere in the catalog.
    expect(JSON.stringify(c).toLowerCase()).not.toContain("gemini");
  });

  it("POST /workflows/validate reports a valid definition (and does not persist it)", async () => {
    const before = await db.select({ id: workflowDefinitionsTable.id }).from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.companyId, companyId));
    const res = await api("POST", "/workflows/validate", adminToken, baseDefinition());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.publishable).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.normalized.actions[1].config.type).toBe("custom"); // default applied
    const after = await db.select({ id: workflowDefinitionsTable.id }).from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.companyId, companyId));
    expect(after.length).toBe(before.length);
  });

  it("POST /workflows/validate lists every issue with its path (200, valid=false)", async () => {
    const res = await api("POST", "/workflows/validate", adminToken, baseDefinition({
      name: "   ",
      conditions: [{ field: "title", operator: "greater_than", value: 1 }],
      actions: [{ type: "lead.add_tag", config: {} }, { type: "contact.add_tag", config: { tag: "x" } }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.publishable).toBe(false);
    const fields = body.errors.map((e: { field: string }) => e.field);
    expect(fields).toContain("name");
    expect(fields).toContain("conditions[0].operator");
    expect(fields).toContain("actions[0].config.tagId");
    expect(fields).toContain("actions[1].type");
  });

  it("validate rejects a cross-tenant reference with a precise path", async () => {
    const res = await api("POST", "/workflows/validate", adminToken, baseDefinition({ actions: [{ type: "lead.add_tag", config: { tagId: tagB } }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0]).toMatchObject({ field: "actions[0].config.tagId", code: "WORKFLOW_UNKNOWN_REFERENCE" });
  });

  it("validate resolves pipeline stage keys per tenant", async () => {
    const ok = await api("POST", "/workflows/validate", adminToken, baseDefinition({
      trigger: { type: "lead.stage_changed", config: { toStageKey: stageKeyA } },
      actions: [{ type: "lead.update_fields", config: { fields: { stage: stageKeyA, priority: "high" } } }],
    }));
    expect((await ok.json()).valid).toBe(true);
    const bad = await api("POST", "/workflows/validate", adminToken, baseDefinition({
      trigger: { type: "lead.stage_changed", config: { toStageKey: "no_such_stage" } },
    }));
    const body = await bad.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0]).toMatchObject({ field: "trigger.config.toStageKey", code: "WORKFLOW_UNKNOWN_STAGE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("create / get / list / update", () => {
  let id = 0;
  let revision = 0;

  it("creates a valid definition as a draft with revision 1 and normalized configs", async () => {
    const d = await createDefinition(adminToken);
    id = d.id;
    revision = d.revision;
    expect(d.status).toBe("draft");
    expect(d.revision).toBe(1);
    expect(d.companyId).toBe(companyId);
    expect(d.schemaVersion).toBe(1);
    expect(d.archivedAt).toBeNull();
    expect(d.createdById).toBe(adminId);
    expect(d.actions.map((a) => a.type)).toEqual(["lead.add_tag", "task.create", "notification.create"]);
    expect((d.actions[1] as { config: { type: string } }).config.type).toBe("custom");
  });

  it("retrieves the definition with the same deterministic action order", async () => {
    const res = await api("GET", `/workflows/${id}`, adminToken);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.id).toBe(id);
    expect(d.actions.map((a: { type: string }) => a.type)).toEqual(["lead.add_tag", "task.create", "notification.create"]);
    expect(d.conditions).toEqual([
      { field: "value", operator: "greater_than", value: 1000 },
      { field: "source", operator: "in", value: ["event", "referral"] },
    ]);
  });

  it("preserves a long, deliberately shuffled action order end-to-end", async () => {
    const types = ["notification.create", "lead.add_tag", "task.create", "lead.remove_tag", "email.send", "lead.update_fields", "follow_up.create", "lead.add_tag"];
    const actions = types.map((type, i) => {
      switch (type) {
        case "lead.add_tag":
        case "lead.remove_tag":
          return { type, config: { tagId: tagA } };
        case "task.create":
          return { type, config: { title: `Task ${i}`, assignee: { kind: "actor" } } };
        case "notification.create":
          return { type, config: { title: `Notify ${i}`, recipient: { kind: "record_owner" } } };
        case "email.send":
          return { type, config: { to: { kind: "contact" }, subject: `Subject ${i}`, body: "Hello" } };
        case "lead.update_fields":
          return { type, config: { fields: { priority: `p${i}` } } };
        default:
          return { type, config: { scheduleInDays: i } };
      }
    });
    const d = await createDefinition(adminToken, { actions });
    expect(d.actions.map((a) => a.type)).toEqual(types);
    const again = await (await api("GET", `/workflows/${d.id}`, adminToken)).json();
    expect(again.actions.map((a: { type: string }) => a.type)).toEqual(types);
    expect(again.actions[2].config.title).toBe("Task 2");
  });

  it("lists the company's definitions (archived excluded by default) with the list envelope", async () => {
    const res = await api("GET", "/workflows", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.items.map((d: { id: number }) => d.id)).toContain(id);
    expect(body.items.every((d: { companyId: number }) => d.companyId === companyId)).toBe(true);
    const filtered = await (await api("GET", "/workflows?status=published", adminToken)).json();
    expect(filtered.items.map((d: { id: number }) => d.id)).not.toContain(id);
    const paged = await (await api("GET", "/workflows?page=1&pageSize=1", adminToken)).json();
    expect(paged.items.length).toBe(1);
    expect(paged.pageSize).toBe(1);
    const bad = await api("GET", "/workflows?status=running", adminToken);
    expect(bad.status).toBe(400);
  });

  it("updates with the current revision and increments it", async () => {
    const res = await api("PATCH", `/workflows/${id}`, adminToken, {
      revision,
      name: `B15 renamed ${SUFFIX}`,
      actions: [{ type: "lead.update_fields", config: { fields: { priority: "high" } } }],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const d = await res.json();
    expect(d.revision).toBe(revision + 1);
    expect(d.name).toBe(`B15 renamed ${SUFFIX}`);
    expect(d.actions).toEqual([{ type: "lead.update_fields", config: { fields: { priority: "high" } } }]);
    expect(d.updatedById).toBe(adminId);
    // trigger/conditions untouched by a partial update
    expect(d.trigger).toEqual({ type: "lead.created", config: {} });
    expect(d.conditions.length).toBe(2);
    revision = d.revision;
  });

  it("rejects a stale revision with 409 WORKFLOW_REVISION_CONFLICT and the current revision", async () => {
    const res = await api("PATCH", `/workflows/${id}`, adminToken, { revision: revision - 1, name: "stale edit" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("WORKFLOW_REVISION_CONFLICT");
    expect(body.context.currentRevision).toBe(revision);
    const current = await (await api("GET", `/workflows/${id}`, adminToken)).json();
    expect(current.name).toBe(`B15 renamed ${SUFFIX}`);
    expect(current.revision).toBe(revision);
  });

  it("requires the revision on update", async () => {
    const res = await api("PATCH", `/workflows/${id}`, adminToken, { name: "no revision" });
    expect(res.status).toBe(400);
  });

  it("rejects an update that makes the merged definition invalid (entity mismatch after trigger change)", async () => {
    const res = await api("PATCH", `/workflows/${id}`, adminToken, { revision, trigger: { type: "contact.created" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WORKFLOW_INVALID");
    // Both the lead-only conditions and the lead-only action are reported against the new entity.
    const fields = body.details.map((d: { field: string }) => d.field);
    expect(fields).toContain("conditions[0].field");
    expect(fields).toContain("actions[0].type");
    // Nothing was persisted.
    const current = await (await api("GET", `/workflows/${id}`, adminToken)).json();
    expect(current.trigger.type).toBe("lead.created");
    expect(current.revision).toBe(revision);
  });

  it("enforces unique names among non-archived definitions (409)", async () => {
    const res = await api("POST", "/workflows", adminToken, baseDefinition({ name: `b15 RENAMED ${SUFFIX}` }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKFLOW_NAME_TAKEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("rejections on create", () => {
  const expect400 = async (overrides: Record<string, unknown>, field?: string) => {
    const res = await api("POST", "/workflows", adminToken, baseDefinition(overrides));
    expect(res.status, JSON.stringify(overrides).slice(0, 200)).toBe(400);
    const body = await res.json();
    if (field) expect(body.details.map((d: { field: string }) => d.field), JSON.stringify(body.details)).toContain(field);
    return body;
  };

  it("rejects empty / whitespace / over-long names", async () => {
    await expect400({ name: "" }, "name");
    await expect400({ name: "   " }, "name");
    await expect400({ name: "x".repeat(121) }, "name");
  });

  it("rejects a missing trigger and an unsupported trigger type", async () => {
    const res = await api("POST", "/workflows", adminToken, { name: "no trigger", actions: [] });
    expect(res.status).toBe(400);
    await expect400({ trigger: { type: "lead.deleted", config: {} } });
    await expect400({ trigger: { type: "lead.created", config: { cron: "* * * * *" } } }, "trigger.config");
  });

  it("rejects malformed conditions and unsupported operators", async () => {
    await expect400({ conditions: [{ field: "value", operator: "matches", value: "x" }] });
    await expect400({ conditions: [{ field: "unknownField", operator: "equals", value: "x" }] }, "conditions[0].field");
    await expect400({ conditions: [{ field: "title", operator: "greater_than", value: 1 }] }, "conditions[0].operator");
    await expect400({ conditions: [{ field: "value", operator: "in", value: "not-a-list" }] }, "conditions[0].value");
    await expect400({ conditions: [{ field: "assignedToId", operator: "is_empty", value: 3 }] }, "conditions[0].value");
  });

  it("rejects unsupported action types, entity mismatches and malformed configs", async () => {
    await expect400({ actions: [{ type: "lead.delete", config: {} }] });
    await expect400({ trigger: { type: "contact.created" }, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] }, "actions[0].type");
    await expect400({ actions: [{ type: "lead.add_tag", config: {} }] }, "actions[0].config.tagId");
    await expect400({ actions: [{ type: "lead.add_tag", config: { tagId: tagA, then: "exec()" } }] }, "actions[0].config");
    await expect400({ actions: [{ type: "task.create", config: { title: "x", assignee: { kind: "user" } } }] }, "actions[0].config.assignee.userId");
    await expect400({ actions: [{ type: "lead.assign_owner", config: { strategy: "ai" } }] }, "actions[0].config.strategy");
    await expect400({ actions: [{ type: "email.send", config: { to: { kind: "contact" }, subject: "s", body: "b", smtpPassword: "x" } }] }, "actions[0].config");
  });

  it("rejects a cross-tenant tag / user reference on create (400, not silently stored)", async () => {
    const body = await expect400({ actions: [{ type: "lead.add_tag", config: { tagId: tagB } }] }, "actions[0].config.tagId");
    expect(body.details[0].code).toBe("WORKFLOW_UNKNOWN_REFERENCE");
    await expect400({ actions: [{ type: "notification.create", config: { title: "t", recipient: { kind: "user", userId: adminBId } } }] }, "actions[0].config.recipient.userId");
  });

  it("rejects an oversized definition", async () => {
    const body = await expect400({ actions: [{ type: "email.send", config: { to: { kind: "actor" }, subject: "s", body: "x".repeat(40_000) } }] }, "(body)");
    expect(body.details[0].code).toBe("WORKFLOW_TOO_LARGE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("lifecycle", () => {
  let id = 0;
  let revision = 0;

  beforeAll(async () => {
    const d = await createDefinition(adminToken);
    id = d.id;
    revision = d.revision;
  });

  it("cannot publish a draft without actions", async () => {
    const empty = await createDefinition(adminToken, { actions: [] });
    const res = await api("POST", `/workflows/${empty.id}/publish`, adminToken, { revision: empty.revision });
    expect(res.status).toBe(400);
    expect((await res.json()).details[0].code).toBe("WORKFLOW_NO_ACTIONS");
    const stored = await (await api("POST", `/workflows/${empty.id}/validate`, adminToken)).json();
    expect(stored.valid).toBe(true);
    expect(stored.publishable).toBe(false);
  });

  it("publishes a draft (revision bump), refuses to publish twice, and the published definition is immutable", async () => {
    const res = await api("POST", `/workflows/${id}/publish`, adminToken, { revision });
    expect(res.status, await res.clone().text()).toBe(200);
    const d = await res.json();
    expect(d.status).toBe("published");
    expect(d.revision).toBe(revision + 1);
    revision = d.revision;
    const again = await api("POST", `/workflows/${id}/publish`, adminToken, { revision });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("WORKFLOW_INVALID_TRANSITION");
    const edit = await api("PATCH", `/workflows/${id}`, adminToken, { revision, description: "edited while published" });
    expect(edit.status).toBe(409);
    expect((await edit.json()).code).toBe("WORKFLOW_READ_ONLY");
  });

  it("refuses a lifecycle change with a stale revision", async () => {
    const res = await api("POST", `/workflows/${id}/unpublish`, adminToken, { revision: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKFLOW_REVISION_CONFLICT");
  });

  it("unpublishes back to draft, then archives (terminal: read-only, not deletable, not publishable)", async () => {
    const un = await api("POST", `/workflows/${id}/unpublish`, adminToken, { revision });
    expect(un.status).toBe(200);
    const d1 = await un.json();
    expect(d1.status).toBe("draft");
    revision = d1.revision;

    const ar = await api("POST", `/workflows/${id}/archive`, adminToken, { revision });
    expect(ar.status).toBe(200);
    const d2 = await ar.json();
    expect(d2.status).toBe("archived");
    expect(d2.archivedAt).not.toBeNull();
    revision = d2.revision;

    expect((await api("PATCH", `/workflows/${id}`, adminToken, { revision, name: "edit archived" })).status).toBe(409);
    expect((await api("POST", `/workflows/${id}/publish`, adminToken, { revision })).status).toBe(409);
    expect((await api("POST", `/workflows/${id}/unpublish`, adminToken, { revision })).status).toBe(409);
    const del = await api("DELETE", `/workflows/${id}`, adminToken, { revision: revision });
    expect(del.status).toBe(409);
    expect((await del.json()).code).toBe("WORKFLOW_NOT_DELETABLE");

    // Archived rows are hidden by default and visible on request.
    const list = await (await api("GET", "/workflows", adminToken)).json();
    expect(list.items.map((x: { id: number }) => x.id)).not.toContain(id);
    const all = await (await api("GET", "/workflows?includeArchived=true", adminToken)).json();
    expect(all.items.map((x: { id: number }) => x.id)).toContain(id);
    expect((await api("GET", `/workflows/${id}`, adminToken)).status).toBe(200);
  });

  it("archiving frees the name for a new definition", async () => {
    const archived = await (await api("GET", `/workflows/${id}`, adminToken)).json();
    const res = await api("POST", "/workflows", adminToken, baseDefinition({ name: archived.name }));
    expect(res.status).toBe(201);
  });

  it("hard-deletes a draft only (with its current revision)", async () => {
    const draft = await createDefinition(adminToken);
    const del = await api("DELETE", `/workflows/${draft.id}`, adminToken, { revision: draft.revision });
    expect(del.status).toBe(200);
    expect((await api("GET", `/workflows/${draft.id}`, adminToken)).status).toBe(404);
    const published = await createDefinition(adminToken);
    const pub = await api("POST", `/workflows/${published.id}/publish`, adminToken, { revision: published.revision });
    expect(pub.status).toBe(200);
    const pubRev = (await pub.json()).revision;
    expect((await api("DELETE", `/workflows/${published.id}`, adminToken, { revision: pubRev })).status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tenant isolation (real second company)", () => {
  let idA = 0;
  let revA = 0;

  beforeAll(async () => {
    const d = await createDefinition(adminToken);
    idA = d.id;
    revA = d.revision;
  });

  it("company B cannot list company A's definitions", async () => {
    const res = await api("GET", "/workflows?includeArchived=true", adminBToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((d: { id: number }) => d.id)).not.toContain(idA);
    expect(body.items.every((d: { companyId: number }) => d.companyId === companyBId)).toBe(true);
  });

  it("company B gets 404 on read, validate-by-id, update, lifecycle and delete of A's definition", async () => {
    expect((await api("GET", `/workflows/${idA}`, adminBToken)).status).toBe(404);
    expect((await api("POST", `/workflows/${idA}/validate`, adminBToken)).status).toBe(404);
    expect((await api("PATCH", `/workflows/${idA}`, adminBToken, { revision: revA, name: "hijack" })).status).toBe(404);
    expect((await api("POST", `/workflows/${idA}/publish`, adminBToken, { revision: revA })).status).toBe(404);
    expect((await api("POST", `/workflows/${idA}/archive`, adminBToken, { revision: revA })).status).toBe(404);
    expect((await api("DELETE", `/workflows/${idA}`, adminBToken, { revision: revA })).status).toBe(404);
    // Without a body the request fails validation (400) before any lookup — the same
    // answer for a foreign or an own id, so it leaks nothing either.
    expect((await api("DELETE", `/workflows/${idA}`, adminBToken)).status).toBe(400);
    // Nothing changed.
    const d = await (await api("GET", `/workflows/${idA}`, adminToken)).json();
    expect(d.status).toBe("draft");
    expect(d.revision).toBe(revA);
    expect(d.name).not.toBe("hijack");
  });

  it("company B cannot reference A's records inside its own definition", async () => {
    const res = await api("POST", "/workflows", adminBToken, baseDefinition({ actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).details[0].code).toBe("WORKFLOW_UNKNOWN_REFERENCE");
  });

  it("a company B definition is scoped to company B (server-derived, never client-supplied)", async () => {
    const res = await api("POST", "/workflows", adminBToken, { ...baseDefinition({ actions: [{ type: "lead.add_tag", config: { tagId: tagB } }] }), companyId });
    // Unknown top-level keys are ignored by the body contract; the tenant is the caller's.
    expect(res.status, await res.clone().text()).toBe(201);
    const d = await res.json();
    expect(d.companyId).toBe(companyBId);
    expect((await api("GET", `/workflows/${d.id}`, adminToken)).status).toBe(404);
  });

  it("platform_owner is fenced off customer workflow data (403)", async () => {
    expect((await api("GET", "/workflows", platformToken)).status).toBe(403);
    expect((await api("GET", "/workflows/catalog", platformToken)).status).toBe(403);
    expect((await api("GET", `/workflows/${idA}`, platformToken)).status).toBe(403);
    expect((await api("POST", "/workflows", platformToken, baseDefinition())).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("RBAC (workflows.view / workflows.manage)", () => {
  let idA = 0;
  let revA = 0;

  beforeAll(async () => {
    const d = await createDefinition(adminToken);
    idA = d.id;
    revA = d.revision;
  });

  it("an employee without the workflows permission can neither read nor mutate", async () => {
    expect((await api("GET", "/workflows", empToken)).status).toBe(403);
    expect((await api("GET", "/workflows/catalog", empToken)).status).toBe(403);
    expect((await api("GET", `/workflows/${idA}`, empToken)).status).toBe(403);
    expect((await api("POST", "/workflows/validate", empToken, baseDefinition())).status).toBe(403);
    expect((await api("POST", "/workflows", empToken, baseDefinition())).status).toBe(403);
    expect((await api("PATCH", `/workflows/${idA}`, empToken, { revision: revA, name: "x" })).status).toBe(403);
    expect((await api("POST", `/workflows/${idA}/publish`, empToken, { revision: revA })).status).toBe(403);
    expect((await api("DELETE", `/workflows/${idA}`, empToken, { revision: revA })).status).toBe(403);
  });

  it("workflows.view unlocks reads + validation but no mutation; workflows.manage unlocks mutation", async () => {
    await db.update(usersTable).set({ permissions: { workflows: ["view"] } }).where(eq(usersTable.id, empId));
    try {
      expect((await api("GET", "/workflows", empToken)).status).toBe(200);
      expect((await api("GET", "/workflows/catalog", empToken)).status).toBe(200);
      expect((await api("GET", `/workflows/${idA}`, empToken)).status).toBe(200);
      expect((await api("POST", "/workflows/validate", empToken, baseDefinition())).status).toBe(200);
      expect((await api("POST", `/workflows/${idA}/validate`, empToken)).status).toBe(200);
      expect((await api("POST", "/workflows", empToken, baseDefinition())).status).toBe(403);
      expect((await api("PATCH", `/workflows/${idA}`, empToken, { revision: revA, name: "x" })).status).toBe(403);
      expect((await api("POST", `/workflows/${idA}/archive`, empToken, { revision: revA })).status).toBe(403);
      expect((await api("DELETE", `/workflows/${idA}`, empToken, { revision: revA })).status).toBe(403);

      await db.update(usersTable).set({ permissions: { workflows: ["view", "manage"] } }).where(eq(usersTable.id, empId));
      const created = await api("POST", "/workflows", empToken, baseDefinition());
      expect(created.status).toBe(201);
      expect((await created.json()).createdById).toBe(empId);
    } finally {
      await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, empId));
    }
    // The unauthorized attempts changed nothing.
    const d = await (await api("GET", `/workflows/${idA}`, adminToken)).json();
    expect(d.revision).toBe(revA);
    expect(d.status).toBe("draft");
  });

  it("the workflows module is part of the RBAC catalog with separated read/mutation actions", async () => {
    const res = await api("GET", "/rbac/permissions", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const catalog = (body.catalog ?? body.modules ?? body) as Record<string, { actions: string[] }> | Array<{ module?: string; key?: string; actions: string[] }>;
    const entry = Array.isArray(catalog)
      ? catalog.find((m) => (m.module ?? m.key) === "workflows")
      : catalog.workflows;
    expect(entry, JSON.stringify(body).slice(0, 300)).toBeTruthy();
    expect(entry!.actions).toEqual(["view", "manage"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("auditability", () => {
  it("records create/update/publish/archive with shallow metadata and never the action configs", async () => {
    const d = await createDefinition(adminToken);
    let rev = d.revision;
    const upd = await api("PATCH", `/workflows/${d.id}`, adminToken, { revision: rev, description: "audited edit" });
    rev = (await upd.json()).revision;
    const pub = await api("POST", `/workflows/${d.id}/publish`, adminToken, { revision: rev });
    rev = (await pub.json()).revision;
    const arc = await api("POST", `/workflows/${d.id}/archive`, adminToken, { revision: rev });
    expect(arc.status).toBe(200);

    const rows = await db
      .select()
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.entityType, "workflow_definition"), eq(auditLogsTable.entityId, String(d.id))));
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(["workflow.archive", "workflow.create", "workflow.publish", "workflow.update"]);
    for (const r of rows) {
      expect(r.companyId).toBe(companyId);
      expect(r.userId).toBe(adminId);
      const meta = JSON.stringify(r.metadata ?? {});
      expect(meta).toContain('"triggerType":"lead.created"');
      expect(meta).not.toContain("config");
      expect(meta).not.toContain("recipient");
      expect(meta).not.toContain("Call the new lead");
    }
    const archive = rows.find((r) => r.action === "workflow.archive")!;
    expect(archive.metadata).toMatchObject({ from: "published", to: "archived" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("correction 1 — published definitions are immutable", () => {
  it("draft → publish → PATCH rejected (row unchanged) → unpublish → PATCH ok → republish", async () => {
    // 1. create draft
    const d = await createDefinition(adminToken, { description: "before publish" });
    expect(d.status).toBe("draft");
    // 2. publish it
    const pub = await api("POST", `/workflows/${d.id}/publish`, adminToken, { revision: d.revision });
    expect(pub.status).toBe(200);
    const published = await pub.json();
    expect(published.status).toBe("published");
    const publishedRevision = published.revision as number;
    // 3. PATCH while published is rejected with the lifecycle read-only error …
    for (const patch of [
      { revision: publishedRevision, description: "edited while published" },
      { revision: publishedRevision, name: `B15 immutable ${SUFFIX}` },
      { revision: publishedRevision, actions: [{ type: "lead.add_tag", config: { tagId: tagA } }] },
      { revision: publishedRevision - 1, description: "stale AND published" },
    ]) {
      const res = await api("PATCH", `/workflows/${d.id}`, adminToken, patch);
      expect(res.status, JSON.stringify(patch)).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("WORKFLOW_READ_ONLY");
      expect(body.context.status).toBe("published");
    }
    // 4. … and the row + revision are unchanged
    const unchanged = await (await api("GET", `/workflows/${d.id}`, adminToken)).json();
    expect(unchanged.status).toBe("published");
    expect(unchanged.revision).toBe(publishedRevision);
    expect(unchanged.description).toBe("before publish");
    expect(unchanged.name).toBe(d.name);
    expect(unchanged.actions.map((a: { type: string }) => a.type)).toEqual(["lead.add_tag", "task.create", "notification.create"]);
    const [row] = await db.select().from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.id, d.id));
    expect(row.revision).toBe(publishedRevision);
    expect(row.status).toBe("published");
    // 5. unpublish with the current revision succeeds
    const un = await api("POST", `/workflows/${d.id}/unpublish`, adminToken, { revision: publishedRevision });
    expect(un.status).toBe(200);
    const draft = await un.json();
    expect(draft.status).toBe("draft");
    expect(draft.revision).toBe(publishedRevision + 1);
    // 6. PATCH as draft succeeds
    const edit = await api("PATCH", `/workflows/${d.id}`, adminToken, { revision: draft.revision, description: "edited as draft" });
    expect(edit.status, await edit.clone().text()).toBe(200);
    const edited = await edit.json();
    expect(edited.description).toBe("edited as draft");
    expect(edited.revision).toBe(draft.revision + 1);
    // 7. republish succeeds (explicit publish boundary crossed again)
    const re = await api("POST", `/workflows/${d.id}/publish`, adminToken, { revision: edited.revision });
    expect(re.status).toBe(200);
    const republished = await re.json();
    expect(republished.status).toBe("published");
    expect(republished.description).toBe("edited as draft");
    expect(republished.revision).toBe(edited.revision + 1);
  });

  it("the catalog documents published as non-editable and non-deletable", async () => {
    const c = await (await api("GET", "/workflows/catalog", adminToken)).json();
    expect(c.lifecycle.published.editable).toBe(false);
    expect(c.lifecycle.published.deletable).toBe(false);
    expect(c.lifecycle.published.transitions).toEqual(["draft", "archived"]);
    expect(c.lifecycle.draft.editable).toBe(true);
    expect(c.lifecycle.draft.deletable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("correction 2 — revision-safe draft DELETE", () => {
  it("rejects a missing or invalid revision (400) and leaves the draft in place", async () => {
    const d = await createDefinition(adminToken);
    const bodies: Array<unknown> = [undefined, {}, { revision: null }, { revision: "abc" }, { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { other: 1 }];
    for (const body of bodies) {
      const res = await api("DELETE", `/workflows/${d.id}`, adminToken, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const err = await res.json();
      expect(typeof err.error, JSON.stringify(body)).toBe("string");
      if (err.code) expect(err.code, JSON.stringify(body)).toBe("WORKFLOW_REVISION_REQUIRED");
    }
    const still = await (await api("GET", `/workflows/${d.id}`, adminToken)).json();
    expect(still.revision).toBe(d.revision);
    expect(still.status).toBe("draft");
  });

  it("a stale revision cannot delete a draft another user has updated; the row is untouched", async () => {
    const d = await createDefinition(adminToken);
    const staleRevision = d.revision;
    // Someone else edits the draft first (revision moves on).
    const edit = await api("PATCH", `/workflows/${d.id}`, adminToken, { revision: d.revision, description: "updated by a colleague" });
    expect(edit.status).toBe(200);
    const current = (await edit.json()).revision as number;
    expect(current).toBe(staleRevision + 1);
    // Stale client tries to delete.
    const res = await api("DELETE", `/workflows/${d.id}`, adminToken, { revision: staleRevision });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("WORKFLOW_REVISION_CONFLICT");
    expect(body.context.currentRevision).toBe(current);
    // Row unchanged.
    const [row] = await db.select().from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.id, d.id));
    expect(row).toBeTruthy();
    expect(row.revision).toBe(current);
    expect(row.status).toBe("draft");
    expect(row.description).toBe("updated by a colleague");
    // No delete audit row was written for the refused attempt.
    const audits = await db
      .select({ action: auditLogsTable.action })
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.entityType, "workflow_definition"), eq(auditLogsTable.entityId, String(d.id)), eq(auditLogsTable.action, "workflow.delete")));
    expect(audits.length).toBe(0);
    // The current revision deletes it.
    const ok = await api("DELETE", `/workflows/${d.id}`, adminToken, { revision: current });
    expect(ok.status).toBe(200);
    expect((await ok.json()).success).toBe(true);
    expect((await api("GET", `/workflows/${d.id}`, adminToken)).status).toBe(404);
    const gone = await db.select({ id: workflowDefinitionsTable.id }).from(workflowDefinitionsTable).where(eq(workflowDefinitionsTable.id, d.id));
    expect(gone.length).toBe(0);
    const deleted = await db
      .select({ metadata: auditLogsTable.metadata })
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.entityType, "workflow_definition"), eq(auditLogsTable.entityId, String(d.id)), eq(auditLogsTable.action, "workflow.delete")));
    expect(deleted.length).toBe(1);
    expect(deleted[0].metadata).toMatchObject({ name: d.name, revision: current });
  });

  it("cross-tenant delete still answers 404 with or without a revision, and the row survives", async () => {
    const d = await createDefinition(adminToken);
    expect((await api("DELETE", `/workflows/${d.id}`, adminBToken, { revision: d.revision })).status).toBe(404);
    expect((await api("DELETE", `/workflows/${d.id}`, adminBToken, { revision: 999 })).status).toBe(404); // 404 wins over a wrong revision
    expect((await api("DELETE", `/workflows/${d.id}`, adminBToken)).status).toBe(400); // body validation, identical for any id
    expect((await api("GET", `/workflows/${d.id}`, adminToken)).status).toBe(200);
  });

  it("published and archived definitions still cannot be deleted even with the current revision", async () => {
    const d = await createDefinition(adminToken);
    const pub = await (await api("POST", `/workflows/${d.id}/publish`, adminToken, { revision: d.revision })).json();
    let res = await api("DELETE", `/workflows/${d.id}`, adminToken, { revision: pub.revision });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKFLOW_NOT_DELETABLE");
    const arc = await (await api("POST", `/workflows/${d.id}/archive`, adminToken, { revision: pub.revision })).json();
    expect(arc.status).toBe("archived");
    res = await api("DELETE", `/workflows/${d.id}`, adminToken, { revision: arc.revision });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKFLOW_NOT_DELETABLE");
    expect((await api("GET", `/workflows/${d.id}`, adminToken)).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("definitions never execute and never enqueue", () => {
  it("full CRUD + lifecycle of a definition enqueues no background job", async () => {
    const d = await createDefinition(adminToken);
    let rev = d.revision;
    rev = (await (await api("PATCH", `/workflows/${d.id}`, adminToken, { revision: rev, description: "x" })).json()).revision;
    await api("POST", "/workflows/validate", adminToken, baseDefinition());
    await api("POST", `/workflows/${d.id}/validate`, adminToken);
    rev = (await (await api("POST", `/workflows/${d.id}/publish`, adminToken, { revision: rev })).json()).revision;
    rev = (await (await api("POST", `/workflows/${d.id}/unpublish`, adminToken, { revision: rev })).json()).revision;
    await api("GET", "/workflows", adminToken);
    await api("GET", "/workflows/catalog", adminToken);
    rev = (await (await api("POST", `/workflows/${d.id}/archive`, adminToken, { revision: rev })).json()).revision;
    expect(rev).toBeGreaterThan(d.revision);

    // Deterministic, resource-attributable proof — never a server-wide counter
    // (concurrent suites legitimately enqueue jobs of their own). The engine's
    // durability boundary (src/lib/workflows/dispatch.ts) enqueues a `workflow.run`
    // job ONLY for a committed workflow_runs row, keyed `workflow.run:<runId>:<gen>`,
    // so a definition that owns no run rows has executed nothing and owns no job.
    const runs = await db
      .select({ id: workflowRunsTable.id, generation: workflowRunsTable.enqueueGeneration })
      .from(workflowRunsTable)
      .where(eq(workflowRunsTable.workflowDefinitionId, d.id));
    expect(runs).toEqual([]);
    const actionRows = await db
      .select({ id: workflowActionRunsTable.id })
      .from(workflowActionRunsTable)
      .innerJoin(workflowRunsTable, eq(workflowActionRunsTable.runId, workflowRunsTable.id))
      .where(eq(workflowRunsTable.workflowDefinitionId, d.id));
    expect(actionRows).toEqual([]);
    const jobKeys = runs.map((r) => `workflow.run:${r.id}:${r.generation}`);
    const jobs = await db
      .select({ id: jobQueueTable.id })
      .from(jobQueueTable)
      .where(inArray(jobQueueTable.dedupeKey, jobKeys.length ? jobKeys : ["-"]));
    expect(jobs).toEqual([]);
    // The tenant-facing run history for this definition is empty as well.
    const history = await (await api("GET", `/workflows/runs?workflowDefinitionId=${d.id}&pageSize=100`, adminToken)).json();
    expect(history.items).toEqual([]);
  });

  // Batch 16 note: published definitions now EXECUTE through the workflow engine
  // (covered by test/b16-workflow-engine.test.ts). The Batch 15 guarantee that
  // survives is that a definition which is not published — a draft — never
  // executes and never touches CRM data when its trigger event happens.
  it("a DRAFT definition does nothing when its trigger event happens (no tag, task, follow-up, notification, activity)", async () => {
    await archiveAllPublished(adminToken);
    const d = await createDefinition(adminToken, {
      trigger: { type: "lead.created", config: {} },
      conditions: [],
      actions: [
        { type: "lead.add_tag", config: { tagId: tagA } },
        { type: "task.create", config: { title: `B15 must-not-exist ${SUFFIX}`, assignee: { kind: "user", userId: adminId } } },
        { type: "follow_up.create", config: { scheduleInDays: 1, assignee: { kind: "user", userId: adminId } } },
        { type: "notification.create", config: { title: `B15 must-not-notify ${SUFFIX}`, recipient: { kind: "user", userId: adminId } } },
        { type: "lead.update_fields", config: { fields: { priority: "b15-must-not-apply" } } },
      ],
    });
    expect(d.status).toBe("draft"); // deliberately NOT published

    const [contact] = await db.insert(contactsTable).values({ companyId, fullName: "B15 Trigger Contact", contactCompany: "Acme" }).returning({ id: contactsTable.id });
    const tasksBefore = (await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.companyId, companyId))).length;
    const followUpsBefore = (await db.select({ id: followUpsTable.id }).from(followUpsTable).where(eq(followUpsTable.companyId, companyId))).length;
    const notifsBefore = (await db.select({ id: notificationsTable.id }).from(notificationsTable).where(eq(notificationsTable.userId, adminId))).length;

    // The real trigger event: a lead is created through the existing CRM endpoint.
    const res = await api("POST", "/leads", adminToken, { contactId: contact.id, title: "B15 trigger lead", value: 5000, source: "event" });
    expect(res.status, await res.clone().text()).toBe(201);
    const lead = await res.json();
    await new Promise((r) => setTimeout(r, 750)); // give any (non-existent) async path a chance to run

    const tags = await (await api("GET", `/leads/${lead.id}/tags`, adminToken)).json();
    expect((tags.tags ?? tags).length ?? 0).toBe(0);
    const fresh = await (await api("GET", `/leads/${lead.id}`, adminToken)).json();
    expect(fresh.priority ?? null).not.toBe("b15-must-not-apply");
    const tasksAfter = (await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.companyId, companyId))).length;
    const followUpsAfter = (await db.select({ id: followUpsTable.id }).from(followUpsTable).where(eq(followUpsTable.companyId, companyId))).length;
    const notifsAfter = (await db.select({ id: notificationsTable.id }).from(notificationsTable).where(eq(notificationsTable.userId, adminId))).length;
    expect(tasksAfter).toBe(tasksBefore);
    expect(followUpsAfter).toBe(followUpsBefore);
    expect(notifsAfter).toBe(notifsBefore);
    const mustNot = await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.title, `B15 must-not-exist ${SUFFIX}`));
    expect(mustNot.length).toBe(0);
    // The definition itself is untouched by the event, and no run was recorded for it.
    const stored = await (await api("GET", `/workflows/${d.id}`, adminToken)).json();
    expect(stored.status).toBe("draft");
    expect(stored.revision).toBe(d.revision);
    const runs = await (await api("GET", `/workflows/runs?workflowDefinitionId=${d.id}`, adminToken)).json();
    expect(runs.items.length).toBe(0);
    // No activity/run trace references the definition.
    const activities = await db.select({ id: leadActivitiesTable.id, type: leadActivitiesTable.type }).from(leadActivitiesTable).where(inArray(leadActivitiesTable.leadId, [lead.id]));
    expect(activities.map((a) => a.type)).not.toContain("workflow");
  });

  it("no execution/run/history/retry/job endpoint exists under /workflows", async () => {
    const d = await createDefinition(adminToken);
    for (const path of [`/workflows/${d.id}/execute`, `/workflows/${d.id}/run`, `/workflows/${d.id}/test`, `/workflows/${d.id}/runs`, `/workflows/${d.id}/retry`, `/workflows/runs`, `/workflows/jobs`]) {
      const res = await api("POST", path, adminToken, {});
      expect([404, 405], path).toContain(res.status);
    }
  });
});
