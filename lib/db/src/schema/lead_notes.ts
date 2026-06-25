import { pgTable, serial, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { leadsTable } from "./leads";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";

// Internal notes on a lead (free-form, editable, pinnable). Distinct from
// lead_activities (logged touchpoints / system events): a note is collaborative
// commentary, not an interaction record. contactId is denormalized from the lead
// so notes can surface on the Customer Timeline.
export const leadNotesTable = pgTable("lead_notes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }), // author
  body: text("body").notNull(),
  isPinned: boolean("is_pinned").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("lead_notes_company_id_idx").on(t.companyId),
  index("lead_notes_lead_id_idx").on(t.leadId),
]);

export const insertLeadNoteSchema = createInsertSchema(leadNotesTable).omit({ id: true, createdAt: true });
export type InsertLeadNote = z.infer<typeof insertLeadNoteSchema>;
export type LeadNote = typeof leadNotesTable.$inferSelect;
