import { pgTable, serial, text, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Custom + default roles (Phase 2.4 RBAC). `companyId` null + `isSystem` = a system
// template role shared across tenants; a non-null companyId = a tenant-owned custom role.
// `isDefault` marks the role auto-assignable to new members. Grants live in
// `role_permissions`; assignments live in `user_roles`. This model is ADDITIVE — the
// legacy per-user `users.permissions` JSON remains authoritative and is unioned with
// role-derived grants at the auth boundary, so no existing access is lost.
export const rolesTable = pgTable(
  "roles",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.companyId, t.name)],
);

export const insertRoleSchema = createInsertSchema(rolesTable).omit({ id: true, createdAt: true });
export type InsertRole = z.infer<typeof insertRoleSchema>;
export type Role = typeof rolesTable.$inferSelect;
