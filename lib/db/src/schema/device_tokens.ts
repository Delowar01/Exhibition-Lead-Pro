import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Expo push tokens registered per user device. A user may have several devices;
// a token is globally unique and is re-pointed to the latest user on register.
export const deviceTokensTable = pgTable("device_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  platform: text("platform"), // ios, android
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDeviceTokenSchema = createInsertSchema(deviceTokensTable).omit({ id: true, createdAt: true });
export type InsertDeviceToken = z.infer<typeof insertDeviceTokenSchema>;
export type DeviceToken = typeof deviceTokensTable.$inferSelect;
