import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Formal merge-history record (Stage 4A). Every contact merge writes one row
// capturing who merged, when, the surviving (primary) record, the merged-away
// (deleted) ids, the field-value choices applied, and a JSON snapshot of the
// pre-merge rows. The snapshot is retained so a later phase (Stage 4C) can offer
// undo. Append-only + tenant-scoped by company_id.
//
// entityType is an open text column ("contact" today) so a future lead/opportunity
// merge can reuse this table additively without a breaking migration.
export const mergeHistoryTable = pgTable("merge_history", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  entityType: text("entity_type").notNull(), // contact
  primaryId: integer("primary_id").notNull(), // surviving record id
  mergedIds: text("merged_ids").notNull(), // JSON array of merged-away (deleted) ids
  fieldChoices: text("field_choices"), // JSON of the backfilled field choices applied to the primary
  snapshot: text("snapshot"), // JSON snapshot of pre-merge rows (primary + duplicates) for undo
  performedById: integer("performed_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  undoneAt: timestamp("undone_at"), // set when a future undo reverses this merge
  undoneById: integer("undone_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("merge_history_company_id_idx").on(t.companyId),
  index("merge_history_entity_idx").on(t.companyId, t.entityType, t.primaryId),
  index("merge_history_created_at_idx").on(t.createdAt),
]);

export const insertMergeHistorySchema = createInsertSchema(mergeHistoryTable).omit({ id: true, createdAt: true });
export type InsertMergeHistory = z.infer<typeof insertMergeHistorySchema>;
export type MergeHistory = typeof mergeHistoryTable.$inferSelect;
