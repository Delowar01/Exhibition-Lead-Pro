import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Per-user saved searches. A `filter` is a reusable set of query conditions; a
// `view` is a named saved query that reloads the full builder state (conditions,
// combinator, sort). Both are tenant-scoped AND owned by a single user.
export const savedSearchesTable = pgTable("saved_searches", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull().default("contacts"), // contacts | leads
  kind: text("kind").notNull().default("filter"), // filter | view
  name: text("name").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  index("saved_searches_company_id_idx").on(t.companyId),
  index("saved_searches_user_id_idx").on(t.userId),
]);

export const insertSavedSearchSchema = createInsertSchema(savedSearchesTable).omit({ id: true, createdAt: true });
export type InsertSavedSearch = z.infer<typeof insertSavedSearchSchema>;
export type SavedSearch = typeof savedSearchesTable.$inferSelect;
