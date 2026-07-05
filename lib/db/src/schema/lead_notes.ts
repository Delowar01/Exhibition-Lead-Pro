import { pgTable, serial, text, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { leadsTable } from "./leads";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";

// Internal notes on a lead (rich text, editable, pinnable). Distinct from
// lead_activities (logged touchpoints / system events): a note is collaborative
// commentary, not an interaction record. contactId is denormalized from the lead
// so notes can surface on the Customer Timeline. `body` stores a portable
// rich-text markup (markdown subset + `@[Name](userId)` mention tokens); the
// authoritative list of mentioned user ids is materialized in `mentions`.
export const leadNotesTable = pgTable("lead_notes", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }), // author
  body: text("body").notNull(),
  mentions: jsonb("mentions").$type<number[]>().notNull().default([]), // tenant user ids @-mentioned
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

// Append-only edit history for a note. One row is written with the PRIOR body
// each time a note's body is edited, so the full revision trail is preserved.
// No soft-delete, no update/delete routes — this table is immutable by design.
export const leadNoteHistoryTable = pgTable("lead_note_history", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  noteId: integer("note_id").notNull().references(() => leadNotesTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  mentions: jsonb("mentions").$type<number[]>().notNull().default([]),
  editedById: integer("edited_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_note_history_note_id_idx").on(t.noteId),
  index("lead_note_history_company_id_idx").on(t.companyId),
]);

export type LeadNoteHistory = typeof leadNoteHistoryTable.$inferSelect;

// Threaded internal comments under a note. Collaborative discussion on a note;
// supports @mentions (materialized in `mentions`) and soft-delete.
export const leadNoteCommentsTable = pgTable("lead_note_comments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  noteId: integer("note_id").notNull().references(() => leadNotesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }), // author
  body: text("body").notNull(),
  mentions: jsonb("mentions").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("lead_note_comments_note_id_idx").on(t.noteId),
  index("lead_note_comments_company_id_idx").on(t.companyId),
]);

export type LeadNoteComment = typeof leadNoteCommentsTable.$inferSelect;
