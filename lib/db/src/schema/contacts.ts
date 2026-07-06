import { pgTable, serial, text, integer, timestamp, date, doublePrecision, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { eventsTable } from "./events";
import { usersTable } from "./users";
import { organizationsTable } from "./organizations";

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  arabicName: text("arabic_name"),
  jobTitle: text("job_title"),
  contactCompany: text("contact_company"),
  // First-class CRM Organization link (Stage 5A). Additive + nullable; the
  // free-text contactCompany above is retained for backward compatibility.
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  email: text("email"),
  mobile: text("mobile"),
  officePhone: text("office_phone"),
  website: text("website"),
  country: text("country"),
  address: text("address"),
  latitude: doublePrecision("latitude"), // GPS captured at scan time (nullable when unavailable)
  longitude: doublePrecision("longitude"),
  gpsAccuracy: doublePrecision("gps_accuracy"), // meters
  duplicateOfId: integer("duplicate_of_id"), // when set, this contact is a duplicate of another and hidden from the main list
  linkedin: text("linkedin"),
  notes: text("notes"),
  source: text("source"), // acquisition source (e.g. event, referral, website, import)
  tags: text("tags").default("[]"), // JSON array stored as text
  status: text("status").notNull().default("new"), // new, contacted, qualified, interested, proposal_sent, won, lost, archived
  leadScore: integer("lead_score"), // 0-100 AI lead qualification score
  leadTemperature: text("lead_temperature"), // hot, warm, cold
  aiReasoning: text("ai_reasoning"), // short AI explanation of the score
  industry: text("industry"), // AI-enriched industry classification
  seniority: text("seniority"), // AI-enriched seniority level (e.g. C-Level, Director, Manager)
  enrichmentSummary: text("enrichment_summary"), // AI-generated professional summary
  talkingPoints: text("talking_points"), // JSON array of AI-suggested talking points
  enrichedAt: timestamp("enriched_at"), // when AI enrichment last ran
  followUpDate: date("follow_up_date"),
  followUpTime: text("follow_up_time"), // HH:MM local time for the active follow-up
  hotNotifiedAt: timestamp("hot_notified_at"), // when a hot-lead push was last sent for this contact (dedup marker)
  followUpNotifiedOn: date("follow_up_notified_on"), // the followUpDate a due-follow-up push was last sent for (dedup marker)
  cardImageUrl: text("card_image_url"),
  eventId: integer("event_id").references(() => eventsTable.id, { onDelete: "set null" }),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; rows with a value are excluded from all reads by default
}, (t) => [
  index("contacts_company_id_idx").on(t.companyId),
  index("contacts_company_duplicate_idx").on(t.companyId, t.duplicateOfId),
  index("contacts_organization_id_idx").on(t.organizationId),
  index("contacts_event_id_idx").on(t.eventId),
  index("contacts_assigned_to_id_idx").on(t.assignedToId),
  index("contacts_status_idx").on(t.status),
  index("contacts_lead_temperature_idx").on(t.leadTemperature),
  index("contacts_created_at_idx").on(t.createdAt),
  index("contacts_follow_up_date_idx").on(t.followUpDate),
]);

export const insertContactSchema = createInsertSchema(contactsTable).omit({ id: true, createdAt: true });
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
