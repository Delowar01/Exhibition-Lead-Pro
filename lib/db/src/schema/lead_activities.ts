import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { leadsTable } from "./leads";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";

// Unified activity / interaction log for a lead (and, via the denormalized
// contactId, its contact). Two sources:
//   - "manual"  → a user-logged touchpoint (call, email, meeting, message, other)
//   - "system"  → a lifecycle event emitted by the lead service (created,
//                 stage_change, assignment, won, lost)
// This is the single source for the Lead Activity Timeline and a feeder for the
// aggregated Customer Timeline. `metadata` (jsonb) carries structured context
// (e.g. { from, to } for a stage_change) so Phase 4 automation / Phase 5 AI /
// Phase 6 reporting can reason over activities without schema changes.
export const leadActivitiesTable = pgTable("lead_activities", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }), // actor
  type: text("type").notNull(), // call, email, meeting, message, other, note, created, stage_change, assignment, won, lost
  source: text("source").notNull().default("manual"), // manual | system
  subject: text("subject"),
  body: text("body"),
  outcome: text("outcome"),
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("lead_activities_company_id_idx").on(t.companyId),
  index("lead_activities_lead_id_idx").on(t.leadId),
  index("lead_activities_contact_id_idx").on(t.contactId),
  index("lead_activities_occurred_at_idx").on(t.occurredAt),
]);

export const insertLeadActivitySchema = createInsertSchema(leadActivitiesTable).omit({ id: true, createdAt: true });
export type InsertLeadActivity = z.infer<typeof insertLeadActivitySchema>;
export type LeadActivity = typeof leadActivitiesTable.$inferSelect;
