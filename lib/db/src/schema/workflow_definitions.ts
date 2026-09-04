import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Persistent, company-scoped CRM automation definitions (Batch 15 — Workflow
// Definitions). A row is a DEFINITION ONLY: "when <trigger> [and <conditions>]
// then <ordered actions>". Nothing in Batch 15 executes it — no event listener,
// no scheduler, no job enqueue, no CRM mutation, no email/notification, no AI.
// Execution (runs, history, retries) is Batch 16 and gets its OWN tables; the
// management UI is Batch 17. This table is deliberately the single definition
// store: trigger/conditions/actions are structured JSONB validated against the
// central contract in artifacts/api-server/src/lib/workflows/ (the only place
// that knows the supported trigger/operator/action catalog).
//
// Lifecycle (`status`) — definition-MANAGEMENT states only; no state executes:
//   draft     → editable working copy. Never eligible for the (future) engine.
//   published → the definition the (future) Batch 16 engine may consider
//               eligible. Still editable (revision bumps); can be unpublished
//               back to draft. Publishing requires a fully valid definition
//               with at least one action.
//   archived  → terminal, read-only history (archived_at set). Cannot be
//               edited, published or deleted; kept for auditability.
// Hard delete is allowed ONLY for drafts; non-draft definitions are archived.
//
// `revision` is the optimistic-concurrency token: every mutation requires the
// caller's `revision` to equal the stored one and increments it, so a stale
// editor can never silently overwrite a newer definition (409 on mismatch).
// `schema_version` is the version of the definition CONTRACT the JSONB was
// validated against, so B16/B17 can migrate/interpret older rows explicitly.
// `trigger_type` is denormalized from trigger.type (server-derived, never
// client-supplied on its own) so the engine can index "published definitions
// for event X in tenant Y" without unpacking JSONB.
//
// SECURITY: definitions reference platform capabilities by id/key only (users,
// tags, teams, stages …) and are validated to belong to the same tenant. They
// must never carry credentials or secrets (SMTP, Gemini, GCS, session, API
// keys) — the contract has no field for them and strict schemas reject unknown
// keys.
export const workflowDefinitionsTable = pgTable(
  "workflow_definitions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"), // draft | published | archived
    triggerType: text("trigger_type").notNull(), // denormalized trigger.type
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    conditions: jsonb("conditions").$type<unknown[]>().notNull().default([]),
    actions: jsonb("actions").$type<unknown[]>().notNull().default([]), // ordered; array order is execution order
    schemaVersion: integer("schema_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
    updatedById: integer("updated_by_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    archivedAt: timestamp("archived_at"),
  },
  (t) => [
    index("workflow_definitions_company_id_idx").on(t.companyId),
    index("workflow_definitions_company_status_idx").on(t.companyId, t.status),
    // Engine lookup path (B16): published definitions for one trigger in one tenant.
    index("workflow_definitions_company_trigger_idx").on(t.companyId, t.triggerType, t.status),
  ],
);

export const insertWorkflowDefinitionSchema = createInsertSchema(workflowDefinitionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWorkflowDefinition = z.infer<typeof insertWorkflowDefinitionSchema>;
export type WorkflowDefinition = typeof workflowDefinitionsTable.$inferSelect;
