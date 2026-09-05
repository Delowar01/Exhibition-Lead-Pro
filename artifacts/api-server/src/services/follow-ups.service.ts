import { followUpsTable, contactsTable } from "@workspace/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, type AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible, refInCompany } from "../lib/tenant.js";
import { exec, type Executor } from "../repositories/base.js";
import * as activitiesRepo from "../repositories/lead_activities.repository.js";

// Follow-up business rules (extracted verbatim from routes/follow_ups.ts so the
// HTTP route and the Batch 16 workflow engine share ONE implementation).

export type FollowUpRow = typeof followUpsTable.$inferSelect;

// Keep contacts.followUpDate/followUpTime mirroring the NEAREST upcoming pending
// scheduled follow-up (reminder scheduling and the AI copilot both read it):
// earliest scheduledDate wins, earliest scheduledTime breaks same-day ties (a
// row with no time sorts after concrete times), and pending rows WITHOUT a
// scheduled date never occupy the mirror. When no scheduled pending follow-up
// remains the mirror is cleared. companyId keeps the lookup tenant-pinned.
export async function syncContactFollowUp(companyId: number, contactId: number, tx?: Executor): Promise<void> {
  const [next] = await exec(tx)
    .select()
    .from(followUpsTable)
    .where(and(eq(followUpsTable.companyId, companyId), eq(followUpsTable.contactId, contactId), eq(followUpsTable.status, "pending"), isNotNull(followUpsTable.scheduledDate)))
    .orderBy(asc(followUpsTable.scheduledDate), sql`${followUpsTable.scheduledTime} ASC NULLS LAST`, asc(followUpsTable.id))
    .limit(1);
  await exec(tx)
    .update(contactsTable)
    .set({ followUpDate: next?.scheduledDate ?? null, followUpTime: next?.scheduledTime ?? null })
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.companyId, companyId)));
}

// Surface follow-up lifecycle in the contact's existing Timeline via the shared
// lead_activities feed (leadId stays null — these are contact-scoped events).
// Never throws: timeline logging must not break the underlying mutation.
export async function emitFollowUpActivity(
  row: { id: number; companyId: number; contactId: number; scheduledDate: string | null; scheduledTime: string | null },
  userId: number,
  type: "follow_up_scheduled" | "follow_up_completed" | "follow_up_rescheduled" | "follow_up_cancelled",
  subject: string,
  metadata?: Record<string, unknown>,
  tx?: Executor,
) {
  const values = {
    companyId: row.companyId,
    leadId: null,
    contactId: row.contactId,
    userId,
    type,
    source: "system",
    subject,
    metadata: { followUpId: row.id, scheduledDate: row.scheduledDate, scheduledTime: row.scheduledTime, ...metadata },
  };
  try {
    // Inside a caller transaction the insert runs in a savepoint so a failure can
    // never poison the outer transaction.
    if (tx) await tx.transaction(async (sp) => { await activitiesRepo.insert(values, sp); });
    else await activitiesRepo.insert(values);
  } catch {
    // swallow — see above
  }
}

export interface CreateFollowUpInput {
  contactId?: unknown;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  notes?: string | null;
  assignedToId?: number | null;
}

// Schedules a follow-up for a contact the caller can access. Same checks as the
// HTTP route: the assignee must belong to the CONTACT's company. `tx` lets the
// workflow engine commit the follow-up together with its own bookkeeping.
export async function createFollowUp(user: AuthUser, input: CreateFollowUpInput, tx?: Executor): Promise<FollowUpRow> {
  const { contactId, scheduledDate, scheduledTime, notes, assignedToId } = input;
  if (typeof contactId !== "number") throw new AppError(400, "contactId required");
  const [contact] = await exec(tx).select({ companyId: contactsTable.companyId }).from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
  if (!contact || !canAccessCompany(user, contact.companyId)) throw new AppError(404, "Contact not found");
  // Caller-scoped check PLUS the same-company FK invariant: the assignee must
  // belong to the CONTACT's company — a multi-company caller must not bind a
  // company-A follow-up to a company-B user.
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refInCompany("users", contact.companyId, assignedToId ?? null))) throw new AppError(400, "Invalid assignedToId");
  const [row] = await exec(tx)
    .insert(followUpsTable)
    .values({
      companyId: contact.companyId,
      contactId,
      scheduledDate: scheduledDate ?? null,
      scheduledTime: scheduledTime ?? null,
      notes: notes ?? null,
      status: "pending",
      assignedToId: assignedToId ?? null,
      createdById: user.id,
    })
    .returning();
  await syncContactFollowUp(contact.companyId, contactId, tx);
  await emitFollowUpActivity(
    row,
    user.id,
    "follow_up_scheduled",
    row.scheduledDate ? `Follow-up scheduled for ${row.scheduledDate}${row.scheduledTime ? ` ${row.scheduledTime}` : ""}` : "Follow-up scheduled",
    row.notes ? { notes: row.notes } : undefined,
    tx,
  );
  return row;
}
