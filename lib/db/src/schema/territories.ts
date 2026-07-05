import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { teamsTable } from "./teams";

// Sales territories (Stage 4A). A territory is a named set of matching rules
// (country/region/industry/city) that later assignment work (Stage 4C) can target
// to route matching leads/contacts to an owner or team. Tenant-scoped + additive;
// no lead/contact behavior changes here — this only defines the territory concept.
export const territoriesTable = pgTable("territories", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  name: text("name").notNull(),
  description: text("description"),
  matchCriteria: text("match_criteria"), // JSON: { countries:[], regions:[], industries:[], cities:[] }
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }), // default owner
  teamId: integer("team_id").references(() => teamsTable.id, { onDelete: "set null" }), // default team
  sortOrder: integer("sort_order").notNull().default(0),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // soft-delete marker; excluded from reads by default
}, (t) => [
  index("territories_company_id_idx").on(t.companyId),
  index("territories_assigned_to_id_idx").on(t.assignedToId),
  index("territories_team_id_idx").on(t.teamId),
  index("territories_deleted_at_idx").on(t.deletedAt),
]);

export const insertTerritorySchema = createInsertSchema(territoriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTerritory = z.infer<typeof insertTerritorySchema>;
export type Territory = typeof territoriesTable.$inferSelect;
