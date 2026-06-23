import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Server-side session backing a rotating refresh-token family. The access token
// (JWT) carries this session's id (`sid`); requireAuth validates the session each
// request so logout / terminate take effect immediately. The refresh token is
// looked up by the unguessable `familyId` (never the serial id). `refreshTokenHash`
// is the SHA-256 of the CURRENT refresh secret; `prevRefreshTokenHash` is the
// SHA-256 of the immediately-prior (rotated-out) secret. Presenting a PREVIOUSLY-
// valid secret is a proven theft/replay signal and revokes the whole family; an
// unknown/garbage secret is simply rejected (no revoke) so the family cannot be
// force-revoked by guessing.
export const sessionsTable = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  familyId: text("family_id").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  prevRefreshTokenHash: text("prev_refresh_token_hash"),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  browser: text("browser"),
  os: text("os"),
  deviceType: text("device_type"),
  country: text("country"),
  rememberMe: boolean("remember_me").notNull().default(false),
  lastUsedAt: timestamp("last_used_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({ id: true, createdAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
