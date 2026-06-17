import { pgTable, serial, text, boolean, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Permission matrix: module -> list of granted actions, e.g. { contacts: ["view","edit"] }.
export type UserPermissions = Record<string, string[]>;

// Visibility scope for a user's data access.
export type VisibilityScope = "own" | "selected" | "all";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  role: text("role").notNull().default("employee"), // platform_owner, primary_admin, admin, employee
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  avatarUrl: text("avatar_url"),
  permissions: jsonb("permissions").$type<UserPermissions>().notNull().default({}),
  contactVisibility: text("contact_visibility").notNull().default("all"), // own, selected, all
  companyVisibility: text("company_visibility").notNull().default("own"), // own, selected, all
  selectedUserIds: jsonb("selected_user_ids").$type<number[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
