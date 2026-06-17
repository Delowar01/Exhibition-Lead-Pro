import { Router } from "express";
import { db } from "@workspace/db";
import { eventsTable, contactsTable, leadsTable } from "@workspace/db";
import { eq, ilike, and, count } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

async function enrichEvent(e: typeof eventsTable.$inferSelect) {
  const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(eq(contactsTable.eventId, e.id));
  const [leadCount] = await db.select({ count: count() }).from(leadsTable).where(eq(leadsTable.eventId, e.id));
  return { ...e, contactCount: contactCount.count, leadCount: leadCount.count };
}

// GET /events
router.get("/events", async (req: AuthRequest, res) => {
  try {
    const { search, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;
    const companyId = req.user!.companyId;

    const conditions = [];
    if (companyId) conditions.push(eq(eventsTable.companyId, companyId));
    if (search) conditions.push(ilike(eventsTable.name, `%${search}%`));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(eventsTable).where(whereClause);
    const events = await db.select().from(eventsTable).where(whereClause).limit(limitNum).offset(offset).orderBy(eventsTable.createdAt);
    const enriched = await Promise.all(events.map(enrichEvent));
    res.json({ events: enriched, total, page: pageNum, limit: limitNum });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /events
router.post("/events", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { name, venue, startDate, endDate, boothNumber, description } = req.body;
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    const [event] = await db.insert(eventsTable).values({ companyId, name, venue, startDate: startDate ?? null, endDate: endDate ?? null, boothNumber, description }).returning();
    res.status(201).json(await enrichEvent(event));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /events/:id
router.get("/events/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [e] = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
    if (!e) { res.status(404).json({ error: "Event not found" }); return; }
    res.json(await enrichEvent(e));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /events/:id
router.patch("/events/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, venue, startDate, endDate, boothNumber, description } = req.body;
    const updateData: Record<string, unknown> = { name, venue, startDate, endDate, boothNumber, description };
    Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
    const [e] = await db.update(eventsTable).set(updateData as Parameters<typeof eventsTable.$inferSelect>[0]).where(eq(eventsTable.id, id)).returning();
    if (!e) { res.status(404).json({ error: "Event not found" }); return; }
    res.json(await enrichEvent(e));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /events/:id
router.delete("/events/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(eventsTable).where(eq(eventsTable.id, id));
    res.json({ success: true, message: "Event deleted" });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /events/:id/stats
router.get("/events/:id/stats", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [contactCount] = await db.select({ count: count() }).from(contactsTable).where(eq(contactsTable.eventId, id));
    const [leadCount] = await db.select({ count: count() }).from(leadsTable).where(eq(leadsTable.eventId, id));
    const wonLeads = await db.select({ count: count() }).from(leadsTable).where(and(eq(leadsTable.eventId, id), eq(leadsTable.stage, "won")));
    const byStage = await db.select({ stage: leadsTable.stage, count: count() }).from(leadsTable).where(eq(leadsTable.eventId, id)).groupBy(leadsTable.stage);
    const wonCount = wonLeads[0]?.count ?? 0;
    const total = leadCount[0]?.count ?? 0;
    const conversionRate = total > 0 ? Math.round((wonCount / total) * 100) : 0;
    res.json({ contactCount: contactCount.count, leadCount: leadCount.count, wonCount, conversionRate, byStage: byStage.map(s => ({ status: s.stage, count: s.count })) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
