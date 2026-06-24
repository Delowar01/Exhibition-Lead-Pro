import { Router } from "express";
import { db } from "@workspace/db";
import { meetingsTable, contactsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, asc, desc, ilike, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateMeetingBody, UpdateMeetingBody } from "@workspace/api-zod";
import { refAccessible } from "../lib/tenant.js";
import { parseListQuery } from "../lib/list-query.js";

const router = Router();
router.use(requireAuth);
router.use("/meetings", blockReadOnlyMutations);
router.use("/meetings", auditMutations("meetings"));

// Sortable columns for GET /meetings (allowlist → real columns). Default createdAt desc.
const MEETING_SORT: Record<string, AnyColumn> = {
  createdAt: meetingsTable.createdAt,
  updatedAt: meetingsTable.updatedAt,
  meetingDate: meetingsTable.meetingDate,
  status: meetingsTable.status,
  type: meetingsTable.type,
};

type Row = typeof meetingsTable.$inferSelect;

async function enrich(rows: Row[]) {
  const contactIds = [...new Set(rows.map(r => r.contactId))];
  const userIds = [...new Set(rows.map(r => r.assignedToId).filter((v): v is number => v != null))];
  const contacts = contactIds.length ? await db.select({ id: contactsTable.id, fullName: contactsTable.fullName }).from(contactsTable).where(inArray(contactsTable.id, contactIds)) : [];
  const users = userIds.length ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds)) : [];
  const cName = new Map(contacts.map(c => [c.id, c.fullName]));
  const uName = new Map(users.map(u => [u.id, u.name]));
  return rows.map(r => ({ ...r, contactName: cName.get(r.contactId) ?? null, assignedToName: r.assignedToId != null ? (uName.get(r.assignedToId) ?? null) : null }));
}

// GET /meetings
router.get("/meetings", async (req: AuthRequest, res) => {
  try {
    const { status, contactId, assignedTo } = req.query as Record<string, string>;
    const lq = parseListQuery(req.query, {
      defaultPageSize: 50,
      maxPageSize: 200,
      allowedSort: Object.keys(MEETING_SORT),
      defaultSort: "createdAt",
    });
    const conditions: SQL[] = [];
    const scope = tenantScope(req.user, meetingsTable.companyId);
    if (scope) conditions.push(scope);
    if (status) conditions.push(eq(meetingsTable.status, status));
    if (contactId && !isNaN(parseInt(contactId))) conditions.push(eq(meetingsTable.contactId, parseInt(contactId)));
    if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(meetingsTable.assignedToId, parseInt(assignedTo)));
    if (lq.search) conditions.push(ilike(meetingsTable.notes, `%${lq.search}%`));
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const sortCol = MEETING_SORT[lq.sort ?? "createdAt"] ?? meetingsTable.createdAt;
    const orderExpr = lq.order === "asc" ? asc(sortCol) : desc(sortCol);
    // Opt-in pagination: callers that pass no page/limit keep the full result set
    // (existing web/mobile clients filter the whole list client-side).
    let query = db.select().from(meetingsTable).where(whereClause).orderBy(orderExpr, desc(meetingsTable.id)).$dynamic();
    if (lq.paginated) query = query.limit(lq.limit).offset(lq.offset);
    const rows = await query;
    const total = lq.paginated
      ? Number((await db.select({ c: sql<number>`count(*)::int` }).from(meetingsTable).where(whereClause))[0]?.c ?? 0)
      : rows.length;
    res.json({ meetings: await enrich(rows), total });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /meetings — schedule a meeting for a contact
router.post("/meetings", validateBody(CreateMeetingBody), async (req: AuthRequest, res) => {
  try {
    const { contactId, meetingDate, meetingTime, type, notes, assignedToId } = req.body;
    if (typeof contactId !== "number") { res.status(400).json({ error: "contactId required" }); return; }
    if (!type) { res.status(400).json({ error: "type required" }); return; }
    const [contact] = await db.select({ companyId: contactsTable.companyId }).from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
    if (!contact || !canAccessCompany(req.user, contact.companyId)) { res.status(404).json({ error: "Contact not found" }); return; }
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    const [row] = await db.insert(meetingsTable).values({
      companyId: contact.companyId, contactId, meetingDate: meetingDate ?? null, meetingTime: meetingTime ?? null,
      type, notes: notes ?? null, status: "scheduled", assignedToId: assignedToId ?? null, createdById: req.user!.id,
    }).returning();
    res.status(201).json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /meetings/:id — action (complete / reschedule / cancel)
router.patch("/meetings/:id", validateBody(UpdateMeetingBody), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select().from(meetingsTable).where(eq(meetingsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Meeting not found" }); return; }
    const { status, comment, meetingDate, meetingTime, type, notes } = req.body ?? {};

    if (status === "rescheduled") {
      // Close the current row and open a new scheduled one (history preserved as rows).
      const newRow = await db.transaction(async (tx) => {
        await tx.update(meetingsTable).set({ status: "rescheduled", comment: comment ?? null, updatedAt: new Date() }).where(eq(meetingsTable.id, id));
        const [created] = await tx.insert(meetingsTable).values({
          companyId: existing.companyId, contactId: existing.contactId,
          meetingDate: meetingDate ?? existing.meetingDate, meetingTime: meetingTime ?? existing.meetingTime,
          type: type ?? existing.type, notes: notes ?? existing.notes, status: "scheduled", assignedToId: existing.assignedToId, createdById: req.user!.id,
        }).returning();
        return created;
      });
      res.json((await enrich([newRow]))[0]);
      return;
    }

    const updateData: Record<string, unknown> = { status, comment, meetingDate, meetingTime, type, notes, updatedAt: new Date() };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
    const [row] = await db.update(meetingsTable).set(updateData as Partial<typeof meetingsTable.$inferInsert>).where(eq(meetingsTable.id, id)).returning();
    res.json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
