import { pgTable, serial, text, integer, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { departmentsTable } from "./departments";
import { usersTable } from "./users";

// A working team inside a company, optionally nested under a department. The
// team leader (leaderId) is the team manager. Members are users whose teamId
// points here. soft-delete + status give an archive/restore lifecycle.
export const teamsTable = pgTable("teams", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Owning department (optional). set null if the department row is removed.
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  // Team leader / team manager — a user in the same tenant. set null if removed.
  leaderId: integer("leader_id").references((): AnyPgColumn => usersTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"), // active, archived
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; rows with a value are excluded from all reads by default
}, (t) => [
  index("teams_company_id_idx").on(t.companyId),
  index("teams_department_id_idx").on(t.departmentId),
]);

export const insertTeamSchema = createInsertSchema(teamsTable).omit({ id: true, createdAt: true });
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;
