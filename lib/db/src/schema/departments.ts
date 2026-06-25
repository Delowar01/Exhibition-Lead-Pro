import { pgTable, serial, text, integer, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Organizational unit within a company. Supports a self-referential hierarchy
// (parentDepartmentId) so enterprises can model nested org structures. The
// department head (headId) points at a user; soft-delete + status give an
// archive/restore lifecycle without losing historical assignments.
export const departmentsTable = pgTable("departments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Department head — a user in the same tenant. set null if that user row is removed.
  headId: integer("head_id").references((): AnyPgColumn => usersTable.id, { onDelete: "set null" }),
  // Self-referential parent for nested org hierarchies. set null if parent removed.
  parentDepartmentId: integer("parent_department_id").references((): AnyPgColumn => departmentsTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"), // active, archived
  createdById: integer("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; rows with a value are excluded from all reads by default
}, (t) => [
  index("departments_company_id_idx").on(t.companyId),
  index("departments_parent_id_idx").on(t.parentDepartmentId),
]);

export const insertDepartmentSchema = createInsertSchema(departmentsTable).omit({ id: true, createdAt: true });
export type InsertDepartment = z.infer<typeof insertDepartmentSchema>;
export type Department = typeof departmentsTable.$inferSelect;
