import { Router } from "express";
import { db } from "@workspace/db";
import { contactsTable, leadsTable, eventsTable, usersTable, scansTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

// GET /reports/admin-dashboard
router.get("/reports/admin-dashboard", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    const conditions = companyId ? [eq(contactsTable.companyId, companyId)] : [];
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ totalContacts }] = await db.select({ totalContacts: count() }).from(contactsTable).where(whereClause);
    const leadConditions = companyId ? [eq(leadsTable.companyId, companyId)] : [];
    const leadWhere = leadConditions.length > 0 ? and(...leadConditions) : undefined;
    const [{ totalLeads }] = await db.select({ totalLeads: count() }).from(leadsTable).where(leadWhere);
    const eventConditions = companyId ? [eq(eventsTable.companyId, companyId)] : [];
    const eventWhere = eventConditions.length > 0 ? and(...eventConditions) : undefined;
    const [{ totalEvents }] = await db.select({ totalEvents: count() }).from(eventsTable).where(eventWhere);
    const userConditions = companyId ? [eq(usersTable.companyId, companyId)] : [];
    const userWhere = userConditions.length > 0 ? and(...userConditions) : undefined;
    const [{ teamCount }] = await db.select({ teamCount: count() }).from(usersTable).where(userWhere);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [{ newContactsToday }] = await db.select({ newContactsToday: count() }).from(contactsTable).where(and(whereClause, sql`${contactsTable.createdAt} >= ${today}`));

    const wonLeads = await db.select({ count: count() }).from(leadsTable).where(and(leadWhere, eq(leadsTable.stage, "won")));
    const conversionRate = totalLeads > 0 ? Math.round((wonLeads[0].count / totalLeads) * 100) : 0;

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const scanConditions = companyId ? [eq(scansTable.companyId, companyId)] : [];
    const scanWhere = scanConditions.length > 0 ? and(...scanConditions) : undefined;
    const [{ scansThisMonth }] = await db.select({ scansThisMonth: count() }).from(scansTable).where(and(scanWhere, sql`${scansTable.createdAt} >= ${startOfMonth}`));

    res.json({ totalContacts, totalLeads, totalEvents, newContactsToday, conversionRate, scansThisMonth, teamCount });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reports/leads-by-event
router.get("/reports/leads-by-event", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    const events = await db.select().from(eventsTable).where(companyId ? eq(eventsTable.companyId, companyId) : undefined);

    const result = await Promise.all(events.map(async (e) => {
      const [{ leadCount }] = await db.select({ leadCount: count() }).from(leadsTable).where(eq(leadsTable.eventId, e.id));
      const [{ wonCount }] = await db.select({ wonCount: count() }).from(leadsTable).where(and(eq(leadsTable.eventId, e.id), eq(leadsTable.stage, "won")));
      const conversionRate = leadCount > 0 ? Math.round((wonCount / leadCount) * 100) : 0;
      return { eventId: e.id, eventName: e.name, leadCount, wonCount, conversionRate };
    }));

    res.json(result);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reports/team-performance
router.get("/reports/team-performance", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    const users = await db.select().from(usersTable).where(companyId ? eq(usersTable.companyId, companyId) : undefined);

    const result = await Promise.all(users.map(async (u) => {
      const [{ scanCount }] = await db.select({ scanCount: count() }).from(scansTable).where(eq(scansTable.userId, u.id));
      const [{ leadCount }] = await db.select({ leadCount: count() }).from(leadsTable).where(eq(leadsTable.assignedToId, u.id));
      const [{ wonCount }] = await db.select({ wonCount: count() }).from(leadsTable).where(and(eq(leadsTable.assignedToId, u.id), eq(leadsTable.stage, "won")));
      return { userId: u.id, userName: u.name, scanCount, leadCount, wonCount };
    }));

    res.json(result);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reports/scan-activity
router.get("/reports/scan-activity", async (req: AuthRequest, res) => {
  try {
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("default", { month: "short", day: "numeric" });
      // Simulated trend data
      days.push({ date: d.toISOString().slice(0, 10), value: Math.floor(5 + Math.random() * 40), label });
    }
    res.json(days);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
