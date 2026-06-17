import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  industry: text("industry"),
  country: text("country"),
  address: text("address"),
  vatNumber: text("vat_number"),
  website: text("website"),
  logoUrl: text("logo_url"),
  phone: text("phone"),
  plan: text("plan").notNull().default("free"), // free, starter, professional, business, enterprise (references plans.id)
  status: text("status").notNull().default("trial"), // trial, active, suspended, expired, cancelled
  suspendedReason: text("suspended_reason"),
  trialEndsAt: timestamp("trial_ends_at"),
  scansUsed: integer("scans_used").notNull().default(0),
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
