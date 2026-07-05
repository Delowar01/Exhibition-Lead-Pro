import { pgTable, serial, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Scheduled/recurring exports (Stage 4B — Import & Export Center). A schedule
// captures WHAT to export (entityType + format + a snapshot of the list filters)
// and HOW OFTEN (frequency). A recurring scheduler tick finds due schedules
// (active + nextRunAt <= now) and enqueues an export job that produces the file
// into object storage and records an export_runs row. Tenant-scoped + additive.
export const exportSchedulesTable = pgTable("export_schedules", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(), // contact | lead
  format: text("format").notNull(), // csv | excel | pdf | json
  filters: text("filters"), // JSON snapshot of the list-query filter params
  frequency: text("frequency").notNull(), // daily | weekly | monthly
  passwordProtected: boolean("password_protected").notNull().default(false),
  active: boolean("active").notNull().default(true),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("export_schedules_company_id_idx").on(t.companyId),
  index("export_schedules_next_run_idx").on(t.active, t.nextRunAt),
  index("export_schedules_deleted_at_idx").on(t.deletedAt),
]);

export const insertExportScheduleSchema = createInsertSchema(exportSchedulesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExportSchedule = z.infer<typeof insertExportScheduleSchema>;
export type ExportSchedule = typeof exportSchedulesTable.$inferSelect;
