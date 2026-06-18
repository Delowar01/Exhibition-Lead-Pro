import { Router } from "express";
import { db } from "@workspace/db";
import { tasksTable, contactsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, desc, type SQL } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { refAccessible } from "../lib/tenant.js";

const router = Router();
router.use(requireAuth);
router.use("/tasks", blockReadOnlyMutations);
router.use("/tasks", auditMutations("tasks"));

type Row = typeof tasksTable.$inferSelect;

// Only admins/leads may assign tasks to other users.
function canAssignToOthers(role: string): boolean {
  return role === "platform_owner" || role === "primary_admin" || role === "admin";
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
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select().from(tasksTable).where(whereClause).orderBy(desc(tasksTable.createdAt));
    res.json({ tasks: await enrich(rows), total: rows.length });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /tasks — create / assign a task
router.post("/tasks", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { title, type, contactId, dueDate, dueTime, notes, assignedToId } = req.body;
    if (!title) { res.status(400).json({ error: "title required" }); return; }
    // Non-admins can only create tasks for themselves.
    const targetUser = assignedToId ?? req.user!.id;
    if (targetUser !== req.user!.id && !canAssignToOthers(req.user!.role)) {
      res.status(403).json({ error: "You can only assign tasks to yourself" }); return;
    }
    if (!(await refAccessible(req.user, "users", targetUser))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (contactId != null && !(await refAccessible(req.user, "contacts", contactId))) { res.status(400).json({ error: "Invalid contactId" }); return; }
    const [row] = await db.insert(tasksTable).values({
      companyId, title, type: type ?? "custom", status: "pending", contactId: contactId ?? null,
      dueDate: dueDate ?? null, dueTime: dueTime ?? null, notes: notes ?? null, assignedToId: targetUser, assignedById: req.user!.id,
    }).returning();
    res.status(201).json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /tasks/:id
router.patch("/tasks/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Task not found" }); return; }
    const { title, type, status, contactId, dueDate, dueTime, notes, assignedToId } = req.body;
    if (assignedToId !== undefined && assignedToId !== existing.assignedToId && !canAssignToOthers(req.user!.role)) {
      res.status(403).json({ error: "You cannot reassign this task" }); return;
    }
    if (assignedToId !== undefined && !(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (contactId !== undefined && contactId != null && !(await refAccessible(req.user, "contacts", contactId))) { res.status(400).json({ error: "Invalid contactId" }); return; }
    const updateData: Record<string, unknown> = { title, type, status, contactId, dueDate, dueTime, notes, assignedToId, updatedAt: new Date() };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    const [row] = await db.update(tasksTable).set(updateData as Partial<typeof tasksTable.$inferInsert>).where(eq(tasksTable.id, id)).returning();
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
    const [existing] = await db.select({ companyId: tasksTable.companyId }).from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Task not found" }); return; }
    await db.delete(tasksTable).where(eq(tasksTable.id, id));
    res.json({ success: true, message: "Task deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
