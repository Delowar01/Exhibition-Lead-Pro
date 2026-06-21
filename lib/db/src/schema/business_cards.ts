import { pgTable, serial, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// A per-rep digital business card. One row per user (userId is unique). The
// avatar is NOT stored here — it is pulled from the owning user account at
// display time, with an initials fallback. Tenant boundary is companyId.
export const businessCardsTable = pgTable("business_cards", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  // Stable, unguessable token used in the public share URL (/c/:token).
  publicToken: text("public_token").notNull().unique(),

  // Editable card fields.
  fullName: text("full_name"),
  designation: text("designation"),
  companyName: text("company_name"),
  email: text("email"),
  primaryPhone: text("primary_phone"),
  alternatePhone: text("alternate_phone"),
  officeAddress: text("office_address"),

  // Future website + social links (columns only — no UI yet).
  website: text("website"),
  linkedin: text("linkedin"),
  facebook: text("facebook"),
  instagram: text("instagram"),
  twitter: text("twitter"),
  youtube: text("youtube"),

  // Per-field visibility map (e.g. { email: true, alternatePhone: false }).
  // Prepared for future control over what the public page exposes.
  fieldVisibility: jsonb("field_visibility").$type<Record<string, boolean>>().notNull().default({}),
  // Future multi-template support.
  templateId: text("template_id").notNull().default("classic"),
  isPublished: boolean("is_published").notNull().default(true),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBusinessCardSchema = createInsertSchema(businessCardsTable).omit({ id: true, createdAt: true });
export type InsertBusinessCard = z.infer<typeof insertBusinessCardSchema>;
export type BusinessCard = typeof businessCardsTable.$inferSelect;
