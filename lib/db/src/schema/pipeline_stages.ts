import { pgTable, serial, text, integer, boolean, timestamp, varchar, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Per-tenant configurable lead pipeline stages. Leads keep their legacy text
// `stage` column for backward compatibility and additionally carry an optional
// `stageId` FK to a row here. Default stages (isDefault) are seeded per company
// and their `key` matches the legacy stage text values (prospect, qualified,
// proposal_sent, negotiation, won, lost) so existing leads map cleanly.
// `isWon`/`isLost` mark terminal stages (closed pipeline) for analytics + automation.
export const pipelineStagesTable = pgTable("pipeline_stages", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Stable slug; uniqueness (per company, among non-deleted rows) is enforced in the service.
  key: text("key").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isWon: boolean("is_won").notNull().default(false),
  isLost: boolean("is_lost").notNull().default(false),
  isDefault: boolean("is_default").notNull().default(false),
  color: varchar("color", { length: 9 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("pipeline_stages_company_id_idx").on(t.companyId),
  index("pipeline_stages_company_sort_idx").on(t.companyId, t.sortOrder),
]);

export const insertPipelineStageSchema = createInsertSchema(pipelineStagesTable).omit({ id: true, createdAt: true });
export type InsertPipelineStage = z.infer<typeof insertPipelineStageSchema>;
export type PipelineStage = typeof pipelineStagesTable.$inferSelect;
