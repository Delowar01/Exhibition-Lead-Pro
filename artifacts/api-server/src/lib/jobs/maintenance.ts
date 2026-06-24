import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import {
  db,
  sessionsTable,
  notificationsTable,
  invitationsTable,
  auditLogsTable,
} from "@workspace/db";
import { config } from "../../config.js";
import { logger } from "../logger.js";
import * as tokensRepo from "../../repositories/verification_tokens.repository.js";

// Recurring maintenance tasks (Phase 2.6). Each task is idempotent and safe to run
// repeatedly and concurrently across instances: they operate on time-windowed rows
// (older than a cutoff) or on a terminal state transition (pending -> expired), so a
// double run simply finds nothing left to do. Each returns the number of affected
// rows for observability.

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Delete verification tokens (password reset / email verify) that have already
// expired. Correctness does not depend on this — findLiveToken filters on expiry —
// it just keeps the table small.
export async function cleanupExpiredTokens(): Promise<number> {
  await tokensRepo.deleteExpired();
  return 0; // repo helper does not report a count
}

// Delete sessions that are no longer usable AND old enough to retain no value:
// revoked or expired more than `sessionDays` ago. Active sessions are never touched.
export async function cleanupStaleSessions(): Promise<number> {
  const days = config.jobs.retention.sessionDays;
  if (days <= 0) return 0;
  const before = cutoff(days);
  const rows = await db
    .delete(sessionsTable)
    .where(
      or(
        lt(sessionsTable.expiresAt, before),
        and(isNotNull(sessionsTable.revokedAt), lt(sessionsTable.revokedAt, before)),
      ),
    )
    .returning({ id: sessionsTable.id });
  return rows.length;
}

// Transition pending invitations whose link has expired to the terminal `expired`
// state. Public accept/reject already reject expired links at request time; this just
// reflects the lifecycle in the stored status so listings are accurate.
export async function expireStaleInvitations(): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(invitationsTable)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(invitationsTable.status, "pending"), lt(invitationsTable.expiresAt, now)))
    .returning({ id: invitationsTable.id });
  return rows.length;
}

// Delete READ notifications older than `notificationDays`. Unread notifications are
// always retained so a user never loses an unseen alert to retention.
export async function cleanupOldNotifications(): Promise<number> {
  const days = config.jobs.retention.notificationDays;
  if (days <= 0) return 0;
  const before = cutoff(days);
  const rows = await db
    .delete(notificationsTable)
    .where(and(isNotNull(notificationsTable.readAt), lt(notificationsTable.createdAt, before)))
    .returning({ id: notificationsTable.id });
  return rows.length;
}

// OPT-IN audit-log retention. audit_logs is append-only by design, so this is a no-op
// unless an operator explicitly sets a positive JOBS_AUDIT_RETENTION_DAYS.
export async function cleanupOldAuditLogs(): Promise<number> {
  const days = config.jobs.retention.auditDays;
  if (days <= 0) return 0;
  const before = cutoff(days);
  const rows = await db
    .delete(auditLogsTable)
    .where(lt(auditLogsTable.createdAt, before))
    .returning({ id: auditLogsTable.id });
  return rows.length;
}

// Runs every maintenance task, isolating failures so one bad task never blocks the
// others. Returns a per-task summary for logging.
export async function runMaintenance(): Promise<Record<string, number | "error">> {
  const tasks: Array<[string, () => Promise<number>]> = [
    ["expiredTokens", cleanupExpiredTokens],
    ["staleSessions", cleanupStaleSessions],
    ["expiredInvitations", expireStaleInvitations],
    ["oldNotifications", cleanupOldNotifications],
    ["oldAuditLogs", cleanupOldAuditLogs],
  ];
  const summary: Record<string, number | "error"> = {};
  for (const [name, fn] of tasks) {
    try {
      summary[name] = await fn();
    } catch (err) {
      summary[name] = "error";
      logger.error({ err, task: name }, "Maintenance task failed");
    }
  }
  logger.info({ summary }, "Maintenance sweep complete");
  return summary;
}
