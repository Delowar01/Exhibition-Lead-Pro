import { Router } from "express";
import { db } from "@workspace/db";
import { leadsTable, contactsTable, usersTable, eventsTable } from "@workspace/db";
import { eq, and, count, inArray } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, requirePermission, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { refAccessible } from "../lib/tenant.js";

const router = Router();
router.use(requireAuth);
router.use("/leads", blockReadOnlyMutations);
router.use("/leads", auditMutations("leads"));

const PIPELINE_STAGES = ["new", "contacted", "meeting_scheduled", "proposal_sent", "negotiation", "won", "lost"];

async function enrichLead(l: typeof leadsTable.$inferSelect) {
  const contact = l.contactId ? await db.select({ firstName: contactsTable.firstName, lastName: contactsTable.lastName, fullName: contactsTable.fullName, email: contactsTable.email, contactCompany: contactsTable.contactCompany }).from(contactsTable).where(eq(contactsTable.id, l.contactId)).then(r => r[0]) : null;
  const assignee = l.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, l.assignedToId)).then(r => r[0]) : null;
  const event = l.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, l.eventId)).then(r => r[0]) : null;
  return {
    ...l,
    value: l.value ? parseFloat(l.value) : null,
    contactName: contact?.fullName ?? ([contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || null),
    contactEmail: contact?.email ?? null,
    contactCompany: contact?.contactCompany ?? null,
    assignedToName: assignee?.name ?? null,
    eventName: event?.name ?? null,
  };
}

// GET /leads
router.get("/leads", async (req: AuthRequest, res) => {
  try {
    const { stage, assignedTo, eventId, page = "1", limit = "100" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(500, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    if (req.user!.role !== "platform_owner") conditions.push(inArray(leadsTable.companyId, req.user!.accessibleCompanies));
    if (stage) conditions.push(eq(leadsTable.stage, stage));
    if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(leadsTable.assignedToId, parseInt(assignedTo)));
    if (eventId && !isNaN(parseInt(eventId))) conditions.push(eq(leadsTable.eventId, parseInt(eventId)));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(leadsTable).where(whereClause);
    const leads = await db.select().from(leadsTable).where(whereClause).limit(limitNum).offset(offset).orderBy(leadsTable.createdAt);
    const enriched = await Promise.all(leads.map(enrichLead));
    res.json({ leads: enriched, total });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /leads
router.post("/leads", requirePermission("leads", "create"), async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { contactId, stage, value, notes, assignedToId, eventId } = req.body;
    if (!(await refAccessible(req.user, "contacts", contactId))) { res.status(400).json({ error: "Invalid contactId" }); return; }
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (!(await refAccessible(req.user, "events", eventId))) { res.status(400).json({ error: "Invalid eventId" }); return; }
    const [lead] = await db.insert(leadsTable).values({ companyId, contactId: contactId ?? null, stage: stage ?? "new", value: value?.toString() ?? null, notes, assignedToId: assignedToId ?? null, eventId: eventId ?? null }).returning();
    res.status(201).json(await enrichLead(lead));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /leads/pipeline
router.get("/leads/pipeline", async (req: AuthRequest, res) => {
  try {
    const whereClause = tenantScope(req.user, leadsTable.companyId);
    const allLeads = await db.select().from(leadsTable).where(whereClause).orderBy(leadsTable.createdAt);
    const enriched = await Promise.all(allLeads.map(enrichLead));

    const stages = await Promise.all(PIPELINE_STAGES.map(async (stage) => {
      const stageLeads = enriched.filter(l => l.stage === stage);
      const value = stageLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
      return { stage, leads: stageLeads, count: stageLeads.length, value };
    }));

    const totalValue = enriched.reduce((sum, l) => sum + (l.value ?? 0), 0);
    res.json({ stages, totalValue });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /leads/:id
router.get("/leads/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
    if (!lead || !canAccessCompany(req.user, lead.companyId)) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json(await enrichLead(lead));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /leads/:id
router.patch("/leads/:id", requirePermission("leads", "edit"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select({ companyId: leadsTable.companyId }).from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Lead not found" }); return; }
    const { stage, value, notes, assignedToId, eventId } = req.body;
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (!(await refAccessible(req.user, "events", eventId))) { res.status(400).json({ error: "Invalid eventId" }); return; }
    const updateData: Record<string, unknown> = { stage, value: value?.toString() ?? undefined, notes, assignedToId, eventId };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    const [lead] = await db.update(leadsTable).set(updateData as Partial<typeof leadsTable.$inferInsert>).where(eq(leadsTable.id, id)).returning();
    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json(await enrichLead(lead));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /leads/:id
router.delete("/leads/:id", requirePermission("leads", "delete"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select({ companyId: leadsTable.companyId }).from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Lead not found" }); return; }
    await db.delete(leadsTable).where(eq(leadsTable.id, id));
    res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
