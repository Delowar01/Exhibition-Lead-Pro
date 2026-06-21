import { pgTable, serial, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Per-field public visibility map, e.g. { email: true, primaryPhone: false }.
// Absent keys default to visible. Future-ready: lets users hide fields on the
// public card without a schema redesign.
export type CardFieldVisibility = Record<string, boolean>;

// One digital business card per user, tenant-scoped by company. The avatar is
// NOT stored here — it is read from the owning user's account at display time so
// it always reflects the latest profile photo.
export const businessCardsTable = pgTable("business_cards", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  // Stable, unguessable token used in the public URL (/card/:token) and QR code.
  publicToken: text("public_token").notNull().unique(),
  // Editable card fields (this iteration).
  fullName: text("full_name"),
  designation: text("designation"),
  companyName: text("company_name"),
  email: text("email"),
  primaryPhone: text("primary_phone"),
  altPhone: text("alt_phone"),
  officeAddress: text("office_address"),
  // Future-ready optional fields (no UI this iteration).
  website: text("website"),
  linkedin: text("linkedin"),
  facebook: text("facebook"),
  instagram: text("instagram"),
  twitter: text("twitter"),
  youtube: text("youtube"),
  // Future-ready privacy controls + multiple templates.
  fieldVisibility: jsonb("field_visibility").$type<CardFieldVisibility>().notNull().default({}),
  templateId: text("template_id").notNull().default("classic"),
  isPublished: boolean("is_published").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBusinessCardSchema = createInsertSchema(businessCardsTable).omit({ id: true, createdAt: true });
export type InsertBusinessCard = z.infer<typeof insertBusinessCardSchema>;
export type BusinessCard = typeof businessCardsTable.$inferSelect;
