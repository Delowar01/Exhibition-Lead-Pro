import { pgTable, serial, text, integer, boolean, jsonb, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// One Security Center policy row per company (Phase 2.4). Absent row = platform
// defaults. `mfaRequired` mirrors companies.mfaRequired (kept in sync) for a single
// policy surface. Domain/IP/country lists are enforced at login.
export const securityPoliciesTable = pgTable(
  "security_policies",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    passwordMinLength: integer("password_min_length").notNull().default(8),
    passwordRequireUppercase: boolean("password_require_uppercase").notNull().default(true),
    passwordRequireNumber: boolean("password_require_number").notNull().default(true),
    passwordRequireSymbol: boolean("password_require_symbol").notNull().default(false),
    sessionTimeoutMinutes: integer("session_timeout_minutes"),
    mfaRequired: boolean("mfa_required").notNull().default(false),
    allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>().notNull().default([]),
    blockedEmailDomains: jsonb("blocked_email_domains").$type<string[]>().notNull().default([]),
    allowedIps: jsonb("allowed_ips").$type<string[]>().notNull().default([]),
    allowedCountries: jsonb("allowed_countries").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.companyId)],
);

export const insertSecurityPolicySchema = createInsertSchema(securityPoliciesTable).omit({ id: true, createdAt: true });
export type InsertSecurityPolicy = z.infer<typeof insertSecurityPolicySchema>;
export type SecurityPolicy = typeof securityPoliciesTable.$inferSelect;
