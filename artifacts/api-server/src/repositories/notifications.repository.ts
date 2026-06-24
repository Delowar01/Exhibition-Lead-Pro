import {
  db,
  notificationsTable,
  notificationPreferencesTable,
  usersTable,
  type Notification,
  type NotificationPreference,
} from "@workspace/db";
import { and, eq, isNull, desc, count, inArray } from "drizzle-orm";

export type { Notification, NotificationPreference };

export async function insert(values: typeof notificationsTable.$inferInsert): Promise<Notification> {
  const [row] = await db.insert(notificationsTable).values(values).returning();
  return row;
}

export async function list(userId: number, opts: { limit: number; offset?: number; unreadOnly: boolean }): Promise<Notification[]> {
  const where = opts.unreadOnly
    ? and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt))
    : eq(notificationsTable.userId, userId);
  return db
    .select()
    .from(notificationsTable)
    .where(where)
    .orderBy(desc(notificationsTable.createdAt))
    .limit(opts.limit)
    .offset(opts.offset ?? 0);
}

export async function unreadCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)));
  return Number(row?.c ?? 0);
}

// Marks a single notification read, scoped to the owner so a user cannot mark another
// user's notification. Returns the number of rows affected.
export async function markRead(userId: number, id: number): Promise<number> {
  const rows = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)))
    .returning({ id: notificationsTable.id });
  return rows.length;
}

export async function markAllRead(userId: number): Promise<number> {
  const rows = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)))
    .returning({ id: notificationsTable.id });
  return rows.length;
}

export async function remove(userId: number, id: number): Promise<number> {
  const rows = await db
    .delete(notificationsTable)
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, userId)))
    .returning({ id: notificationsTable.id });
  return rows.length;
}

export async function listPreferences(userId: number): Promise<NotificationPreference[]> {
  return db.select().from(notificationPreferencesTable).where(eq(notificationPreferencesTable.userId, userId));
}

export async function getPreference(userId: number, category: string): Promise<NotificationPreference | undefined> {
  const [row] = await db
    .select()
    .from(notificationPreferencesTable)
    .where(and(eq(notificationPreferencesTable.userId, userId), eq(notificationPreferencesTable.category, category)))
    .limit(1);
  return row;
}

// Upserts a single category preference for a user (unique on userId+category).
export async function upsertPreference(values: {
  userId: number;
  category: string;
  inApp: boolean;
  email: boolean;
}): Promise<NotificationPreference> {
  const [row] = await db
    .insert(notificationPreferencesTable)
    .values({ ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [notificationPreferencesTable.userId, notificationPreferencesTable.category],
      set: { inApp: values.inApp, email: values.email, updatedAt: new Date() },
    })
    .returning();
  return row;
}

// Fetches { email, name } for a set of user ids (used to mirror notifications to email).
export async function findUserContacts(userIds: number[]): Promise<{ id: number; email: string; name: string }[]> {
  if (userIds.length === 0) return [];
  return db
    .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
}
