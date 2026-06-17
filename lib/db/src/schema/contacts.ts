import { pgTable, serial, text, integer, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { eventsTable } from "./events";
import { usersTable } from "./users";

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  jobTitle: text("job_title"),
  contactCompany: text("contact_company"),
  email: text("email"),
  mobile: text("mobile"),
  officePhone: text("office_phone"),
  website: text("website"),
  country: text("country"),
  address: text("address"),
  linkedin: text("linkedin"),
  notes: text("notes"),
  tags: text("tags").default("[]"), // JSON array stored as text
  status: text("status").notNull().default("new"), // new, qualified, interested, proposal_sent, won, lost
  followUpDate: date("follow_up_date"),
  cardImageUrl: text("card_image_url"),
  eventId: integer("event_id").references(() => eventsTable.id, { onDelete: "set null" }),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertContactSchema = createInsertSchema(contactsTable).omit({ id: true, createdAt: true });
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
