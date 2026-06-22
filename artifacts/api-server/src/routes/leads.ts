import { Router } from "express";
import { db } from "@workspace/db";
import { leadsTable, leadHistoryTable, contactsTable, usersTable, eventsTable } from "@workspace/db";
import { eq, and, count, inArray, ne, desc } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, requirePermission, canAccessCompany, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { refAccessible } from "../lib/tenant.js";

const router = Router();
router.use(requireAuth);
router.use("/leads", blockReadOnlyMutations);
router.use("/leads", auditMutations("leads"));

const PIPELINE_STAGES = ["prospect", "qualified", "proposal_sent", "negotiation", "won", "lost"];

async function enrichLead(l: typeof leadsTable.$inferSelect, includeHistory = false) {
  const contact = l.contactId ? await db.select({ firstName: contactsTable.firstName, lastName: contactsTable.lastName, fullName: contactsTable.fullName, email: contactsTable.email, contactCompany: contactsTable.contactCompany }).from(contactsTable).where(eq(contactsTable.id, l.contactId)).then(r => r[0]) : null;
  const assignee = l.assignedToId ? await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, l.assignedToId)).then(r => r[0]) : null;
  const event = l.eventId ? await db.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.id, l.eventId)).then(r => r[0]) : null;

  let history: Array<{ id: number; leadId: number; changedBy: number | null; changedByName: string | null; fieldName: string; oldValue: string | null; newValue: string | null; changedAt: string }> = [];
  if (includeHistory) {
    const rows = await db
      .select({
        id: leadHistoryTable.id,
        leadId: leadHistoryTable.leadId,
        changedBy: leadHistoryTable.changedBy,
        changedByName: usersTable.name,
        fieldName: leadHistoryTable.fieldName,
        oldValue: leadHistoryTable.oldValue,
        newValue: leadHistoryTable.newValue,
        changedAt: leadHistoryTable.changedAt,
      })
      .from(leadHistoryTable)
      .leftJoin(usersTable, eq(leadHistoryTable.changedBy, usersTable.id))
      .where(eq(leadHistoryTable.leadId, l.id))
      .orderBy(desc(leadHistoryTable.changedAt));
    history = rows.map(r => ({ ...r, changedAt: r.changedAt.toISOString() }));
  }

  return {
    ...l,
    value: l.value ? parseFloat(l.value) : null,
    probability: l.probability ?? null,
    currency: l.currency ?? "USD",
    closingDate: l.closingDate ?? null,
    priority: l.priority ?? null,
    title: l.title ?? null,
    contactName: contact?.fullName ?? ([contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || null),
    contactEmail: contact?.email ?? null,
    contactCompany: contact?.contactCompany ?? null,
    companyName: l.companyName ?? null,
    assignedToName: assignee?.name ?? null,
    eventName: event?.name ?? null,
    history: includeHistory ? history : undefined,
  };
}

// GET /leads
router.get("/leads", async (req: AuthRequest, res) => {
  try {
    const { stage, assignedTo, eventId, contactId, page = "1", limit = "100" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(500, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;
    const conditions = [];
    if (req.user!.role !== "platform_owner") conditions.push(inArray(leadsTable.companyId, req.user!.accessibleCompanies));
    if (stage) conditions.push(eq(leadsTable.stage, stage));
    if (assignedTo && !isNaN(parseInt(assignedTo))) conditions.push(eq(leadsTable.assignedToId, parseInt(assignedTo)));
    if (eventId && !isNaN(parseInt(eventId))) conditions.push(eq(leadsTable.eventId, parseInt(eventId)));
    if (contactId && !isNaN(parseInt(contactId))) conditions.push(eq(leadsTable.contactId, parseInt(contactId)));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(leadsTable).where(whereClause);
    const leads = await db.select().from(leadsTable).where(whereClause).limit(limitNum).offset(offset).orderBy(leadsTable.createdAt);
    const enriched = await Promise.all(leads.map(l => enrichLead(l, false)));
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
    const { contactId, stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId } = req.body;

    if (contactId != null && !(await refAccessible(req.user, "contacts", contactId))) { res.status(400).json({ error: "Invalid contactId" }); return; }
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (!(await refAccessible(req.user, "events", eventId))) { res.status(400).json({ error: "Invalid eventId" }); return; }

    // 409 if this contact already has a non-lost lead in this company
    if (contactId != null) {
      const existing = await db.select({ id: leadsTable.id }).from(leadsTable)
        .where(and(eq(leadsTable.contactId, contactId), eq(leadsTable.companyId, companyId), ne(leadsTable.stage, "lost")))
        .limit(1);
      if (existing.length > 0) {
        res.status(409).json({ error: "Contact already has an open pipeline opportunity", existingId: existing[0].id });
        return;
      }
    }

    const [lead] = await db.insert(leadsTable).values({
      companyId,
      contactId: contactId ?? null,
      stage: stage ?? "prospect",
      title: title ?? null,
      value: value?.toString() ?? null,
      currency: currency ?? "USD",
      closingDate: closingDate ?? null,
      probability: probability ?? null,
      priority: priority ?? null,
      notes: notes ?? null,
      companyName: companyName ?? null,
      assignedToId: assignedToId ?? null,
      eventId: eventId ?? null,
      createdById: req.user!.id,
    }).returning();
    res.status(201).json(await enrichLead(lead, false));
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
    const enriched = await Promise.all(allLeads.map(l => enrichLead(l, false)));

    const stages = await Promise.all(PIPELINE_STAGES.map(async (stage) => {
      const stageLeads = enriched.filter(l => l.stage === stage);
      const value = stageLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
      return { stage, leads: stageLeads, count: stageLeads.length, value };
    }));

    const totalValue = enriched
      .filter(l => l.stage !== "won" && l.stage !== "lost")
      .reduce((sum, l) => sum + (l.value ?? 0), 0);
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
    res.json(await enrichLead(lead, true));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /leads/:id
router.patch("/leads/:id", requirePermission("leads", "edit"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const [existing] = await db.select().from(leadsTable).where(eq(leadsTable.id, id)).limit(1);
    if (!existing || !canAccessCompany(req.user, existing.companyId)) { res.status(404).json({ error: "Lead not found" }); return; }

    const { stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId } = req.body ?? {};
    if (!(await refAccessible(req.user, "users", assignedToId))) { res.status(400).json({ error: "Invalid assignedToId" }); return; }
    if (!(await refAccessible(req.user, "events", eventId))) { res.status(400).json({ error: "Invalid eventId" }); return; }

    const updateData: Record<string, unknown> = {};
    if (stage !== undefined) updateData.stage = stage;
    if (title !== undefined) updateData.title = title;
    if (value !== undefined) updateData.value = value?.toString() ?? null;
    if (currency !== undefined) updateData.currency = currency;
    if (closingDate !== undefined) updateData.closingDate = closingDate;
    if (probability !== undefined) updateData.probability = probability;
    if (priority !== undefined) updateData.priority = priority;
    if (notes !== undefined) updateData.notes = notes;
    if (companyName !== undefined) updateData.companyName = companyName;
    if (assignedToId !== undefined) updateData.assignedToId = assignedToId;
    if (eventId !== undefined) updateData.eventId = eventId;

    if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }

    // Write history rows for tracked fields
    const trackedFields: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [];
    if (stage !== undefined && stage !== existing.stage) {
      trackedFields.push({ field: "stage", oldVal: existing.stage, newVal: String(stage) });
    }
    if (value !== undefined) {
      const oldVal = existing.value ? String(parseFloat(existing.value)) : null;
      const newVal = value != null ? String(parseFloat(String(value))) : null;
      if (oldVal !== newVal) trackedFields.push({ field: "value", oldVal, newVal });
    }
    if (assignedToId !== undefined && assignedToId !== existing.assignedToId) {
      trackedFields.push({ field: "assignedToId", oldVal: existing.assignedToId != null ? String(existing.assignedToId) : null, newVal: assignedToId != null ? String(assignedToId) : null });
    }

    const [lead] = await db.transaction(async (tx) => {
      if (trackedFields.length > 0) {
        await tx.insert(leadHistoryTable).values(
          trackedFields.map(f => ({
            leadId: id,
            changedBy: req.user!.id,
            fieldName: f.field,
            oldValue: f.oldVal,
            newValue: f.newVal,
          }))
        );
      }
      return tx.update(leadsTable).set(updateData as Partial<typeof leadsTable.$inferInsert>).where(eq(leadsTable.id, id)).returning();
    });

    if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json(await enrichLead(lead, true));
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
