import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { exportSchedulesTable } from "./export_schedules";

// A single produced export file (Stage 4B). Rows are created by both on-demand
// exports and scheduled exports (scheduleId set). File BYTES live in object
// storage (GCS); only METADATA lives here. companyId is the tenant boundary.
export const exportRunsTable = pgTable("export_runs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  scheduleId: integer("schedule_id").references(() => exportSchedulesTable.id, { onDelete: "set null" }), // null = on-demand
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(), // contact | lead
  format: text("format").notNull(), // csv | excel | pdf | json
  status: text("status").notNull().default("completed"), // completed | failed
  objectPath: text("object_path"), // normalized /objects/... path in GCS (null on failure)
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull().default(0), // bytes
  rowCount: integer("row_count").notNull().default(0),
  passwordProtected: text("password_protected"), // "true"/"false" as recorded metadata
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
}, (t) => [
  index("export_runs_company_id_idx").on(t.companyId),
  index("export_runs_schedule_id_idx").on(t.scheduleId),
  index("export_runs_created_at_idx").on(t.companyId, t.createdAt),
]);

export const insertExportRunSchema = createInsertSchema(exportRunsTable).omit({ id: true, createdAt: true });
export type InsertExportRun = z.infer<typeof insertExportRunSchema>;
export type ExportRun = typeof exportRunsTable.$inferSelect;
