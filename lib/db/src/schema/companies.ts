import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
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
  // Extended organization profile (Phase 2.4). All nullable/additive.
  legalName: text("legal_name"),
  registrationNumber: text("registration_number"),
  timezone: text("timezone"),
  currency: text("currency"),
  primaryContactName: text("primary_contact_name"),
  primaryContactEmail: text("primary_contact_email"),
  plan: text("plan").notNull().default("free"), // free, starter, professional, business, enterprise (references plans.id)
  status: text("status").notNull().default("trial"), // trial, active, suspended, expired, cancelled
  suspendedReason: text("suspended_reason"),
  trialEndsAt: timestamp("trial_ends_at"),
  scansUsed: integer("scans_used").notNull().default(0),
  // Security policy: when true, every member must have MFA enabled; login forces
  // enrollment. The broader Security Center UI lands in a later phase.
  mfaRequired: boolean("mfa_required").notNull().default(false),
  // Tenant branding (Batch 18). All nullable/additive: NULL means "platform
  // default" so existing tenants keep the current look. Colors are stored only as
  // normalized #RRGGBB; the managed logo is an internal object key (never a URL
  // or image bytes) plus its content type. `logo_url` above stays as the legacy
  // externally-hosted value.
  brandPrimaryColor: text("brand_primary_color"),
  brandSidebarColor: text("brand_sidebar_color"),
  brandDefaultTheme: text("brand_default_theme"), // light | dark | system
  brandLogoKey: text("brand_logo_key"),
  brandLogoContentType: text("brand_logo_content_type"),
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
