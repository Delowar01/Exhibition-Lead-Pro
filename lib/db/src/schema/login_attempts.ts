import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Append-only record of every login attempt, used for brute-force lockout
// (count recent failures per email + IP) and security monitoring. Never has a
// cascade FK so attempts survive user deletion.
export const loginAttemptsTable = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  ipAddress: text("ip_address"),
  userId: integer("user_id"),
  success: boolean("success").notNull(),
  reason: text("reason"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertLoginAttemptSchema = createInsertSchema(loginAttemptsTable).omit({ id: true, createdAt: true });
export type InsertLoginAttempt = z.infer<typeof insertLoginAttemptSchema>;
export type LoginAttempt = typeof loginAttemptsTable.$inferSelect;
