import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// One-time MFA recovery codes. Only the hash is stored; a code is consumed by
// setting `usedAt`. Regenerating codes deletes the prior set for the user.
export const mfaBackupCodesTable = pgTable("mfa_backup_codes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMfaBackupCodeSchema = createInsertSchema(mfaBackupCodesTable).omit({ id: true, createdAt: true });
export type InsertMfaBackupCode = z.infer<typeof insertMfaBackupCodeSchema>;
export type MfaBackupCode = typeof mfaBackupCodesTable.$inferSelect;
