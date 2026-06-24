import { Router } from "express";
import { db } from "@workspace/db";
import { followUpsTable, contactsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, asc, desc, ilike, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateFollowUpBody, UpdateFollowUpBody } from "@workspace/api-zod";
import { refAccessible } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";

const router = Router();

// Sortable columns for GET /follow-ups (allowlist → real columns). Default createdAt desc.
const FOLLOW_UP_SORT: Record<string, AnyColumn> = {
  createdAt: followUpsTable.createdAt,
  updatedAt: followUpsTable.updatedAt,
  scheduledDate: followUpsTable.scheduledDate,
  status: followUpsTable.status,
};
router.use(requireAuth);
router.use("/follow-ups", blockReadOnlyMutations);
router.use("/follow-ups", auditMutations("follow_ups"));

type Row = typeof followUpsTable.$inferSelect;

async function enrich(rows: Row[]) {
  const contactIds = [...new Set(rows.map(r => r.contactId))];
  const userIds = [...new Set(rows.map(r => r.assignedToId).filter((v): v is number => v != null))];
  const contacts = contactIds.length ? await db.select({ id: contactsTable.id, fullName: contactsTable.fullName }).from(contactsTable).where(inArray(contactsTable.id, contactIds)) : [];
  const users = userIds.length ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const cName = new Map(contacts.map(c => [c.id, c.fullName]));
  const uName = new Map(users.map(u => [u.id, u.name]));
  return rows.map(r => ({ ...r, contactName: cName.get(r.contactId) ?? null, assignedToName: r.assignedToId != null ? (uName.get(r.assignedToId) ?? null) : null }));
}

// Keep contacts.followUpDate/followUpTime denormalized to the most recent pending
// follow-up so existing push-notification scheduling keeps working.
async function syncContactFollowUp(contactId: number) {
  const [next] = await db.select().from(followUpsTable)
    .where(and(eq(followUpsTable.contactId, contactId), eq(followUpsTable.status, "pending")))
    .orderBy(desc(followUpsTable.scheduledDate)).limit(1);
  await db.update(contactsTable).set({ followUpDate: next?.scheduledDate ?? null, followUpTime: next?.scheduledTime ?? null }).where(eq(contactsTable.id, contactId));
}

// GET /follow-ups
router.get("/follow-ups", async (req: AuthRequest, res) => {
  try {
    const { status, contactId, assignedTo } = req.query as Record<string, string>;
    const lq = parseListQuery(req.query, {
      defaultPageSize: 50,
      maxPageSize: 200,
      allowedSort: Object.keys(FOLLOW_UP_SORT),
      defaultSort: "createdAt",
    });
    const conditions: SQL[] = [];
    const scope = tenantScope(req.user, followUpsTable.companyId);
    if (scope) conditions.push(scope);
    if (status) conditions.push(eq(followUpsTable.status, status));
    if (contactId && !isNaN(parseInt(contactId))) conditions.push(eq(followUpsTable.contactId, parseInt(contactId)));
    if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(followUpsTable.assignedToId, parseInt(assignedTo)));
    if (lq.search) conditions.push(ilike(followUpsTable.notes, `%${lq.search}%`));
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const sortCol = FOLLOW_UP_SORT[lq.sort ?? "createdAt"] ?? followUpsTable.createdAt;
    const orderExpr = lq.order === "asc" ? asc(sortCol) : desc(sortCol);
    // Opt-in pagination: callers that pass no page/limit keep the full result set
    // (existing web/mobile clients bucket the whole list client-side).
    let query = db.select().from(followUpsTable).where(whereClause).orderBy(orderExpr, desc(followUpsTable.id)).$dynamic();
    if (lq.paginated) query = query.limit(lq.limit).offset(lq.offset);
    const rows = await query;
    const total = lq.paginated
      ? Number((await db.select({ c: sql<number>`count(*)::int` }).from(followUpsTable).where(whereClause))[0]?.c ?? 0)
      : rows.length;
    res.json({ followUps: await enrich(rows), total });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /follow-ups — schedule a follow-up for a contact
router.post("/follow-ups", validateBody(CreateFollowUpBody), async (req: AuthRequest, res) => {
  try {
    const { contactId, scheduledDate, scheduledTime, notes, assignedToId } = req.body;
    if (typeof contactId !== "number") { res.status(400).json({ error: "contactId required" }); return; }
    const [contact] = await db.select({ companyId: contactsTable.companyId }).from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
    if (!contact || !canAccessCompany(req.user, contact.companyId)) { res.status(404).json({ error: "Contact not found" }); return; }
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    const [row] = await db.insert(followUpsTable).values({
      companyId: contact.companyId, contactId, scheduledDate: scheduledDate ?? null, scheduledTime: scheduledTime ?? null,
      notes: notes ?? null, status: "pending", assignedToId: assignedToId ?? null, createdById: req.user!.id,
    }).returning();
    await syncContactFollowUp(contactId);
    res.status(201).json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /follow-ups/:id — action (complete / reschedule / cancel)
router.patch("/follow-ups/:id", validateBody(UpdateFollowUpBody), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select().from(followUpsTable).where(eq(followUpsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Follow-up not found" }); return; }
    const { status, comment, scheduledDate, scheduledTime, notes } = req.body ?? {};

    if (status === "rescheduled") {
      // Close the current row and open a new pending one (history preserved as rows).
      const newRow = await db.transaction(async (tx) => {
        await tx.update(followUpsTable).set({ status: "rescheduled", comment: comment ?? null, updatedAt: new Date() }).where(eq(followUpsTable.id, id));
        const [created] = await tx.insert(followUpsTable).values({
          companyId: existing.companyId, contactId: existing.contactId,
          scheduledDate: scheduledDate ?? existing.scheduledDate, scheduledTime: scheduledTime ?? existing.scheduledTime,
          notes: notes ?? existing.notes, status: "pending", assignedToId: existing.assignedToId, createdById: req.user!.id,
        }).returning();
        return created;
      });
      await syncContactFollowUp(existing.contactId);
      res.json((await enrich([newRow]))[0]);
      return;
    }

    const updateData: Record<string, unknown> = { status, comment, scheduledDate, scheduledTime, notes, updatedAt: new Date() };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
    const [row] = await db.update(followUpsTable).set(updateData as Partial<typeof followUpsTable.$inferInsert>).where(eq(followUpsTable.id, id)).returning();
    await syncContactFollowUp(existing.contactId);
    res.json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /follow-ups/:id — remove a scheduled follow-up
router.delete("/follow-ups/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid follow-up id" }); return; }
    const [existing] = await db.select({ companyId: followUpsTable.companyId, contactId: followUpsTable.contactId }).from(followUpsTable).where(eq(followUpsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Follow-up not found" }); return; }
    await db.delete(followUpsTable).where(eq(followUpsTable.id, id));
    await syncContactFollowUp(existing.contactId);
    res.json({ success: true, message: "Follow-up deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
