import { pgTable, serial, text, integer, numeric, timestamp, varchar, date, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";
import { eventsTable } from "./events";

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  stage: text("stage").notNull().default("prospect"),
  title: text("title"),
  value: numeric("value", { precision: 12, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  closingDate: date("closing_date"),
  probability: integer("probability"),
  priority: text("priority"),
  notes: text("notes"),
  companyName: text("company_name"),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  eventId: integer("event_id").references(() => eventsTable.id, { onDelete: "set null" }),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; rows with a value are excluded from all reads by default
}, (t) => [
  index("leads_company_id_idx").on(t.companyId),
  index("leads_contact_id_idx").on(t.contactId),
  index("leads_assigned_to_id_idx").on(t.assignedToId),
  index("leads_event_id_idx").on(t.eventId),
  index("leads_company_stage_idx").on(t.companyId, t.stage),
]);

export const leadHistoryTable = pgTable("lead_history", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  changedBy: integer("changed_by").references(() => usersTable.id, { onDelete: "set null" }),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
}, (t) => [index("lead_history_lead_id_idx").on(t.leadId)]);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
export type LeadHistory = typeof leadHistoryTable.$inferSelect;
