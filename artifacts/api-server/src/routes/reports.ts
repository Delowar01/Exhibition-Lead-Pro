import { Router } from "express";
import { db } from "@workspace/db";
import { contactsTable, leadsTable, eventsTable, usersTable, scansTable } from "@workspace/db";
import { eq, and, count, sql, desc, inArray, gte, lte, isNotNull } from "drizzle-orm";
import { requireAuth, tenantScope, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

// GET /reports/admin-dashboard
router.get("/reports/admin-dashboard", async (req: AuthRequest, res) => {
  try {
    const whereClause = tenantScope(req.user, contactsTable.companyId);
    const leadWhere = tenantScope(req.user, leadsTable.companyId);
    const eventWhere = tenantScope(req.user, eventsTable.companyId);
    const userWhere = tenantScope(req.user, usersTable.companyId);
    const scanWhere = tenantScope(req.user, scansTable.companyId);

    const [{ totalContacts }] = await db.select({ totalContacts: count() }).from(contactsTable).where(whereClause);
    const [{ totalLeads }] = await db.select({ totalLeads: count() }).from(leadsTable).where(leadWhere);
    const [{ totalEvents }] = await db.select({ totalEvents: count() }).from(eventsTable).where(eventWhere);
    const [{ teamCount }] = await db.select({ teamCount: count() }).from(usersTable).where(userWhere);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [{ newContactsToday }] = await db.select({ newContactsToday: count() }).from(contactsTable).where(and(whereClause, sql`${contactsTable.createdAt} >= ${today}`));

    const wonLeads = await db.select({ count: count() }).from(leadsTable).where(and(leadWhere, eq(leadsTable.stage, "won")));
    const conversionRate = totalLeads > 0 ? Math.round((wonLeads[0].count / totalLeads) * 100) : 0;

    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
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
    const events = await db.select().from(eventsTable).where(tenantScope(req.user, eventsTable.companyId));

    const leadScope = tenantScope(req.user, leadsTable.companyId);
    const result = await Promise.all(events.map(async (e) => {
      const [{ leadCount }] = await db.select({ leadCount: count() }).from(leadsTable).where(and(eq(leadsTable.eventId, e.id), leadScope));
      const [{ wonCount }] = await db.select({ wonCount: count() }).from(leadsTable).where(and(eq(leadsTable.eventId, e.id), eq(leadsTable.stage, "won"), leadScope));
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
    const users = await db.select().from(usersTable).where(tenantScope(req.user, usersTable.companyId));

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

// GET /reports/mobile-dashboard
router.get("/reports/mobile-dashboard", async (req: AuthRequest, res) => {
  try {
    const contactScope = tenantScope(req.user, contactsTable.companyId);
    const leadScope = tenantScope(req.user, leadsTable.companyId);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const todayDateStr = startOfToday.toISOString().slice(0, 10);

    const [
      [{ todayLeads }],
      [{ totalContacts }],
      [{ hotLeads }],
      [{ followUpsDue }],
      [{ meetingsScheduled }],
      [{ proposalsSent }],
      [pipelineRow],
    ] = await Promise.all([
      db
        .select({ todayLeads: count() })
        .from(contactsTable)
        .where(and(contactScope, gte(contactsTable.createdAt, startOfToday))),
      db.select({ totalContacts: count() }).from(contactsTable).where(contactScope),
      db
        .select({ hotLeads: count() })
        .from(contactsTable)
        .where(and(contactScope, inArray(contactsTable.status, ["qualified", "interested"]))),
      db
        .select({ followUpsDue: count() })
        .from(contactsTable)
        .where(
          and(
            contactScope,
            isNotNull(contactsTable.followUpDate),
            lte(contactsTable.followUpDate, todayDateStr),
            sql`${contactsTable.status} NOT IN ('won', 'lost')`,
          ),
        ),
      db
        .select({ meetingsScheduled: count() })
        .from(leadsTable)
        .where(and(leadScope, eq(leadsTable.stage, "meeting_scheduled"))),
      db
        .select({ proposalsSent: count() })
        .from(leadsTable)
        .where(and(leadScope, eq(leadsTable.stage, "proposal_sent"))),
      db
        .select({
          pipelineValue: sql<string>`COALESCE(SUM(${leadsTable.value}), 0)`,
        })
        .from(leadsTable)
        .where(and(leadScope, sql`${leadsTable.stage} NOT IN ('won', 'lost')`)),
    ]);

    const recentContacts = await db
      .select({
        id: contactsTable.id,
        fullName: contactsTable.fullName,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        contactCompany: contactsTable.contactCompany,
        status: contactsTable.status,
        createdAt: contactsTable.createdAt,
      })
      .from(contactsTable)
      .where(contactScope)
      .orderBy(desc(contactsTable.createdAt))
      .limit(8);

    const recentActivity = recentContacts.map((c) => {
      const name =
        c.fullName ||
        [c.firstName, c.lastName].filter(Boolean).join(" ") ||
        "New contact";
      const createdToday =
        c.createdAt >= startOfToday && c.createdAt <= endOfToday;
      return {
        id: `contact-${c.id}`,
        type: createdToday ? "lead_captured" : "contact",
        title: name,
        subtitle: c.contactCompany ?? null,
        at: c.createdAt.toISOString(),
      };
    });

    res.json({
      todayLeads,
      hotLeads,
      followUpsDue,
      meetingsScheduled,
      proposalsSent,
      pipelineValue: Number(pipelineRow.pipelineValue ?? 0),
      totalContacts,
      recentActivity,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
