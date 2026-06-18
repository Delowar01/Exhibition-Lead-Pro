import { pgTable, serial, text, integer, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { contactsTable } from "./contacts";
import { usersTable } from "./users";

// A scheduled meeting for a contact. Rescheduling closes the current row
// (status + comment) and creates a new scheduled row, so all rows for a contact
// form its meeting history.
export const meetingsTable = pgTable("meetings", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  meetingDate: date("meeting_date"),
  meetingTime: text("meeting_time"), // HH:MM local
  type: text("type").notNull().default("physical"), // online, physical, phone_call
  notes: text("notes"),
  status: text("status").notNull().default("scheduled"), // scheduled, completed, rescheduled, cancelled
  comment: text("comment"), // required when an action (complete/reschedule/cancel) is taken
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMeetingSchema = createInsertSchema(meetingsTable).omit({ id: true, createdAt: true });
export type InsertMeeting = z.infer<typeof insertMeetingSchema>;
export type Meeting = typeof meetingsTable.$inferSelect;
