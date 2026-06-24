import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Per-user, per-category notification preferences (Phase 2.5). Controls whether a
// category surfaces in-app and/or mirrors to email. A missing row means "use the
// default" (both channels on) — so this table is sparse and additive: existing users
// with no rows still receive in-app notifications. Unique on (userId, category).
export const notificationPreferencesTable = pgTable(
  "notification_preferences",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(true),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("notif_pref_user_category_uq").on(t.userId, t.category)],
);

export const insertNotificationPreferenceSchema = createInsertSchema(notificationPreferencesTable).omit({ id: true });
export type InsertNotificationPreference = z.infer<typeof insertNotificationPreferenceSchema>;
export type NotificationPreference = typeof notificationPreferencesTable.$inferSelect;
