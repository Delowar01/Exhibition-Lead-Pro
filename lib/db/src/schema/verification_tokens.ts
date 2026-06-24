import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Single-use, expiring tokens for password reset and email verification (Phase 2.5).
// Only the SHA-256 of the raw token is stored (`tokenHash`); the raw token is mailed
// to the user and never persisted, so a DB read cannot recover a usable link.
// `usedAt` enforces single-use; `expiresAt` enforces expiry. `type` distinguishes the
// flow: "password_reset" | "email_verify".
export const verificationTokensTable = pgTable("verification_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // password_reset | email_verify
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertVerificationTokenSchema = createInsertSchema(verificationTokensTable).omit({ id: true, createdAt: true });
export type InsertVerificationToken = z.infer<typeof insertVerificationTokenSchema>;
export type VerificationToken = typeof verificationTokensTable.$inferSelect;
