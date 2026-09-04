import { Router } from "express";
import { db } from "@workspace/db";
import { tasksTable, contactsTable, usersTable } from "@workspace/db";
import { eq, and, or, inArray, asc, desc, ilike, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateTaskBody, UpdateTaskBody } from "@workspace/api-zod";
import { refAccessible, refInCompany } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";
import { AppError } from "../middlewares/errorHandler.js";
import { canAssignToOthers, createTask, emitTaskActivity } from "../services/tasks.service.js";

const router = Router();
router.use(requireAuth);
router.use("/tasks", requireTenantUser);
router.use("/tasks", blockReadOnlyMutations);
router.use("/tasks", auditMutations("tasks"));

// Sortable columns for GET /tasks (allowlist → real columns). Default createdAt desc.
const TASK_SORT: Record<string, AnyColumn> = {
  createdAt: tasksTable.createdAt,
  updatedAt: tasksTable.updatedAt,
  dueDate: tasksTable.dueDate,
  status: tasksTable.status,
  type: tasksTable.type,
  title: tasksTable.title,
};

type Row = typeof tasksTable.$inferSelect;

// Ownership rule for task mutations: admins manage any company task; a normal
// tenant user may only touch tasks assigned to THEM. Non-admins also cannot
// list other users' tasks (GET forces scope=mine), so an inaccessible task is
// answered exactly like a missing one — 404, never a hint that the id exists.
function canMutateTask(user: { id: number; role: string }, task: { assignedToId: number | null }): boolean {
  return canAssignToOthers(user.role) || task.assignedToId === user.id;
}

async function enrich(rows: Row[]) {
  const contactIds = [...new Set(rows.map(r => r.contactId).filter((v): v is number => v != null))];
  const userIds = [...new Set([...rows.map(r => r.assignedToId), ...rows.map(r => r.assignedById)].filter((v): v is number => v != null))];
  const contacts = contactIds.length ? await db.select({ id: contactsTable.id, fullName: contactsTable.fullName }).from(contactsTable).where(inArray(contactsTable.id, contactIds)) : [];
  const users = userIds.length ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const cName = new Map(contacts.map(c => [c.id, c.fullName]));
  const uName = new Map(users.map(u => [u.id, u.name]));
  return rows.map(r => ({
    ...r,
    contactName: r.contactId != null ? (cName.get(r.contactId) ?? null) : null,
    assignedToName: r.assignedToId != null ? (uName.get(r.assignedToId) ?? null) : null,
    assignedByName: r.assignedById != null ? (uName.get(r.assignedById) ?? null) : null,
  }));
}

// GET /tasks — defaults to tasks assigned to the caller; admins can pass scope=all
router.get("/tasks", async (req: AuthRequest, res) => {
  try {
    const { status, type, assignedTo, contactId, scope = "mine" } = req.query as Record<string, string>;
    const lq = parseListQuery(req.query, {
      defaultPageSize: 50,
      maxPageSize: 200,
      allowedSort: Object.keys(TASK_SORT),
      defaultSort: "createdAt",
    });
    const conditions: SQL[] = [];
    const tScope = tenantScope(req.user, tasksTable.companyId);
    if (tScope) conditions.push(tScope);
    if (scope === "all" && canAssignToOthers(req.user!.role)) {
      if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(tasksTable.assignedToId, parseInt(assignedTo)));
    } else {
      conditions.push(eq(tasksTable.assignedToId, req.user!.id));
    }
    if (status) conditions.push(eq(tasksTable.status, status));
    if (type) conditions.push(eq(tasksTable.type, type));
    if (contactId && !isNaN(parseInt(contactId))) conditions.push(eq(tasksTable.contactId, parseInt(contactId)));
    if (lq.search) {
      const term = `%${lq.search}%`;
      conditions.push(or(ilike(tasksTable.title, term), ilike(tasksTable.notes, term))!);
    }
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const sortCol = TASK_SORT[lq.sort ?? "createdAt"] ?? tasksTable.createdAt;
    const orderExpr = lq.order === "asc" ? asc(sortCol) : desc(sortCol);
    // Opt-in pagination: callers that pass no page/limit keep the full result set
    // (existing web/mobile clients sort/filter the whole list client-side).
    let query = db.select().from(tasksTable).where(whereClause).orderBy(orderExpr, desc(tasksTable.id)).$dynamic();
    if (lq.paginated) query = query.limit(lq.limit).offset(lq.offset);
    const rows = await query;
    const total = lq.paginated
      ? Number((await db.select({ c: sql<number>`count(*)::int` }).from(tasksTable).where(whereClause))[0]?.c ?? 0)
      : rows.length;
    res.json({ tasks: await enrich(rows), total });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /tasks — create / assign a task (rules live in services/tasks.service.ts,
// shared with the Batch 16 workflow engine).
router.post("/tasks", validateBody(CreateTaskBody), async (req: AuthRequest, res) => {
  try {
    const row = await createTask(req.user!, req.body ?? {});
    res.status(201).json((await enrich([row]))[0]);
  } catch (err) {
    if (err instanceof AppError) { res.status(err.statusCode).json({ error: err.message }); return; }
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /tasks/:id
router.patch("/tasks/:id", validateBody(UpdateTaskBody), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId) || !canMutateTask(req.user!, existing)) {
      res.status(404).json({ error: "Task not found" }); return;
    }
    const { title, type, status, contactId, dueDate, dueTime, notes, assignedToId } = req.body ?? {};
    if (assignedToId !== undefined && assignedToId !== existing.assignedToId && !canAssignToOthers(req.user!.role)) {
      res.status(403).json({ error: "You cannot reassign this task" }); return;
    }
    // Same-company FK invariant on update too: supplied refs must belong to the
    // task's own company (existing.companyId), not merely one the caller can access.
    if (assignedToId !== undefined && !(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (assignedToId !== undefined && !(await refInCompany("users", existing.companyId, assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (contactId !== undefined && contactId != null && !(await refAccessible(req.user, "contacts", contactId))) { res.status(400).json({ error: "Invalid contactId" }); return; }
    if (contactId !== undefined && !(await refInCompany("contacts", existing.companyId, contactId ?? null))) { res.status(400).json({ error: "Invalid contactId" }); return; }
    const updateData: Record<string, unknown> = { title, type, status, contactId, dueDate, dueTime, notes, assignedToId, updatedAt: new Date() };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
    const [row] = await db.update(tasksTable).set(updateData as Partial<typeof tasksTable.$inferInsert>).where(eq(tasksTable.id, id)).returning();
    // Meaningful status transitions land in the linked contact's Timeline.
    if (status !== undefined && status !== existing.status) {
      if (status === "completed") {
        await emitTaskActivity(row, req.user!.id, "task_completed", `Task completed: ${row.title}`, { from: existing.status });
      } else {
        await emitTaskActivity(row, req.user!.id, "task_status_change",
          status === "in_progress" ? `Task started: ${row.title}` : `Task marked ${status.replace(/_/g, " ")}: ${row.title}`,
          { from: existing.status, to: status });
      }
    }
    res.json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /tasks/:id
router.delete("/tasks/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select({ companyId: tasksTable.companyId, assignedToId: tasksTable.assignedToId }).from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId) || !canMutateTask(req.user!, existing)) {
      res.status(404).json({ error: "Task not found" }); return;
    }
    await db.delete(tasksTable).where(eq(tasksTable.id, id));
    res.json({ success: true, message: "Task deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
