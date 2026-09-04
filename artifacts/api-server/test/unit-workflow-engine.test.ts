import { describe, it, expect } from "vitest";
import { evaluateConditions } from "../src/lib/workflows/conditions.js";
import { matchesTriggerConfig } from "../src/lib/workflows/triggers.js";
import { changedFieldsBetween, contactUpdatedEvents, leadRecord, leadUpdatedEvents, contactRecord, eventKeyOf, leadCreatedEvent } from "../src/lib/workflows/events.js";
import { classifyError, WorkflowFailure, WorkflowSkip } from "../src/lib/workflows/errors.js";
import { currentWorkflowRunId, runInWorkflowContext } from "../src/lib/workflows/context.js";
import { AppError } from "../src/middlewares/errorHandler.js";
import type { Lead, Contact } from "@workspace/db";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Batch 16 — pure engine semantics (no DB, no live API): the condition evaluator,
// the trigger-config matcher, the before/after event builders, error
// classification and the loop-safety context.

const lead = (over: Partial<Lead> = {}): Lead =>
  ({
    id: 1, companyId: 10, contactId: 5, stage: "prospect", source: "event", title: "Big deal", value: "1500.00", currency: "USD",
    closingDate: null, probability: 40, priority: "high", notes: null, companyName: "Acme", organizationId: null, assignedToId: 7,
    eventId: null, stageId: 1, teamId: null, createdById: 7, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    ...over,
  }) as Lead;

const contact = (over: Partial<Contact> = {}): Contact =>
  ({
    id: 2, companyId: 10, firstName: "Ada", lastName: "Lovelace", fullName: "Ada Lovelace", email: "ada@example.com", status: "new",
    tags: JSON.stringify(["vip", "expo"]), leadScore: 80, leadTemperature: "hot", source: "scan", assignedToId: null, createdById: 7,
    createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    ...over,
  }) as Contact;

describe("evaluateConditions — operator semantics", () => {
  const rec = leadRecord(lead());

  it("equals / not_equals compare numbers numerically and strings exactly", () => {
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "equals", value: 1500 }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "equals", value: "1500" }]).matched).toBe(true); // numeric string
    expect(evaluateConditions("lead", rec, [{ field: "stage", operator: "equals", value: "prospect" }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "stage", operator: "equals", value: "Prospect" }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "stage", operator: "not_equals", value: "won" }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "assignedToId", operator: "equals", value: 7 }]).matched).toBe(true);
  });

  it("contains / not_contains are substring checks on strings and membership on lists", () => {
    expect(evaluateConditions("lead", rec, [{ field: "title", operator: "contains", value: "big" }]).matched).toBe(true); // case-insensitive
    expect(evaluateConditions("lead", rec, [{ field: "title", operator: "not_contains", value: "small" }]).matched).toBe(true);
    const c = contactRecord(contact());
    expect(evaluateConditions("contact", c, [{ field: "tags", operator: "contains", value: "vip" }]).matched).toBe(true);
    expect(evaluateConditions("contact", c, [{ field: "tags", operator: "contains", value: "vi" }]).matched).toBe(false); // exact membership, not substring
    expect(evaluateConditions("contact", c, [{ field: "tags", operator: "not_contains", value: "cold" }]).matched).toBe(true);
    // null string field: contains is false, not_contains is true
    const noTitle = leadRecord(lead({ title: null }));
    expect(evaluateConditions("lead", noTitle, [{ field: "title", operator: "contains", value: "x" }]).matched).toBe(false);
    expect(evaluateConditions("lead", noTitle, [{ field: "title", operator: "not_contains", value: "x" }]).matched).toBe(true);
  });

  it("in / not_in check scalar membership in the configured list", () => {
    expect(evaluateConditions("lead", rec, [{ field: "source", operator: "in", value: ["event", "referral"] }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "source", operator: "not_in", value: ["web"] }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "assignedToId", operator: "in", value: [1, 7] }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "in", value: [1500, 2] }]).matched).toBe(true);
    const unowned = leadRecord(lead({ assignedToId: null }));
    expect(evaluateConditions("lead", unowned, [{ field: "assignedToId", operator: "in", value: [7] }]).matched).toBe(false);
    expect(evaluateConditions("lead", unowned, [{ field: "assignedToId", operator: "not_in", value: [7] }]).matched).toBe(true);
  });

  it("is_empty / is_not_empty treat null, undefined, blank strings and empty lists as empty", () => {
    const r = leadRecord(lead({ assignedToId: null, notes: null, title: "  " }));
    expect(evaluateConditions("lead", r, [{ field: "assignedToId", operator: "is_empty" }]).matched).toBe(true);
    expect(evaluateConditions("lead", r, [{ field: "title", operator: "is_empty" }]).matched).toBe(true);
    expect(evaluateConditions("lead", r, [{ field: "stage", operator: "is_not_empty" }]).matched).toBe(true);
    const c = contactRecord(contact({ tags: "[]" }));
    expect(evaluateConditions("contact", c, [{ field: "tags", operator: "is_empty" }]).matched).toBe(true);
    const c2 = contactRecord(contact({ tags: "not json" }));
    expect(evaluateConditions("contact", c2, [{ field: "tags", operator: "is_empty" }]).matched).toBe(true);
  });

  it("greater_than / less_than are numeric only", () => {
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "greater_than", value: 1000 }]).matched).toBe(true);
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "less_than", value: 1000 }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "probability", operator: "greater_than", value: "39" }]).matched).toBe(true);
    const noValue = leadRecord(lead({ value: null }));
    expect(evaluateConditions("lead", noValue, [{ field: "value", operator: "greater_than", value: 0 }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "greater_than", value: "abc" }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "title", operator: "greater_than", value: 1 }]).matched).toBe(false);
  });

  it("invalid runtime values fail safely (no coercion)", () => {
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "equals", value: "high" }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "stage", operator: "equals", value: 5 }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "value", operator: "in", value: "1500" }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "nope", operator: "equals", value: 1 }]).matched).toBe(false);
    expect(evaluateConditions("lead", rec, [{ field: "stage", operator: "greater_than", value: 1 }]).matched).toBe(false);
    expect(evaluateConditions("contact", contactRecord(contact()), [{ field: "tags", operator: "in", value: ["vip"] }]).matched).toBe(false);
  });

  it("all conditions are AND; the first failing index is reported", () => {
    const r = evaluateConditions("lead", rec, [
      { field: "value", operator: "greater_than", value: 1000 },
      { field: "source", operator: "equals", value: "web" },
      { field: "priority", operator: "equals", value: "high" },
    ]);
    expect(r.matched).toBe(false);
    expect(r.failed?.index).toBe(1);
    expect(evaluateConditions("lead", rec, []).matched).toBe(true);
  });
});

describe("matchesTriggerConfig", () => {
  const base = { eventId: "e1", companyId: 10, entityType: "lead" as const, entityId: 1, actorUserId: 7, record: {}, changedFields: ["title", "value"] };

  it("updated triggers honor the optional changed-field filter", () => {
    const ev = { ...base, triggerType: "lead.updated" as const };
    expect(matchesTriggerConfig("lead.updated", {}, ev)).toBe(true);
    expect(matchesTriggerConfig("lead.updated", { fields: ["value"] }, ev)).toBe(true);
    expect(matchesTriggerConfig("lead.updated", { fields: ["stage", "priority"] }, ev)).toBe(false);
  });

  it("stage_changed / status_changed honor from/to filters", () => {
    const st = { ...base, triggerType: "lead.stage_changed" as const, from: "prospect", to: "qualified" };
    expect(matchesTriggerConfig("lead.stage_changed", {}, st)).toBe(true);
    expect(matchesTriggerConfig("lead.stage_changed", { toStageKey: "qualified" }, st)).toBe(true);
    expect(matchesTriggerConfig("lead.stage_changed", { fromStageKey: "prospect", toStageKey: "qualified" }, st)).toBe(true);
    expect(matchesTriggerConfig("lead.stage_changed", { toStageKey: "won" }, st)).toBe(false);
    expect(matchesTriggerConfig("lead.stage_changed", { fromStageKey: "won" }, st)).toBe(false);
    const cs = { ...base, entityType: "contact" as const, triggerType: "contact.status_changed" as const, from: "new", to: "won" };
    expect(matchesTriggerConfig("contact.status_changed", { toStatus: "won" }, cs)).toBe(true);
    expect(matchesTriggerConfig("contact.status_changed", { fromStatus: "contacted" }, cs)).toBe(false);
  });

  it("a definition never matches an event of another trigger type", () => {
    expect(matchesTriggerConfig("lead.created", {}, { ...base, triggerType: "lead.updated" })).toBe(false);
    expect(matchesTriggerConfig("lead.created", {}, { ...base, triggerType: "lead.created" })).toBe(true);
  });
});

describe("event builders", () => {
  it("lead update emits updated + stage_changed + assigned only for real changes", () => {
    const before = lead();
    const same = leadUpdatedEvents(before, lead({ updatedAt: new Date() }), 7);
    expect(same).toEqual([]);
    const after = lead({ stage: "qualified", assignedToId: 9, value: "1500.00" });
    const events = leadUpdatedEvents(before, after, 7, "evt-1");
    expect(events.map((e) => e.triggerType)).toEqual(["lead.updated", "lead.stage_changed", "lead.assigned"]);
    expect(events[0].changedFields.sort()).toEqual(["assignedToId", "stage"]);
    expect(events[1]).toMatchObject({ from: "prospect", to: "qualified" });
    expect(events[2]).toMatchObject({ from: "7", to: "9" });
    expect(new Set(events.map(eventKeyOf)).size).toBe(3);
    expect(eventKeyOf(events[0])).toBe("lead.updated:lead:1:evt-1");
    // conditions evaluate against the POST-mutation record
    expect(events[0].record.stage).toBe("qualified");
  });

  it("lead.assigned fires only when the owner actually changes", () => {
    const evs = leadUpdatedEvents(lead(), lead({ title: "Renamed" }), 7);
    expect(evs.map((e) => e.triggerType)).toEqual(["lead.updated"]);
    const cleared = leadUpdatedEvents(lead(), lead({ assignedToId: null }), 7);
    expect(cleared.map((e) => e.triggerType)).toEqual(["lead.updated", "lead.assigned"]);
    expect(cleared[1]).toMatchObject({ from: "7", to: null });
  });

  it("contact update emits status_changed with from/to; created carries the record", () => {
    const evs = contactUpdatedEvents(contact(), contact({ status: "won", city: "Dubai" }), 7);
    expect(evs.map((e) => e.triggerType)).toEqual(["contact.updated", "contact.status_changed"]);
    expect(evs[1]).toMatchObject({ from: "new", to: "won" });
    expect(evs[0].changedFields.sort()).toEqual(["city", "status"]);
    const created = leadCreatedEvent(lead(), 7);
    expect(created.record.value).toBe(1500);
    expect(created.entityType).toBe("lead");
  });

  it("changedFieldsBetween only reports catalog-visible fields", () => {
    expect(changedFieldsBetween("lead", leadRecord(lead()), leadRecord(lead({ notes: "x" })))).toEqual([]);
  });
});

describe("classifyError", () => {
  it("separates deterministic from transient failures and never echoes unknown error text", () => {
    expect(classifyError(new AppError(404, "Lead not found"))).toMatchObject({ retryable: false, code: "APP_404", message: "Lead not found" });
    expect(classifyError(new WorkflowFailure("REFERENCE_INVALID", "gone"))).toMatchObject({ retryable: false, code: "REFERENCE_INVALID" });
    expect(classifyError(new WorkflowFailure("PROVIDER", "later", true)).retryable).toBe(true);
    const pg = Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" });
    expect(classifyError(pg)).toMatchObject({ retryable: true, code: "TRANSIENT" });
    const unknown = classifyError(new Error("smtp password=hunter2 rejected"));
    expect(unknown.retryable).toBe(true);
    expect(unknown.message).toBe("unexpected error");
    expect(JSON.stringify(unknown)).not.toContain("hunter2");
    expect(new WorkflowSkip("no owner").reason).toBe("no owner");
  });
});

describe("workflow context (loop safety)", () => {
  it("is set only inside runInWorkflowContext and propagates through awaits", async () => {
    expect(currentWorkflowRunId()).toBeNull();
    const seen = await runInWorkflowContext(42, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentWorkflowRunId();
    });
    expect(seen).toBe(42);
    expect(currentWorkflowRunId()).toBeNull();
  });
});

describe("AI boundary (static)", () => {
  it("no workflow engine module imports the AI layer or the Gemini SDK", () => {
    const dir = join(process.cwd(), "src", "lib", "workflows");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      const imports = src.split("\n").filter((l) => l.startsWith("import "));
      for (const line of imports) {
        expect(line, `${f}: ${line}`).not.toMatch(/\/ai\b|\/ai\/|gemini|integrations-gemini/i);
      }
    }
  });
});
