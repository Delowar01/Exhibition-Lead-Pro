import { tasksTable } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible, refInCompany } from "../lib/tenant.js";
import { exec, type Executor } from "../repositories/base.js";
import * as activitiesRepo from "../repositories/lead_activities.repository.js";

// Task creation business rules (extracted verbatim from routes/tasks.ts so the
// HTTP route and the Batch 16 workflow engine share ONE implementation — the
// engine never calls the API and never re-implements these rules).

export type TaskRow = typeof tasksTable.$inferSelect;

// Only admins/leads may assign tasks to other users.
export function canAssignToOthers(role: string): boolean {
  return role === "platform_owner" || role === "primary_admin" || role === "admin";
}

// Surface meaningful task lifecycle in the linked contact's Timeline via the
// shared lead_activities feed (leadId stays null — contact-scoped events).
// Tasks without a contact have no timeline home and emit nothing.
// Never throws: timeline logging must not break the underlying mutation.
export async function emitTaskActivity(
  task: { id: number; companyId: number; contactId: number | null; title: string; dueDate: string | null; dueTime: string | null },
  userId: number,
  type: "task_created" | "task_status_change" | "task_completed",
  subject: string,
  metadata?: Record<string, unknown>,
  tx?: Executor,
) {
  if (task.contactId == null) return;
  try {
    await activitiesRepo.insert(
      {
        companyId: task.companyId,
        leadId: null,
        contactId: task.contactId,
        userId,
        type,
        source: "system",
        subject,
        metadata: { taskId: task.id, title: task.title, dueDate: task.dueDate, dueTime: task.dueTime, ...metadata },
      },
      tx,
    );
  } catch {
    // swallow — see above
  }
}

export interface CreateTaskInput {
  title?: string | null;
  type?: string | null;
  contactId?: number | null;
  dueDate?: string | null;
  dueTime?: string | null;
  notes?: string | null;
  assignedToId?: number | null;
}

// Creates a task in the caller's company. Same checks as the HTTP route: title
// required, non-admins may only assign to themselves, and everything the task
// binds to (assignee, contact) must live in the task's own company. `tx` lets a
// caller (the workflow engine) commit the task together with its own bookkeeping.
export async function createTask(user: AuthUser, input: CreateTaskInput, tx?: Executor): Promise<TaskRow> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { title, type, contactId, dueDate, dueTime, notes, assignedToId } = input;
  if (!title) throw new AppError(400, "title required");
  // Non-admins can only create tasks for themselves.
  const targetUser = assignedToId ?? user.id;
  if (targetUser !== user.id && !canAssignToOthers(user.role)) throw new AppError(403, "You can only assign tasks to yourself");
  // Caller-scoped checks PLUS the same-company FK invariant: everything the
  // task binds to must live in the task's own company — a multi-company
  // caller must not point a company-A task at company-B records.
  if (!(await refAccessible(user, "users", targetUser))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refInCompany("users", companyId, targetUser))) throw new AppError(400, "Invalid assignedToId");
  if (contactId != null && !(await refAccessible(user, "contacts", contactId))) throw new AppError(400, "Invalid contactId");
  if (!(await refInCompany("contacts", companyId, contactId ?? null))) throw new AppError(400, "Invalid contactId");
  const [row] = await exec(tx)
    .insert(tasksTable)
    .values({
      companyId,
      title,
      type: type ?? "custom",
      status: "pending",
      contactId: contactId ?? null,
      dueDate: dueDate ?? null,
      dueTime: dueTime ?? null,
      notes: notes ?? null,
      assignedToId: targetUser,
      assignedById: user.id,
    })
    .returning();
  await emitTaskActivity(row, user.id, "task_created", `Task created: ${row.title}`, { assignedToId: row.assignedToId }, tx);
  return row;
}
