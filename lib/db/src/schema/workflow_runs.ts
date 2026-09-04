import { pgTable, serial, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { workflowDefinitionsTable } from "./workflow_definitions";

// Workflow EXECUTION history (Batch 16 — Workflow Engine). One `workflow_runs` row
// per (published definition × CRM event) that matched, plus one
// `workflow_action_runs` row per action of the captured definition. Together they
// are the primary, tenant-scoped execution record the Batch 17 UI reads.
//
// Definition-snapshot safety: a run stores the exact revision and the trigger/
// conditions/actions it matched against (`definition_snapshot`). Execution ONLY
// ever reads the snapshot, so unpublishing/editing the definition after the run
// was queued can never change what the queued run does; `workflow_definition_id`
// is kept for history/filtering (set NULL if a draft is ever hard-deleted — the
// snapshot keeps the history readable).
//
// Idempotency: `event_key` identifies one CRM event (one mutation) and the unique
// index (workflow_definition_id, event_key) guarantees a definition can never
// produce two runs for the same event — enforced by the database, not memory.
// (run_id, action_index) is unique so every action of a run exists exactly once.
//
// Run lifecycle:    queued → running → completed | failed
// Action lifecycle: pending → running → completed | skipped | failed
//
// `lock_expires_at` is a short execution lease so two workers (e.g. the original
// job and an orphan-recovery re-enqueue) can never execute the same run
// concurrently. `enqueue_generation` is bumped by orphan recovery so the queue
// dedupe key (`workflow.run:<id>:<generation>`) stays unique per attempt to
// enqueue while the same run row is reused.
//
// `error` / `result` hold SANITIZED metadata only (stable code, error class, short
// message, action index/type, created record ids) — never provider responses,
// credentials, tokens, stack traces, email bodies or contact PII.
export const workflowRunsTable = pgTable(
  "workflow_runs",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
    workflowDefinitionId: integer("workflow_definition_id").references(() => workflowDefinitionsTable.id, { onDelete: "set null" }),
    definitionRevision: integer("definition_revision").notNull(),
    definitionSnapshot: jsonb("definition_snapshot").$type<Record<string, unknown>>().notNull(), // { name, trigger, conditions, actions }
    triggerType: text("trigger_type").notNull(),
    entityType: text("entity_type").notNull(), // lead | contact
    entityId: integer("entity_id").notNull(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    eventKey: text("event_key").notNull(), // "<triggerType>:<entityType>:<entityId>:<eventId>"
    status: text("status").notNull().default("queued"), // queued | running | completed | failed
    error: jsonb("error").$type<Record<string, unknown>>(), // sanitized terminal error
    enqueueGeneration: integer("enqueue_generation").notNull().default(1),
    lockExpiresAt: timestamp("lock_expires_at"),
    queuedAt: timestamp("queued_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_runs_definition_event_ux").on(t.workflowDefinitionId, t.eventKey),
    index("workflow_runs_company_created_idx").on(t.companyId, t.createdAt),
    index("workflow_runs_company_status_idx").on(t.companyId, t.status),
    index("workflow_runs_company_definition_idx").on(t.companyId, t.workflowDefinitionId),
    index("workflow_runs_company_entity_idx").on(t.companyId, t.entityType, t.entityId),
    // Orphan recovery sweep: stale queued/running rows by last update.
    index("workflow_runs_status_updated_idx").on(t.status, t.updatedAt),
  ],
);

export const workflowActionRunsTable = pgTable(
  "workflow_action_runs",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull().references(() => workflowRunsTable.id, { onDelete: "cascade" }),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // denormalized tenant boundary
    actionIndex: integer("action_index").notNull(), // deterministic execution order (0-based)
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | completed | skipped | failed
    attempts: integer("attempts").notNull().default(0),
    error: jsonb("error").$type<Record<string, unknown>>(), // sanitized
    result: jsonb("result").$type<Record<string, unknown>>(), // sanitized (ids, skip reason)
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_action_runs_run_index_ux").on(t.runId, t.actionIndex),
    index("workflow_action_runs_company_idx").on(t.companyId),
  ],
);

export const insertWorkflowRunSchema = createInsertSchema(workflowRunsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkflowRun = z.infer<typeof insertWorkflowRunSchema>;
export type WorkflowRun = typeof workflowRunsTable.$inferSelect;
export const insertWorkflowActionRunSchema = createInsertSchema(workflowActionRunsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkflowActionRun = z.infer<typeof insertWorkflowActionRunSchema>;
export type WorkflowActionRun = typeof workflowActionRunsTable.$inferSelect;
