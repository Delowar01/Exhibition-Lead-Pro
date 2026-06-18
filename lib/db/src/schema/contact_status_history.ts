import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";

// Append-only log of contact lead-status changes (one row per change).
export const contactStatusHistoryTable = pgTable("contact_status_history", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  comment: text("comment"),
  changedById: integer("changed_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertContactStatusHistorySchema = createInsertSchema(contactStatusHistoryTable).omit({ id: true, createdAt: true });
export type InsertContactStatusHistory = z.infer<typeof insertContactStatusHistorySchema>;
export type ContactStatusHistory = typeof contactStatusHistoryTable.$inferSelect;
