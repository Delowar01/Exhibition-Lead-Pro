import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// In-app notification feed (Phase 2.5). One row per delivered notification to a user.
// `category` routes preferences + email mirroring (security, billing, invitations,
// reports, ai, subscription, events, user_mgmt). `readAt` null = unread. `link` is an
// optional in-app deep link. Email mirroring is decided at create time by the user's
// notification_preferences; this table is the in-app channel of record.
export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id"),
  category: text("category").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("notifications_user_id_idx").on(t.userId)]);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ id: true, createdAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
