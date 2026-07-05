import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Organization-defined custom fields for leads/contacts (Stage 4A). A DEFINITION
// is the field template an admin configures; VALUES store the per-entity data
// polymorphically (entityType + entityId point at a lead or contact). Everything
// is tenant-scoped by company_id and additive to the existing lead/contact domain.
//
// Uniqueness of fieldKey per (company, entityType) among non-deleted rows is
// enforced in the service layer (mirrors the tags convention), so a key can be
// reused after a definition is soft-deleted.
export const customFieldDefinitionsTable = pgTable("custom_field_definitions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  entityType: text("entity_type").notNull(), // lead | contact
  fieldKey: text("field_key").notNull(), // stable machine key (e.g. "budget_range")
  label: text("label").notNull(), // human display label
  fieldType: text("field_type").notNull(), // text|number|date|dropdown|checkbox|radio|url|email|phone|currency
  options: text("options"), // JSON array of { label, value } for dropdown/radio (null otherwise)
  required: boolean("required").notNull().default(false),
  defaultValue: text("default_value"), // serialized default (string / JSON)
  validation: text("validation"), // JSON: { min, max, minLength, maxLength, pattern }
  visibilityCondition: text("visibility_condition"), // JSON: { fieldKey, operator, value }
  sortOrder: integer("sort_order").notNull().default(0),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("custom_field_defs_company_id_idx").on(t.companyId),
  index("custom_field_defs_entity_idx").on(t.companyId, t.entityType),
  index("custom_field_defs_deleted_at_idx").on(t.deletedAt),
]);

// Polymorphic value store: one row per (definition, entity). Values are
// hard-upserted/deleted (no soft-delete) — a value only exists while set. The
// stored `value` is a serialized representation of the typed value (JSON array
// for multi-select, plain string otherwise).
export const customFieldValuesTable = pgTable("custom_field_values", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  definitionId: integer("definition_id").notNull().references(() => customFieldDefinitionsTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(), // lead | contact
  entityId: integer("entity_id").notNull(),
  value: text("value"), // serialized typed value
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("custom_field_values_company_id_idx").on(t.companyId),
  index("custom_field_values_entity_idx").on(t.companyId, t.entityType, t.entityId),
  // One value per definition per entity — upserts target this constraint.
  uniqueIndex("custom_field_values_def_entity_uq").on(t.definitionId, t.entityId),
]);

export const insertCustomFieldDefinitionSchema = createInsertSchema(customFieldDefinitionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCustomFieldValueSchema = createInsertSchema(customFieldValuesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCustomFieldDefinition = z.infer<typeof insertCustomFieldDefinitionSchema>;
export type CustomFieldDefinition = typeof customFieldDefinitionsTable.$inferSelect;
export type InsertCustomFieldValue = z.infer<typeof insertCustomFieldValueSchema>;
export type CustomFieldValue = typeof customFieldValuesTable.$inferSelect;
