import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Per-user recent searches. Every executed advanced search records one row;
// the list is pruned to the most recent N per user+entityType. Tenant-scoped
// and owned by a single user.
export const recentSearchesTable = pgTable("recent_searches", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull().default("contacts"),
  label: text("label"), // human-readable summary of the query
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("recent_searches_user_id_idx").on(t.userId),
  index("recent_searches_company_id_idx").on(t.companyId),
]);

export const insertRecentSearchSchema = createInsertSchema(recentSearchesTable).omit({ id: true, createdAt: true });
export type InsertRecentSearch = z.infer<typeof insertRecentSearchSchema>;
export type RecentSearch = typeof recentSearchesTable.$inferSelect;
