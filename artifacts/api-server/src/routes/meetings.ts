import { Router } from "express";
import { db } from "@workspace/db";
import { meetingsTable, contactsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, desc, type SQL } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { refAccessible } from "../lib/tenant.js";

const router = Router();
router.use(requireAuth);
router.use("/meetings", blockReadOnlyMutations);
router.use("/meetings", auditMutations("meetings"));

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
    const conditions: SQL[] = [];
    const scope = tenantScope(req.user, meetingsTable.companyId);
    if (scope) conditions.push(scope);
    if (status) conditions.push(eq(meetingsTable.status, status));
    if (contactId && !isNaN(parseInt(contactId))) conditions.push(eq(meetingsTable.contactId, parseInt(contactId)));
    if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(meetingsTable.assignedToId, parseInt(assignedTo)));
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select().from(meetingsTable).where(whereClause).orderBy(desc(meetingsTable.createdAt));
    res.json({ meetings: await enrich(rows), total: rows.length });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /meetings — schedule a meeting for a contact
router.post("/meetings", async (req: AuthRequest, res) => {
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
router.patch("/meetings/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select().from(meetingsTable).where(eq(meetingsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Meeting not found" }); return; }
    const { status, comment, meetingDate, meetingTime, type, notes } = req.body;

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
    const [row] = await db.update(meetingsTable).set(updateData as Partial<typeof meetingsTable.$inferInsert>).where(eq(meetingsTable.id, id)).returning();
    res.json((await enrich([row]))[0]);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
