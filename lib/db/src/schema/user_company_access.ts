import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

// Grants a user access to companies beyond their home company (multi-company access).
export const userCompanyAccessTable = pgTable(
  "user_company_access",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.companyId)],
);

export const insertUserCompanyAccessSchema = createInsertSchema(userCompanyAccessTable).omit({ id: true, createdAt: true });
export type InsertUserCompanyAccess = z.infer<typeof insertUserCompanyAccessSchema>;
export type UserCompanyAccess = typeof userCompanyAccessTable.$inferSelect;
