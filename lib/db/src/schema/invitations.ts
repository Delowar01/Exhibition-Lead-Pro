import { pgTable, serial, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// User invitations (Phase 2.5). An admin invites someone to join their company by
// email; an expiring, tokenized link lets the invitee accept (creating their user)
// or reject. Only the SHA-256 of the raw token is stored (`tokenHash`). Status
// lifecycle: pending -> accepted | rejected | cancelled | expired. `roleIds` carries
// the custom RBAC roles to assign on acceptance (validated against the company).
export const invitationsTable = pgTable("invitations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name"),
  role: text("role").notNull().default("employee"), // admin | employee
  roleIds: jsonb("role_ids").$type<number[]>().notNull().default([]),
  invitedByUserId: integer("invited_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  tokenHash: text("token_hash").notNull(),
  status: text("status").notNull().default("pending"), // pending | accepted | rejected | cancelled | expired
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  acceptedUserId: integer("accepted_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertInvitationSchema = createInsertSchema(invitationsTable).omit({ id: true, createdAt: true });
export type InsertInvitation = z.infer<typeof insertInvitationSchema>;
export type Invitation = typeof invitationsTable.$inferSelect;
