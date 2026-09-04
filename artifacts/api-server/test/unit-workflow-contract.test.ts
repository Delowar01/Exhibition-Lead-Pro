import { describe, it, expect } from "vitest";
import { CreateWorkflowDefinitionBody, UpdateContactBody, CreateTaskBody, AssignLeadBody } from "@workspace/api-zod";
import {
  ACTION_TYPES,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CONTACT_STATUSES,
  LEAD_ASSIGNMENT_STRATEGIES,
  OPERATORS_BY_FIELD_TYPE,
  TASK_TYPES,
  TRIGGER_TYPES,
  WORKFLOW_ACTIONS,
  WORKFLOW_LIFECYCLE,
  WORKFLOW_LIMITS,
  WORKFLOW_STATUSES,
  describeCatalog,
} from "../src/lib/workflows/catalog.js";
import { collectTenantRefs, validateDefinitionSpec } from "../src/lib/workflows/definition.js";

// Batch 15 — pure contract coverage (no DB, no live API). Locks the single source
// of truth (catalog) against the generated OpenAPI contract and pins the validator
// semantics the API, the future engine (B16) and the future UI (B17) rely on.

// Unwraps optional/nullable/default wrappers (zod v3 and v4 shapes) down to the enum.
type ZodEnumLike = {
  options?: readonly string[];
  unwrap?: () => ZodEnumLike;
  removeDefault?: () => ZodEnumLike;
  _def?: { innerType?: ZodEnumLike };
  def?: { innerType?: ZodEnumLike };
};
function enumOptions(schema: unknown): string[] {
  let s = schema as ZodEnumLike;
  for (let i = 0; i < 6 && s && !s.options; i++) {
    s = (s.removeDefault?.() ?? s.unwrap?.() ?? s._def?.innerType ?? s.def?.innerType) as ZodEnumLike;
  }
  return [...(s?.options ?? [])];
}

const shape = (CreateWorkflowDefinitionBody as unknown as { shape: Record<string, { shape?: Record<string, unknown>; element?: { shape?: Record<string, unknown> }; unwrap?: () => { element?: { shape?: Record<string, unknown> } } }> }).shape;

describe("workflow catalog ↔ OpenAPI contract sync", () => {
  it("trigger types in the OpenAPI enum equal the catalog", () => {
    const openapi = enumOptions(shape.trigger.shape!.type);
    expect(openapi).toEqual([...TRIGGER_TYPES]);
  });

  it("condition operators in the OpenAPI enum equal the catalog", () => {
    const conditions = shape.conditions.unwrap ? shape.conditions.unwrap() : shape.conditions;
    const openapi = enumOptions(conditions.element!.shape!.operator);
    expect(openapi).toEqual([...CONDITION_OPERATORS]);
  });

  it("action types in the OpenAPI enum equal the catalog", () => {
    const actions = shape.actions.unwrap ? shape.actions.unwrap() : shape.actions;
    const openapi = enumOptions(actions.element!.shape!.type);
    expect(openapi).toEqual([...ACTION_TYPES]);
  });

  it("value lists mirror the existing CRM contracts (contact statuses, task types, assignment strategies)", () => {
    expect(enumOptions((UpdateContactBody as unknown as { shape: Record<string, unknown> }).shape.status)).toEqual([...CONTACT_STATUSES]);
    expect(enumOptions((CreateTaskBody as unknown as { shape: Record<string, unknown> }).shape.type)).toEqual([...TASK_TYPES]);
    const assign = enumOptions((AssignLeadBody as unknown as { shape: Record<string, unknown> }).shape.strategy);
    // Every catalog strategy exists on the assign endpoint; "ai" is deliberately excluded.
    for (const s of LEAD_ASSIGNMENT_STRATEGIES) expect(assign).toContain(s);
    expect(LEAD_ASSIGNMENT_STRATEGIES).not.toContain("ai");
    expect(assign).toContain("ai");
  });

  it("every operator has a compatibility entry and every field type maps to known operators", () => {
    for (const ops of Object.values(OPERATORS_BY_FIELD_TYPE)) {
      for (const op of ops) expect(CONDITION_OPERATORS).toContain(op);
    }
    for (const entity of ["lead", "contact"] as const) {
      for (const f of CONDITION_FIELDS[entity]) expect(OPERATORS_BY_FIELD_TYPE[f.type].length).toBeGreaterThan(0);
    }
  });

  it("describeCatalog renders JSON Schema for every trigger/action and exposes the lifecycle", () => {
    const c = describeCatalog();
    expect(c.triggers.map((t) => t.type)).toEqual([...TRIGGER_TYPES]);
    expect(c.actions.map((a) => a.type)).toEqual([...ACTION_TYPES]);
    for (const t of c.triggers) expect(t.configSchema.type).toBe("object");
    for (const a of c.actions) {
      expect(a.configSchema.type).toBe("object");
      // Strict configs: unknown keys are rejected — the schema says so.
      expect(a.configSchema.additionalProperties).toBe(false);
    }
    expect(c.statuses).toEqual([...WORKFLOW_STATUSES]);
    expect(Object.keys(c.lifecycle)).toEqual([...WORKFLOW_STATUSES]);
    // No lifecycle state executes anything: archived is terminal and read-only.
    expect(WORKFLOW_LIFECYCLE.archived.editable).toBe(false);
    expect(WORKFLOW_LIFECYCLE.archived.transitions).toEqual([]);
    // Published definitions are immutable: unpublish → edit → publish is the only edit path.
    expect(WORKFLOW_LIFECYCLE.published.editable).toBe(false);
    expect(WORKFLOW_LIFECYCLE.published.deletable).toBe(false);
    expect(WORKFLOW_LIFECYCLE.draft.editable).toBe(true);
    expect(WORKFLOW_LIFECYCLE.draft.deletable).toBe(true);
    expect(WORKFLOW_LIFECYCLE.draft.transitions).toEqual(["published", "archived"]);
    expect(WORKFLOW_LIFECYCLE.published.transitions).toEqual(["draft", "archived"]);
    expect(c.limits.maxDefinitionBytes).toBe(WORKFLOW_LIMITS.maxDefinitionBytes);
  });

  it("the catalog contains no AI capability", () => {
    const text = JSON.stringify(describeCatalog()).toLowerCase();
    expect(text).not.toContain("gemini");
    expect(text).not.toContain('"ai"');
    for (const type of ACTION_TYPES) expect(type.startsWith("ai.")).toBe(false);
  });
});

describe("validateDefinitionSpec", () => {
  const valid = {
    trigger: { type: "lead.created", config: {} },
    conditions: [
      { field: "value", operator: "greater_than", value: 1000 },
      { field: "source", operator: "in", value: ["event", "referral"] },
      { field: "assignedToId", operator: "is_empty" },
    ],
    actions: [
      { type: "lead.add_tag", config: { tagId: 7 } },
      { type: "task.create", config: { title: "Call the lead", assignee: { kind: "record_owner" } } },
      { type: "lead.update_fields", config: { fields: { priority: "high" } } },
    ],
  };

  it("accepts a valid definition and normalizes defaults while preserving action order", () => {
    const r = validateDefinitionSpec(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.actions.map((a) => a.type)).toEqual(["lead.add_tag", "task.create", "lead.update_fields"]);
    // Defaults applied deterministically (task type, no extra keys).
    expect(r.spec.actions[1].config).toEqual({ title: "Call the lead", type: "custom", assignee: { kind: "record_owner" } });
    expect(r.spec.conditions[2]).toEqual({ field: "assignedToId", operator: "is_empty" });
  });

  it("keeps a 20-action definition in exactly the given order", () => {
    const actions = Array.from({ length: 20 }, (_, i) => ({ type: "lead.add_tag", config: { tagId: i + 1 } }));
    const r = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.actions.map((a) => (a.config as { tagId: number }).tagId)).toEqual(actions.map((a) => a.config.tagId));
  });

  it("rejects a missing or unknown trigger", () => {
    expect(validateDefinitionSpec({ actions: [] }).ok).toBe(false);
    const r = validateDefinitionSpec({ trigger: { type: "lead.deleted" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].path).toBe("trigger.type");
  });

  it("rejects malformed trigger config (unknown keys, bad enum)", () => {
    const r1 = validateDefinitionSpec({ trigger: { type: "lead.created", config: { anything: 1 } } });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.issues[0].code).toBe("WORKFLOW_INVALID_TRIGGER_CONFIG");
    const r2 = validateDefinitionSpec({ trigger: { type: "contact.status_changed", config: { toStatus: "vip" } } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues[0].path).toBe("trigger.config.toStatus");
  });

  it("rejects unknown fields, unsupported operators and wrong value shapes in conditions", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ field: "nope", operator: "equals", value: "x" }, "WORKFLOW_UNKNOWN_FIELD"],
      [{ field: "title", operator: "greater_than", value: 3 }, "WORKFLOW_UNSUPPORTED_OPERATOR"],
      [{ field: "value", operator: "contains", value: "1" }, "WORKFLOW_UNSUPPORTED_OPERATOR"],
      [{ field: "value", operator: "in", value: 5 }, "WORKFLOW_INVALID_VALUE"],
      [{ field: "value", operator: "equals", value: "high" }, "WORKFLOW_INVALID_VALUE"],
      [{ field: "assignedToId", operator: "is_empty", value: 1 }, "WORKFLOW_INVALID_VALUE"],
      [{ field: "source", operator: "in", value: [] }, "WORKFLOW_INVALID_VALUE"],
      [{ field: "title", operator: "equals" }, "WORKFLOW_INVALID_VALUE"],
      [{ field: "title", operator: "like", value: "x" }, "WORKFLOW_INVALID_SHAPE"],
    ];
    for (const [cond, code] of cases) {
      const r = validateDefinitionSpec({ trigger: { type: "lead.created" }, conditions: [cond] });
      expect(r.ok, JSON.stringify(cond)).toBe(false);
      if (!r.ok) expect(r.issues[0].code, JSON.stringify(cond)).toBe(code);
    }
  });

  it("validates enum-typed contact fields against the known values", () => {
    const ok = validateDefinitionSpec({ trigger: { type: "contact.created" }, conditions: [{ field: "status", operator: "in", value: ["won", "lost"] }] });
    expect(ok.ok).toBe(true);
    const bad = validateDefinitionSpec({ trigger: { type: "contact.created" }, conditions: [{ field: "status", operator: "equals", value: "vip" }] });
    expect(bad.ok).toBe(false);
  });

  it("rejects unknown action types, entity mismatches and malformed/strict configs", () => {
    const unknown = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "lead.delete", config: {} }] });
    expect(unknown.ok).toBe(false);
    const mismatch = validateDefinitionSpec({ trigger: { type: "contact.created" }, actions: [{ type: "lead.add_tag", config: { tagId: 1 } }] });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.issues[0].code).toBe("WORKFLOW_ACTION_ENTITY_MISMATCH");
    const malformed = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: {} }] });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.issues[0].path).toBe("actions[0].config.tagId");
    const extraKey = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "lead.add_tag", config: { tagId: 1, script: "rm -rf" } }] });
    expect(extraKey.ok).toBe(false);
    const emptyPatch = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "lead.update_fields", config: { fields: {} } }] });
    expect(emptyPatch.ok).toBe(false);
    const badRecipient = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "notification.create", config: { title: "x", recipient: { kind: "user" } } }] });
    expect(badRecipient.ok).toBe(false);
    const manualNoUser = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "lead.assign_owner", config: { strategy: "manual" } }] });
    expect(manualNoUser.ok).toBe(false);
    const aiStrategy = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "lead.assign_owner", config: { strategy: "ai" } }] });
    expect(aiStrategy.ok).toBe(false);
  });

  it("rejects unknown top-level keys and enforces limits", () => {
    expect(validateDefinitionSpec({ ...valid, schedule: "* * * * *" }).ok).toBe(false);
    const tooMany = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: Array.from({ length: WORKFLOW_LIMITS.maxActions + 1 }, () => ({ type: "lead.add_tag", config: { tagId: 1 } })) });
    expect(tooMany.ok).toBe(false);
    const huge = validateDefinitionSpec({ trigger: { type: "lead.created" }, actions: [{ type: "email.send", config: { to: { kind: "actor" }, subject: "s", body: "x".repeat(WORKFLOW_LIMITS.maxDefinitionBytes) } }] });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.issues[0].code).toBe("WORKFLOW_TOO_LARGE");
  });

  it("collects tenant references with precise paths", () => {
    const r = validateDefinitionSpec({
      trigger: { type: "lead.stage_changed", config: { toStageKey: "qualified" } },
      actions: [
        { type: "lead.add_tag", config: { tagId: 7 } },
        { type: "task.create", config: { title: "t", assignee: { kind: "user", userId: 42 } } },
        { type: "lead.update_fields", config: { fields: { stage: "won", teamId: 3 } } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(collectTenantRefs(r.spec)).toEqual([
      { path: "trigger.config.toStageKey", kind: "stageKey", key: "qualified" },
      { path: "actions[0].config.tagId", kind: "row", table: "tags", id: 7 },
      { path: "actions[1].config.assignee.userId", kind: "row", table: "users", id: 42 },
      { path: "actions[2].config.fields.stage", kind: "stageKey", key: "won" },
      { path: "actions[2].config.fields.teamId", kind: "row", table: "teams", id: 3 },
    ]);
  });

  it("every action declares only refs that exist in its config schema paths", () => {
    // Guard against a ref path that could never be validated (typo in the catalog).
    for (const [type, def] of Object.entries(WORKFLOW_ACTIONS)) {
      const json = JSON.stringify(describeCatalog().actions.find((a) => a.type === type)!.configSchema);
      for (const ref of def.refs) {
        const leaf = ref.path.split(".").pop()!;
        expect(json, `${type} ref ${ref.path}`).toContain(`"${leaf}"`);
      }
    }
  });
});
