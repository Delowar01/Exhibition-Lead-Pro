import { pgTable, serial, text, integer, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";

// A task assigned to a user, optionally linked to a contact. Assigned by an
// admin/primary_admin/team lead; visible to the assignee (and admins).
export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  type: text("type").notNull().default("custom"), // call, follow_up, meeting, proposal, custom
  status: text("status").notNull().default("pending"), // pending, in_progress, completed, overdue
  dueDate: date("due_date"),
  dueTime: text("due_time"), // HH:MM local
  notes: text("notes"),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  assignedById: integer("assigned_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
