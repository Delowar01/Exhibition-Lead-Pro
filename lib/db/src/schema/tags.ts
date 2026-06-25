import { pgTable, serial, text, integer, timestamp, varchar, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { leadsTable } from "./leads";

// Per-tenant tag catalog. `category` groups tags (Tags & Categories), e.g.
// "industry", "priority", "source". Uniqueness of name per company (among
// non-deleted rows) is enforced in the service.
export const tagsTable = pgTable("tags", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: varchar("color", { length: 9 }),
  category: text("category"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("tags_company_id_idx").on(t.companyId),
]);

// Lead ↔ tag join. companyId is denormalized for fast tenant-scoped filtering.
export const leadTagsTable = pgTable("lead_tags", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").notNull().references(() => tagsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_tags_lead_id_idx").on(t.leadId),
  index("lead_tags_tag_id_idx").on(t.tagId),
  unique("lead_tags_lead_tag_uq").on(t.leadId, t.tagId),
]);

export const insertTagSchema = createInsertSchema(tagsTable).omit({ id: true, createdAt: true });
export type InsertTag = z.infer<typeof insertTagSchema>;
export type Tag = typeof tagsTable.$inferSelect;
export type LeadTag = typeof leadTagsTable.$inferSelect;
