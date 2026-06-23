import { AppError } from "../middlewares/errorHandler.js";
import { type AuthUser } from "../middlewares/requireAuth.js";
import * as reportsRepo from "../repositories/reports.repository.js";

export async function getAdminDashboard(user: AuthUser) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

  const { totalContacts, totalLeads, totalEvents, teamCount, newContactsToday, wonLeadsCount, scansThisMonth } =
    await reportsRepo.adminDashboardCounts(user, today, startOfMonth);

  const conversionRate = totalLeads > 0 ? Math.round((wonLeadsCount / totalLeads) * 100) : 0;

  return { totalContacts, totalLeads, totalEvents, newContactsToday, conversionRate, scansThisMonth, teamCount };
}

export async function getLeadsByEvent(user: AuthUser) {
  const events = await reportsRepo.listEventsForLeadsByEvent(user);

  const result = await Promise.all(events.map(async (e) => {
    const leadCount = await reportsRepo.eventLeadCount(user, e.id);
    const wonCount = await reportsRepo.eventWonLeadCount(user, e.id);
    const conversionRate = leadCount > 0 ? Math.round((wonCount / leadCount) * 100) : 0;
    return { eventId: e.id, eventName: e.name, leadCount, wonCount, conversionRate, createdAt: e.createdAt.toISOString() };
  }));

  return result;
}

export async function getTeamPerformance(user: AuthUser) {
  const users = await reportsRepo.listUsersForTeamPerformance(user);

  const result = await Promise.all(users.map(async (u) => {
    const scanCount = await reportsRepo.userScanCount(u.id);
    const leadCount = await reportsRepo.userLeadCount(u.id);
    const wonCount = await reportsRepo.userWonLeadCount(u.id);
    return { userId: u.id, userName: u.name, scanCount, leadCount, wonCount };
  }));

  return result;
}

export async function getScanActivity(user: AuthUser) {
  const since = new Date();
  since.setDate(since.getDate() - 29);
  since.setHours(0, 0, 0, 0);

  const rows = await reportsRepo.scanActivityByDay(user, since);

  const counts = new Map(rows.map((r) => [r.day, Number(r.value)]));

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("default", { month: "short", day: "numeric" });
    days.push({ date: key, value: counts.get(key) ?? 0, label });
  }
  return days;
}

export async function getLeadIntelligence(user: AuthUser) {
  const todayDateStr = new Date().toISOString().slice(0, 10);

  const { hot, warm, cold, scoredCount, unscoredCount, avgRow, hotLeads, followUpsDue, followUpsDueCount } =
    await reportsRepo.leadIntelligenceData(user, todayDateStr);

  const averageScore = avgRow.avg != null ? Math.round(Number(avgRow.avg)) : null;

  return {
    temperatureBreakdown: { hot, warm, cold },
    scoredCount,
    unscoredCount,
    followUpsDueCount,
    averageScore,
    hotLeads,
    followUpsDue,
  };
}

export async function getMobileDashboard(user: AuthUser) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const todayDateStr = startOfToday.toISOString().slice(0, 10);

  const {
    todayLeads,
    totalContacts,
    contactedLeads,
    hotLeads,
    followUpsDue,
    meetingsScheduled,
    proposalsSent,
    pipelineRow,
    wonRow,
    lostRow,
    wonCount,
    lostCount,
    recentContacts,
  } = await reportsRepo.mobileDashboardData(user, startOfToday, todayDateStr);

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

  return {
    todayLeads,
    hotLeads,
    followUpsDue,
    meetingsScheduled,
    proposalsSent,
    contactedLeads,
    pipelineValue: Number(pipelineRow.pipelineValue ?? 0),
    wonValue: Number(wonRow.wonValue ?? 0),
    lostValue: Number(lostRow.lostValue ?? 0),
    conversionRate: wonCount + lostCount === 0 ? 0 : Math.round((wonCount / (wonCount + lostCount)) * 100),
    totalContacts,
    recentActivity,
  };
}

export interface EventReportParams {
  eventId?: string;
  assignedToId?: string;
  status?: string;
  temperature?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function getEventReport(user: AuthUser, params: EventReportParams) {
  const id = parseInt(String(params.eventId));
  if (Number.isNaN(id)) {
    throw new AppError(400, "eventId required");
  }
  const evt = await reportsRepo.findEventById(user, id);
  if (!evt) {
    throw new AppError(404, "Event not found");
  }

  const q = params as Record<string, string | undefined>;
  const assignedToId = q.assignedToId ? parseInt(q.assignedToId) : null;
  const statusFilter = q.status || null;
  const temperatureFilter = q.temperature || null;
  const dateFrom = q.dateFrom || null; // YYYY-MM-DD
  const dateTo = q.dateTo || null; // YYYY-MM-DD

  const contactRows = await reportsRepo.eventReportContacts(user, {
    eventId: id,
    assignedToId,
    statusFilter,
    temperatureFilter,
    dateFrom,
    dateTo,
  });

  const users = await reportsRepo.listUsersWithAvatar(user);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatarUrl]));

  const contactIds = contactRows.map((c) => c.id);

  const leadRows = await reportsRepo.eventReportLeads(user, { eventId: id, assignedToId, dateFrom, dateTo });

  let meetings = 0;
  let followUps = 0;
  if (contactIds.length > 0) {
    meetings = await reportsRepo.meetingsScheduledCount(contactIds);
    followUps = await reportsRepo.followUpsPendingCount(contactIds);
  }

  let hotLeads = 0;
  let warmLeads = 0;
  let coldLeads = 0;
  const statusMap = new Map<string, number>();
  const dayMap = new Map<string, number>();
  const userLeadMap = new Map<number, number>();
  const userQualifiedMap = new Map<number, number>();
  const userHotMap = new Map<number, number>();
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
      if (c.leadTemperature === "hot") {
        userHotMap.set(c.assignedToId, (userHotMap.get(c.assignedToId) ?? 0) + 1);
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
      hotLeads: userHotMap.get(uid) ?? 0,
    }))
    .sort((a, b) => b.leads - a.leads || b.qualified - a.qualified);
  const leadSourceBreakdown = [
    { source: "Business Card", count: cardSource },
    { source: "Manual Entry", count: manualSource },
  ].filter((s) => s.count > 0);

  return {
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
  };
}

export interface TeamMemberReportParams {
  eventId?: string;
  userId?: string;
}

export async function getTeamMemberReport(user: AuthUser, params: TeamMemberReportParams) {
  const eventId = parseInt(String(params.eventId));
  const userId = parseInt(String(params.userId));
  if (Number.isNaN(eventId) || Number.isNaN(userId)) {
    throw new AppError(400, "eventId and userId required");
  }

  const evt = await reportsRepo.findEventById(user, eventId);
  if (!evt) {
    throw new AppError(404, "Event not found");
  }

  const member = await reportsRepo.findTeamMember(user, userId);
  if (!member) {
    throw new AppError(404, "Team member not found");
  }

  const contactRows = await reportsRepo.teamMemberContacts(user, eventId, userId);

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

  const leadRows = await reportsRepo.teamMemberLeads(user, eventId, userId);

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
      ? await reportsRepo.statusHistoryForContacts(contactIds, userId)
      : [];

  if (contactIds.length > 0) {
    meetings = await reportsRepo.meetingsScheduledCount(contactIds);
    followUps = await reportsRepo.followUpsPendingCount(contactIds);
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

  return {
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
  };
}
