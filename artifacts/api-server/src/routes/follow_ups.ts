import { Router } from "express";
import { db } from "@workspace/db";
import { followUpsTable, contactsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, asc, desc, ilike, isNotNull, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateFollowUpBody, UpdateFollowUpBody } from "@workspace/api-zod";
import { refAccessible } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";
import * as activitiesRepo from "../repositories/lead_activities.repository.js";

const router = Router();

// Sortable columns for GET /follow-ups (allowlist → real columns). Default createdAt desc.
const FOLLOW_UP_SORT: Record<string, AnyColumn> = {
  createdAt: followUpsTable.createdAt,
  updatedAt: followUpsTable.updatedAt,
  scheduledDate: followUpsTable.scheduledDate,
  status: followUpsTable.status,
};
router.use(requireAuth);
router.use("/follow-ups", requireTenantUser);
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

// Keep contacts.followUpDate/followUpTime mirroring the NEAREST upcoming pending
// scheduled follow-up (reminder scheduling and the AI copilot both read it):
// earliest scheduledDate wins, earliest scheduledTime breaks same-day ties (a
// row with no time sorts after concrete times), and pending rows WITHOUT a
// scheduled date never occupy the mirror. When no scheduled pending follow-up
// remains the mirror is cleared. companyId keeps the lookup tenant-pinned.
async function syncContactFollowUp(companyId: number, contactId: number) {
  const [next] = await db.select().from(followUpsTable)
    .where(and(
      eq(followUpsTable.companyId, companyId),
      eq(followUpsTable.contactId, contactId),
      eq(followUpsTable.status, "pending"),
      isNotNull(followUpsTable.scheduledDate),
    ))
    .orderBy(
      asc(followUpsTable.scheduledDate),
      sql`${followUpsTable.scheduledTime} ASC NULLS LAST`,
      asc(followUpsTable.id),
    )
    .limit(1);
  await db.update(contactsTable)
    .set({ followUpDate: next?.scheduledDate ?? null, followUpTime: next?.scheduledTime ?? null })
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.companyId, companyId)));
}

// Surface follow-up lifecycle in the contact's existing Timeline via the shared
// lead_activities feed (leadId stays null — these are contact-scoped events).
// Never throws: timeline logging must not break the underlying mutation.
async function emitFollowUpActivity(
  row: { id: number; companyId: number; contactId: number; scheduledDate: string | null; scheduledTime: string | null },
  userId: number,
  type: "follow_up_scheduled" | "follow_up_completed" | "follow_up_rescheduled" | "follow_up_cancelled",
  subject: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await activitiesRepo.insert({
      companyId: row.companyId,
      leadId: null,
      contactId: row.contactId,
      userId,
      type,
      source: "system",
      subject,
      metadata: { followUpId: row.id, scheduledDate: row.scheduledDate, scheduledTime: row.scheduledTime, ...metadata },
    });
  } catch {
    // swallow — see above
  }
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
    await syncContactFollowUp(contact.companyId, contactId);
    await emitFollowUpActivity(row, req.user!.id, "follow_up_scheduled",
      row.scheduledDate ? `Follow-up scheduled for ${row.scheduledDate}${row.scheduledTime ? ` ${row.scheduledTime}` : ""}` : "Follow-up scheduled",
      row.notes ? { notes: row.notes } : undefined);
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

    // Lifecycle actions (complete / reschedule / cancel) are only valid on a
    // PENDING row: terminal rows are the follow-up history and re-running an
    // action on one would corrupt it (e.g. a double-reschedule would spawn a
    // second "same reschedule" pending row).
    if ((status === "completed" || status === "rescheduled" || status === "cancelled") && existing.status !== "pending") {
      res.status(400).json({ error: `Only a pending follow-up can be ${status}` });
      return;
    }

    if (status === "rescheduled") {
      // Close the current row and open a new pending one (history preserved as
      // rows) — atomically, so a failure can never leave a half-applied reschedule.
      const newRow = await db.transaction(async (tx) => {
        await tx.update(followUpsTable).set({ status: "rescheduled", comment: comment ?? null, updatedAt: new Date() }).where(eq(followUpsTable.id, id));
        const [created] = await tx.insert(followUpsTable).values({
          companyId: existing.companyId, contactId: existing.contactId,
          scheduledDate: scheduledDate ?? existing.scheduledDate, scheduledTime: scheduledTime ?? existing.scheduledTime,
          notes: notes ?? existing.notes, status: "pending", assignedToId: existing.assignedToId, createdById: req.user!.id,
        }).returning();
        return created;
      });
      await syncContactFollowUp(existing.companyId, existing.contactId);
      await emitFollowUpActivity(newRow, req.user!.id, "follow_up_rescheduled",
        newRow.scheduledDate ? `Follow-up rescheduled to ${newRow.scheduledDate}${newRow.scheduledTime ? ` ${newRow.scheduledTime}` : ""}` : "Follow-up rescheduled",
        { previousFollowUpId: existing.id, previousDate: existing.scheduledDate, previousTime: existing.scheduledTime, ...(comment ? { comment } : {}) });
      res.json((await enrich([newRow]))[0]);
      return;
    }

    const updateData: Record<string, unknown> = { status, comment, scheduledDate, scheduledTime, notes, updatedAt: new Date() };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
    const [row] = await db.update(followUpsTable).set(updateData as Partial<typeof followUpsTable.$inferInsert>).where(eq(followUpsTable.id, id)).returning();
    await syncContactFollowUp(existing.companyId, existing.contactId);
    if (status === "completed" && existing.status === "pending") {
      await emitFollowUpActivity(row, req.user!.id, "follow_up_completed",
        row.scheduledDate ? `Follow-up completed (was scheduled for ${row.scheduledDate})` : "Follow-up completed",
        comment ? { comment } : undefined);
    } else if (status === "cancelled" && existing.status === "pending") {
      await emitFollowUpActivity(row, req.user!.id, "follow_up_cancelled",
        row.scheduledDate ? `Follow-up cancelled (was scheduled for ${row.scheduledDate})` : "Follow-up cancelled",
        comment ? { comment } : undefined);
    }
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
    await syncContactFollowUp(existing.companyId, existing.contactId);
    res.json({ success: true, message: "Follow-up deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
