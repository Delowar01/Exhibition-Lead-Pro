import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// First-class CRM Organization (Stage 5A — Company Entity Foundation). This is the
// customer-facing "Company" a contact/lead belongs to (an account in CRM terms).
//
// IMPORTANT naming: the existing `companies` table IS the tenant boundary (a
// paying tenant of the SaaS). This table is a DIFFERENT concept — a company/account
// tracked by a tenant inside their own CRM — hence the distinct `organizations`
// name. It is UI-labeled "Company". Every row is tenant-scoped by companyId.
//
// Introduced additively alongside the pre-existing free-text company fields
// (contacts.contactCompany, leads.companyName), which are retained. contacts.leads
// gain a nullable organizationId FK; a one-time backfill links existing rows.
export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  name: text("name").notNull(),
  // Lowercased/whitespace-collapsed name used for tenant-scoped dedup + backfill
  // matching against the legacy free-text company fields. Maintained by the service.
  normalizedName: text("normalized_name").notNull(),
  industry: text("industry"),
  website: text("website"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  country: text("country"),
  size: text("size"), // employee-count band (e.g. "1-10", "11-50", "51-200", ...)
  notes: text("notes"),
  status: text("status").notNull().default("active"), // active | archived
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("organizations_company_id_idx").on(t.companyId),
  index("organizations_company_normalized_idx").on(t.companyId, t.normalizedName),
  index("organizations_status_idx").on(t.status),
  index("organizations_deleted_at_idx").on(t.deletedAt),
]);

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
