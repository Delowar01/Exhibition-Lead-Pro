import { Router } from "express";
import { db } from "@workspace/db";
import { contactsTable, leadsTable, eventsTable, usersTable, scansTable, meetingsTable, followUpsTable, contactStatusHistoryTable } from "@workspace/db";
import { eq, and, count, sql, desc, inArray, gte, lte, isNotNull, isNull } from "drizzle-orm";
import { requireAuth, tenantScope, canAccessCompany, type AuthRequest } from "../middlewares/requireAuth.js";

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

    const [{ totalContacts }] = await db.select({ totalContacts: count() }).from(contactsTable).where(and(whereClause, isNull(contactsTable.duplicateOfId)));
    const [{ totalLeads }] = await db.select({ totalLeads: count() }).from(leadsTable).where(leadWhere);
    const [{ totalEvents }] = await db.select({ totalEvents: count() }).from(eventsTable).where(eventWhere);
    const [{ teamCount }] = await db.select({ teamCount: count() }).from(usersTable).where(userWhere);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [{ newContactsToday }] = await db.select({ newContactsToday: count() }).from(contactsTable).where(and(whereClause, isNull(contactsTable.duplicateOfId), sql`${contactsTable.createdAt} >= ${today}`));

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
      return { eventId: e.id, eventName: e.name, leadCount, wonCount, conversionRate, createdAt: e.createdAt.toISOString() };
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
    const scanScope = tenantScope(req.user, scansTable.companyId);
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);

    const rows = await db
      .select({
        day: sql<string>`to_char(${scansTable.createdAt}, 'YYYY-MM-DD')`,
        value: count(),
      })
      .from(scansTable)
      .where(and(scanScope, gte(scansTable.createdAt, since)))
      .groupBy(sql`to_char(${scansTable.createdAt}, 'YYYY-MM-DD')`);

    const counts = new Map(rows.map((r) => [r.day, Number(r.value)]));

    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString("default", { month: "short", day: "numeric" });
      days.push({ date: key, value: counts.get(key) ?? 0, label });
    }
    res.json(days);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reports/lead-intelligence
router.get("/reports/lead-intelligence", async (req: AuthRequest, res) => {
  try {
    const contactScope = tenantScope(req.user, contactsTable.companyId);

    const [
      [{ hot }],
      [{ warm }],
      [{ cold }],
      [{ scoredCount }],
      [{ unscoredCount }],
      [avgRow],
    ] = await Promise.all([
      db.select({ hot: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), eq(contactsTable.leadTemperature, "hot"))),
      db.select({ warm: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), eq(contactsTable.leadTemperature, "warm"))),
      db.select({ cold: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), eq(contactsTable.leadTemperature, "cold"))),
      db.select({ scoredCount: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), isNotNull(contactsTable.leadScore))),
      db.select({ unscoredCount: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), sql`${contactsTable.leadScore} IS NULL`)),
      db.select({ avg: sql<string | null>`AVG(${contactsTable.leadScore})` }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), isNotNull(contactsTable.leadScore))),
    ]);

    const hotLeads = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        contactCompany: contactsTable.contactCompany,
        jobTitle: contactsTable.jobTitle,
        leadScore: contactsTable.leadScore,
        leadTemperature: contactsTable.leadTemperature,
        aiReasoning: contactsTable.aiReasoning,
      })
      .from(contactsTable)
      .where(and(contactScope, isNull(contactsTable.duplicateOfId), isNotNull(contactsTable.leadScore), sql`${contactsTable.status} NOT IN ('won', 'lost')`))
      .orderBy(desc(contactsTable.leadScore))
      .limit(6);

    const todayDateStr = new Date().toISOString().slice(0, 10);
    const followUpWhere = and(
      contactScope,
      isNull(contactsTable.duplicateOfId),
      isNotNull(contactsTable.followUpDate),
      lte(contactsTable.followUpDate, todayDateStr),
      sql`${contactsTable.status} NOT IN ('won', 'lost')`,
    );

    const [followUpsDue, [{ followUpsDueCount }]] = await Promise.all([
      db
        .select({
          id: contactsTable.id,
          firstName: contactsTable.firstName,
          lastName: contactsTable.lastName,
          contactCompany: contactsTable.contactCompany,
          followUpDate: contactsTable.followUpDate,
          status: contactsTable.status,
          leadScore: contactsTable.leadScore,
          leadTemperature: contactsTable.leadTemperature,
        })
        .from(contactsTable)
        .where(followUpWhere)
        .orderBy(contactsTable.followUpDate)
        .limit(6),
      db.select({ followUpsDueCount: count() }).from(contactsTable).where(followUpWhere),
    ]);

    const averageScore = avgRow.avg != null ? Math.round(Number(avgRow.avg)) : null;

    res.json({
      temperatureBreakdown: { hot, warm, cold },
      scoredCount,
      unscoredCount,
      followUpsDueCount,
      averageScore,
      hotLeads,
      followUpsDue,
    });
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
      [{ contactedLeads }],
      [{ hotLeads }],
      [{ followUpsDue }],
      [{ meetingsScheduled }],
      [{ proposalsSent }],
      [pipelineRow],
    ] = await Promise.all([
      db
        .select({ todayLeads: count() })
        .from(contactsTable)
        .where(and(contactScope, isNull(contactsTable.duplicateOfId), gte(contactsTable.createdAt, startOfToday))),
      db.select({ totalContacts: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId))),
      db
        .select({ contactedLeads: count() })
        .from(contactsTable)
        .where(and(contactScope, isNull(contactsTable.duplicateOfId), eq(contactsTable.status, "contacted"))),
      db
        .select({ hotLeads: count() })
        .from(contactsTable)
        .where(and(contactScope, isNull(contactsTable.duplicateOfId), inArray(contactsTable.status, ["qualified", "interested"]))),
      db
        .select({ followUpsDue: count() })
        .from(contactsTable)
        .where(
          and(
            contactScope,
            isNull(contactsTable.duplicateOfId),
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
      contactedLeads,
      pipelineValue: Number(pipelineRow.pipelineValue ?? 0),
      totalContacts,
      recentActivity,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reports/event?eventId= — full per-event report with optional filters
router.get("/reports/event", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(String(req.query.eventId));
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "eventId required" });
      return;
    }
    const [evt] = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
    if (!evt || !canAccessCompany(req.user, evt.companyId)) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const q = req.query as Record<string, string | undefined>;
    const assignedToId = q.assignedToId ? parseInt(q.assignedToId) : null;
    const statusFilter = q.status || null;
    const temperatureFilter = q.temperature || null;
    const dateFrom = q.dateFrom || null; // YYYY-MM-DD
    const dateTo = q.dateTo || null; // YYYY-MM-DD

    const contactConds = [
      eq(contactsTable.eventId, id),
      isNull(contactsTable.duplicateOfId),
      tenantScope(req.user, contactsTable.companyId),
    ];
    if (assignedToId != null && !Number.isNaN(assignedToId)) contactConds.push(eq(contactsTable.assignedToId, assignedToId));
    if (statusFilter) contactConds.push(eq(contactsTable.status, statusFilter));
    if (temperatureFilter) contactConds.push(eq(contactsTable.leadTemperature, temperatureFilter));
    if (dateFrom) contactConds.push(gte(contactsTable.createdAt, new Date(`${dateFrom}T00:00:00.000`)));
    if (dateTo) contactConds.push(lte(contactsTable.createdAt, new Date(`${dateTo}T23:59:59.999`)));

    const contactRows = await db
      .select({
        id: contactsTable.id,
        status: contactsTable.status,
        leadTemperature: contactsTable.leadTemperature,
        assignedToId: contactsTable.assignedToId,
        createdAt: contactsTable.createdAt,
        cardImageUrl: contactsTable.cardImageUrl,
      })
      .from(contactsTable)
      .where(and(...contactConds));

    const users = await db
      .select({ id: usersTable.id, name: usersTable.name, avatarUrl: usersTable.avatarUrl })
      .from(usersTable)
      .where(tenantScope(req.user, usersTable.companyId));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const userAvatar = new Map(users.map((u) => [u.id, u.avatarUrl]));

    const contactIds = contactRows.map((c) => c.id);

    const leadConds = [eq(leadsTable.eventId, id), tenantScope(req.user, leadsTable.companyId)];
    if (assignedToId != null && !Number.isNaN(assignedToId)) leadConds.push(eq(leadsTable.assignedToId, assignedToId));
    if (dateFrom) leadConds.push(gte(leadsTable.createdAt, new Date(`${dateFrom}T00:00:00.000`)));
    if (dateTo) leadConds.push(lte(leadsTable.createdAt, new Date(`${dateTo}T23:59:59.999`)));
    const leadRows = await db
      .select({ stage: leadsTable.stage, value: leadsTable.value, assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(...leadConds));

    let meetings = 0;
    let followUps = 0;
    if (contactIds.length > 0) {
      const [m] = await db
        .select({ c: count() })
        .from(meetingsTable)
        .where(and(inArray(meetingsTable.contactId, contactIds), eq(meetingsTable.status, "scheduled")));
      const [f] = await db
        .select({ c: count() })
        .from(followUpsTable)
        .where(and(inArray(followUpsTable.contactId, contactIds), eq(followUpsTable.status, "pending")));
      meetings = m.c;
      followUps = f.c;
    }

    let hotLeads = 0;
    let warmLeads = 0;
    let coldLeads = 0;
    const statusMap = new Map<string, number>();
    const dayMap = new Map<string, number>();
    const userLeadMap = new Map<number, number>();
    const userQualifiedMap = new Map<number, number>();
    let cardSource = 0;
    let manualSource = 0;
    for (const c of contactRows) {
      if (c.leadTemperature === "hot") hotLeads++;
      else if (c.leadTemperature === "warm") warmLeads++;
      else if (c.leadTemperature === "cold") coldLeads++;
      statusMap.set(c.status, (statusMap.get(c.status) ?? 0) + 1);
      const day = c.createdAt.toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
      if (c.assignedToId != null) {
        userLeadMap.set(c.assignedToId, (userLeadMap.get(c.assignedToId) ?? 0) + 1);
        if (c.status === "qualified" || c.status === "interested") {
          userQualifiedMap.set(c.assignedToId, (userQualifiedMap.get(c.assignedToId) ?? 0) + 1);
        }
      }
      if (c.cardImageUrl) cardSource++;
      else manualSource++;
    }

    let wonDeals = 0;
    let lostDeals = 0;
    let pipelineValue = 0;
    const wonByUser = new Map<number, number>();
    for (const l of leadRows) {
      if (l.stage === "won") {
        wonDeals++;
        if (l.assignedToId != null) wonByUser.set(l.assignedToId, (wonByUser.get(l.assignedToId) ?? 0) + 1);
      } else if (l.stage === "lost") {
        lostDeals++;
      } else {
        pipelineValue += Number(l.value ?? 0);
      }
    }

    const statusDistribution = [...statusMap.entries()].map(([status, c]) => ({ status, count: c }));
    const leadsByDay = [...dayMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, c]) => ({ date, count: c }));
    const leadsByUser = [...userLeadMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([uid, c]) => ({ userId: uid, userName: userName.get(uid) ?? "Unassigned", count: c }));
    const teamUserIds = new Set<number>([...userLeadMap.keys(), ...wonByUser.keys()]);
    const teamPerformance = [...teamUserIds]
      .map((uid) => ({
        userId: uid,
        userName: userName.get(uid) ?? "Unknown",
        avatarUrl: userAvatar.get(uid) ?? null,
        leads: userLeadMap.get(uid) ?? 0,
        qualified: userQualifiedMap.get(uid) ?? 0,
        won: wonByUser.get(uid) ?? 0,
      }))
      .sort((a, b) => b.leads - a.leads || b.qualified - a.qualified);
    const leadSourceBreakdown = [
      { source: "Business Card", count: cardSource },
      { source: "Manual Entry", count: manualSource },
    ].filter((s) => s.count > 0);

    res.json({
      eventId: evt.id,
      eventName: evt.name,
      totalLeads: contactRows.length,
      hotLeads,
      warmLeads,
      coldLeads,
      meetings,
      followUps,
      wonDeals,
      lostDeals,
      pipelineValue,
      qualificationDistribution: { hot: hotLeads, warm: warmLeads, cold: coldLeads },
      statusDistribution,
      leadsByDay,
      leadsByUser,
      teamPerformance,
      leadSourceBreakdown,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reports/team-member?eventId=&userId= — per-member performance for one event
router.get("/reports/team-member", async (req: AuthRequest, res) => {
  try {
    const eventId = parseInt(String(req.query.eventId));
    const userId = parseInt(String(req.query.userId));
    if (Number.isNaN(eventId) || Number.isNaN(userId)) {
      res.status(400).json({ error: "eventId and userId required" });
      return;
    }

    const [evt] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId)).limit(1);
    if (!evt || !canAccessCompany(req.user, evt.companyId)) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const [member] = await db
      .select({ id: usersTable.id, name: usersTable.name, avatarUrl: usersTable.avatarUrl })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), tenantScope(req.user, usersTable.companyId)))
      .limit(1);
    if (!member) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }

    const contactRows = await db
      .select({
        id: contactsTable.id,
        fullName: contactsTable.fullName,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        status: contactsTable.status,
        createdAt: contactsTable.createdAt,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.eventId, eventId),
          eq(contactsTable.assignedToId, userId),
          isNull(contactsTable.duplicateOfId),
          tenantScope(req.user, contactsTable.companyId),
        ),
      );

    const contactIds = contactRows.map((c) => c.id);
    const contactName = new Map(
      contactRows.map((c) => [
        c.id,
        (c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ")).trim() || "Unknown contact",
      ]),
    );

    let totalLeads = contactRows.length;
    let qualifiedLeads = 0;
    for (const c of contactRows) {
      if (c.status === "qualified" || c.status === "interested") qualifiedLeads++;
    }

    const leadRows = await db
      .select({ stage: leadsTable.stage, value: leadsTable.value })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.eventId, eventId),
          eq(leadsTable.assignedToId, userId),
          tenantScope(req.user, leadsTable.companyId),
        ),
      );

    let won = 0;
    let lost = 0;
    let pipelineValue = 0;
    for (const l of leadRows) {
      if (l.stage === "won") won++;
      else if (l.stage === "lost") lost++;
      else pipelineValue += Number(l.value ?? 0);
    }

    let meetings = 0;
    let followUps = 0;
    const historyRows: { contactId: number; fromStatus: string | null; toStatus: string; createdAt: Date }[] =
      contactIds.length > 0
        ? await db
            .select({
              contactId: contactStatusHistoryTable.contactId,
              fromStatus: contactStatusHistoryTable.fromStatus,
              toStatus: contactStatusHistoryTable.toStatus,
              createdAt: contactStatusHistoryTable.createdAt,
            })
            .from(contactStatusHistoryTable)
            .where(
              and(
                inArray(contactStatusHistoryTable.contactId, contactIds),
                eq(contactStatusHistoryTable.changedById, userId),
              ),
            )
            .orderBy(desc(contactStatusHistoryTable.createdAt))
            .limit(40)
        : [];

    if (contactIds.length > 0) {
      const [m] = await db
        .select({ c: count() })
        .from(meetingsTable)
        .where(and(inArray(meetingsTable.contactId, contactIds), eq(meetingsTable.status, "scheduled")));
      const [f] = await db
        .select({ c: count() })
        .from(followUpsTable)
        .where(and(inArray(followUpsTable.contactId, contactIds), eq(followUpsTable.status, "pending")));
      meetings = m.c;
      followUps = f.c;
    }

    const conversionRate = totalLeads > 0 ? Math.round((won / totalLeads) * 100) : 0;

    type Activity = { type: string; contactName: string; label: string; timestamp: string };
    const activity: Activity[] = [];
    for (const c of contactRows) {
      activity.push({
        type: "captured",
        contactName: contactName.get(c.id) ?? "Unknown contact",
        label: "Lead captured",
        timestamp: c.createdAt.toISOString(),
      });
    }
    for (const h of historyRows) {
      activity.push({
        type: "status_change",
        contactName: contactName.get(h.contactId) ?? "Unknown contact",
        label: h.fromStatus
          ? `Status: ${h.fromStatus} → ${h.toStatus}`
          : `Status set to ${h.toStatus}`,
        timestamp: h.createdAt.toISOString(),
      });
    }
    activity.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    res.json({
      eventId: evt.id,
      eventName: evt.name,
      userId: member.id,
      userName: member.name,
      avatarUrl: member.avatarUrl ?? null,
      totalLeads,
      qualifiedLeads,
      meetings,
      followUps,
      won,
      lost,
      pipelineValue,
      conversionRate,
      activity: activity.slice(0, 25),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
