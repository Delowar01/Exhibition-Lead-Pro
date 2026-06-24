import type { AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import * as notifRepo from "../repositories/notifications.repository.js";
import { sendNotificationEmail } from "../lib/email/index.js";

// Notification categories (Phase 2.5). Preferences + email routing key off these.
export const CATEGORIES = [
  "security",
  "billing",
  "invitations",
  "reports",
  "ai",
  "subscription",
  "events",
  "user_mgmt",
] as const;
export type NotificationCategory = (typeof CATEGORIES)[number];

function isCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export interface CreateNotificationInput {
  userId: number;
  companyId?: number | null;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  link?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Central creation helper used across the app (invitations, security, billing, …).
// Resolves the recipient's per-category preference: writes the in-app row when the
// in-app channel is on (default), and mirrors to email when the email channel is on
// (default). Email is best-effort and never throws. Returns the in-app row (or null
// when in-app is disabled for the category).
export async function createNotification(input: CreateNotificationInput): Promise<notifRepo.Notification | null> {
  const pref = await notifRepo.getPreference(input.userId, input.category);
  const inAppOn = pref ? pref.inApp : true;
  const emailOn = pref ? pref.email : true;

  let row: notifRepo.Notification | null = null;
  if (inAppOn) {
    row = await notifRepo.insert({
      userId: input.userId,
      companyId: input.companyId ?? null,
      category: input.category,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      metadata: input.metadata ?? null,
    });
  }

  if (emailOn) {
    const [contact] = await notifRepo.findUserContacts([input.userId]);
    if (contact) {
      const absoluteLink = input.link
        ? `${config.email.appBaseUrl.replace(/\/$/, "")}${input.link.startsWith("/") ? "" : "/"}${input.link}`
        : null;
      await sendNotificationEmail({ to: contact.email, title: input.title, body: input.body, link: absoluteLink });
    }
  }

  return row;
}

export async function listNotifications(user: AuthUser, opts: { limit?: number; offset?: number; unreadOnly?: boolean }) {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const notifications = await notifRepo.list(user.id, { limit, offset, unreadOnly: Boolean(opts.unreadOnly) });
  return { notifications };
}

export async function getUnreadCount(user: AuthUser) {
  return { count: await notifRepo.unreadCount(user.id) };
}

export async function markRead(user: AuthUser, id: number) {
  const affected = await notifRepo.markRead(user.id, id);
  if (affected === 0) {
    // Either it does not exist, belongs to someone else, or was already read.
    // Treat already-read/own as success; only a truly missing/foreign row is 404.
    const exists = (await notifRepo.list(user.id, { limit: 200, unreadOnly: false })).some((n) => n.id === id);
    if (!exists) throw new AppError(404, "Notification not found");
  }
  return { success: true };
}

export async function markAllRead(user: AuthUser) {
  const updated = await notifRepo.markAllRead(user.id);
  return { success: true, updated };
}

export async function deleteNotification(user: AuthUser, id: number) {
  const affected = await notifRepo.remove(user.id, id);
  if (affected === 0) throw new AppError(404, "Notification not found");
  return { success: true };
}

// Returns the full per-category preference matrix, filling defaults (on/on) for any
// category the user has not explicitly customized.
export async function getPreferences(user: AuthUser) {
  const rows = await notifRepo.listPreferences(user.id);
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  const preferences = CATEGORIES.map((category) => {
    const row = byCategory.get(category);
    return { category, inApp: row ? row.inApp : true, email: row ? row.email : true };
  });
  return { preferences };
}

export async function updatePreference(user: AuthUser, input: { category?: unknown; inApp?: unknown; email?: unknown }) {
  if (!isCategory(input.category)) throw new AppError(400, "Invalid notification category");
  if (typeof input.inApp !== "boolean" || typeof input.email !== "boolean") {
    throw new AppError(400, "inApp and email must be booleans");
  }
  const row = await notifRepo.upsertPreference({
    userId: user.id,
    category: input.category,
    inApp: input.inApp,
    email: input.email,
  });
  return { category: row.category, inApp: row.inApp, email: row.email };
}

// Convenience: notify every member of a set of users (e.g. all company admins) of an
// event. Best-effort; logs and continues on individual failures.
export async function notifyUsers(userIds: number[], input: Omit<CreateNotificationInput, "userId">): Promise<void> {
  for (const userId of Array.from(new Set(userIds))) {
    try {
      await createNotification({ ...input, userId });
    } catch (err) {
      logger.error({ err, userId, category: input.category }, "Failed to create notification");
    }
  }
}
