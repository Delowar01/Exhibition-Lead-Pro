import { pgTable, serial, text, boolean, integer, jsonb, timestamp, date, uniqueIndex, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // MFA (TOTP). `mfaSecret` holds the AES-256-GCM-encrypted base32 secret; it is
  // never returned to clients. `mfaEnabled` gates the login challenge.
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaSecret: text("mfa_secret"),
  mfaEnrolledAt: timestamp("mfa_enrolled_at"),
  lastLoginAt: timestamp("last_login_at"),
  // Email verification (Phase 2.5). Null = unverified. ADDITIVE and non-blocking:
  // existing users default to null but are NOT prevented from signing in — the
  // verification flow surfaces status and lets users confirm, it does not gate login.
  emailVerifiedAt: timestamp("email_verified_at"),
  // Profile preferences (Phase 2.4).
  language: text("language").notNull().default("en"),
  timezone: text("timezone"),
  // ---- Organizational profile (Stage 3 Phase 1). All ADDITIVE & nullable so
  // existing users are unaffected; these power departments/teams, the employee
  // directory, the reporting-manager hierarchy, and future perf/analytics modules.
  // Human-facing employee identifier, unique per company (partial unique index below).
  employeeId: text("employee_id"),
  // Job title / designation, e.g. "Sales Manager".
  jobTitle: text("job_title"),
  // Employment lifecycle status — distinct from `isActive` (account enabled) and
  // company subscription status. Informational in Phase 1 (does not gate login).
  employmentStatus: text("employment_status").notNull().default("active"), // active, probation, on_leave, suspended, offboarded
  joiningDate: date("joining_date"),
  // Reporting manager — a user in the same tenant (self-reference).
  managerId: integer("manager_id").references((): AnyPgColumn => usersTable.id, { onDelete: "set null" }),
  departmentId: integer("department_id"),
  teamId: integer("team_id"),
  // Soft-delete (Phase 2.4 — deferred here from 2.3). Null = active. Login + auth
  // user-load must exclude soft-deleted users.
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("users_company_id_idx").on(t.companyId),
  index("users_department_id_idx").on(t.departmentId),
  index("users_team_id_idx").on(t.teamId),
  index("users_manager_id_idx").on(t.managerId),
  // employeeId is unique within a company, but only when set (existing rows are null).
  uniqueIndex("users_company_employee_id_idx").on(t.companyId, t.employeeId).where(sql`${t.employeeId} IS NOT NULL`),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
