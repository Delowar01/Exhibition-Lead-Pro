import {
  db,
  contactsTable,
  leadsTable,
  eventsTable,
  usersTable,
  scansTable,
  meetingsTable,
  followUpsTable,
  contactStatusHistoryTable,
} from "@workspace/db";
import { eq, and, count, sql, desc, inArray, gte, lte, isNotNull, isNull } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { notDeleted } from "./base.js";

export type EventRow = typeof eventsTable.$inferSelect;

// ---------------------------------------------------------------------------
// getAdminDashboard
// All contacts/leads/events reads exclude soft-deleted rows via notDeleted().
// ---------------------------------------------------------------------------
export async function adminDashboardCounts(user: AuthUser, today: Date, startOfMonth: Date) {
  const whereClause = tenantScope(user, contactsTable.companyId);
  const leadWhere = tenantScope(user, leadsTable.companyId);
  const eventWhere = tenantScope(user, eventsTable.companyId);
  const userWhere = tenantScope(user, usersTable.companyId);
  const scanWhere = tenantScope(user, scansTable.companyId);

  // contacts: + notDeleted(contacts.deletedAt)
  const [{ totalContacts }] = await db
    .select({ totalContacts: count() })
    .from(contactsTable)
    .where(and(whereClause, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt)));
  // leads: + notDeleted(leads.deletedAt)
  const [{ totalLeads }] = await db
    .select({ totalLeads: count() })
    .from(leadsTable)
    .where(and(leadWhere, notDeleted(leadsTable.deletedAt)));
  // events: + notDeleted(events.deletedAt)
  const [{ totalEvents }] = await db
    .select({ totalEvents: count() })
    .from(eventsTable)
    .where(and(eventWhere, notDeleted(eventsTable.deletedAt)));
  const [{ teamCount }] = await db.select({ teamCount: count() }).from(usersTable).where(userWhere);

  // contacts: + notDeleted(contacts.deletedAt)
  const [{ newContactsToday }] = await db
    .select({ newContactsToday: count() })
    .from(contactsTable)
    .where(and(whereClause, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), sql`${contactsTable.createdAt} >= ${today}`));

  // leads: + notDeleted(leads.deletedAt)
  const wonLeads = await db
    .select({ count: count() })
    .from(leadsTable)
    .where(and(leadWhere, eq(leadsTable.stage, "won"), notDeleted(leadsTable.deletedAt)));

  const [{ scansThisMonth }] = await db
    .select({ scansThisMonth: count() })
    .from(scansTable)
    .where(and(scanWhere, sql`${scansTable.createdAt} >= ${startOfMonth}`));

  return {
    totalContacts,
    totalLeads,
    totalEvents,
    teamCount,
    newContactsToday,
    wonLeadsCount: wonLeads[0].count,
    scansThisMonth,
  };
}

// ---------------------------------------------------------------------------
// getLeadsByEvent
// ---------------------------------------------------------------------------
// events: + notDeleted(events.deletedAt)
export async function listEventsForLeadsByEvent(user: AuthUser): Promise<EventRow[]> {
  return await db
    .select()
    .from(eventsTable)
    .where(and(tenantScope(user, eventsTable.companyId), notDeleted(eventsTable.deletedAt)));
}

export interface EventLeadCountRow {
  eventId: number | null;
  leadCount: number;
  wonCount: number;
}

// One grouped pass over the tenant's leads: lead + won count per event, instead
// of two count queries per event (was 2*N queries for N events). won is a
// FILTER aggregate; .mapWith(Number) coerces pg's bigint-as-string to a number.
// leads: + notDeleted(leads.deletedAt)
export async function leadCountsByEvent(user: AuthUser): Promise<EventLeadCountRow[]> {
  return await db
    .select({
      eventId: leadsTable.eventId,
      leadCount: count(),
      wonCount: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.stage} = 'won')`.mapWith(Number),
    })
    .from(leadsTable)
    .where(and(tenantScope(user, leadsTable.companyId), notDeleted(leadsTable.deletedAt)))
    .groupBy(leadsTable.eventId);
}

// ---------------------------------------------------------------------------
// getTeamPerformance
// ---------------------------------------------------------------------------
export type UserRow = typeof usersTable.$inferSelect;

export async function listUsersForTeamPerformance(user: AuthUser): Promise<UserRow[]> {
  return await db.select().from(usersTable).where(tenantScope(user, usersTable.companyId));
}

export interface UserScanCountRow {
  userId: number | null;
  scanCount: number;
}

// One grouped pass over the tenant's scans: scan count per user (was one count
// query per user). Tenant-scoped — a user's scans live in their own company, so
// this matches the prior per-user count for every user in the team list.
export async function scanCountsByUser(user: AuthUser): Promise<UserScanCountRow[]> {
  return await db
    .select({ userId: scansTable.userId, scanCount: count() })
    .from(scansTable)
    .where(tenantScope(user, scansTable.companyId))
    .groupBy(scansTable.userId);
}

export interface UserLeadCountRow {
  userId: number | null;
  leadCount: number;
  wonCount: number;
}

// One grouped pass over the tenant's leads: lead + won count per assignee (was
// two count queries per user). leads: + notDeleted(leads.deletedAt)
export async function leadCountsByUser(user: AuthUser): Promise<UserLeadCountRow[]> {
  return await db
    .select({
      userId: leadsTable.assignedToId,
      leadCount: count(),
      wonCount: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.stage} = 'won')`.mapWith(Number),
    })
    .from(leadsTable)
    .where(and(tenantScope(user, leadsTable.companyId), notDeleted(leadsTable.deletedAt)))
    .groupBy(leadsTable.assignedToId);
}

// ---------------------------------------------------------------------------
// getScanActivity (scans has no deletedAt)
// ---------------------------------------------------------------------------
export async function scanActivityByDay(user: AuthUser, since: Date): Promise<{ day: string; value: number }[]> {
  const rows = await db
    .select({
      day: sql<string>`to_char(${scansTable.createdAt}, 'YYYY-MM-DD')`,
      value: count(),
    })
    .from(scansTable)
    .where(and(tenantScope(user, scansTable.companyId), gte(scansTable.createdAt, since)))
    .groupBy(sql`to_char(${scansTable.createdAt}, 'YYYY-MM-DD')`);
  return rows;
}

// ---------------------------------------------------------------------------
// getLeadIntelligence (all contacts reads exclude soft-deleted rows)
// ---------------------------------------------------------------------------
export async function leadIntelligenceData(user: AuthUser, todayDateStr: string) {
  const contactScope = tenantScope(user, contactsTable.companyId);

  const [
    [{ hot }],
    [{ warm }],
    [{ cold }],
    [{ scoredCount }],
    [{ unscoredCount }],
    [avgRow],
  ] = await Promise.all([
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ hot: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), eq(contactsTable.leadTemperature, "hot"))),
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ warm: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), eq(contactsTable.leadTemperature, "warm"))),
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ cold: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), eq(contactsTable.leadTemperature, "cold"))),
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ scoredCount: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), isNotNull(contactsTable.leadScore))),
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ unscoredCount: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), sql`${contactsTable.leadScore} IS NULL`)),
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ avg: sql<string | null>`AVG(${contactsTable.leadScore})` }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), isNotNull(contactsTable.leadScore))),
  ]);

  // contacts: + notDeleted(contacts.deletedAt)
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
    .where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), isNotNull(contactsTable.leadScore), sql`${contactsTable.status} NOT IN ('won', 'lost')`))
    .orderBy(desc(contactsTable.leadScore))
    .limit(6);

  // contacts: + notDeleted(contacts.deletedAt)
  const followUpWhere = and(
    contactScope,
    isNull(contactsTable.duplicateOfId),
    notDeleted(contactsTable.deletedAt),
    isNotNull(contactsTable.followUpDate),
    lte(contactsTable.followUpDate, todayDateStr),
    sql`${contactsTable.status} NOT IN ('won', 'lost')`,
  );

  const [followUpsDue, [{ followUpsDueCount }]] = await Promise.all([
    // contacts: + notDeleted(contacts.deletedAt) (via followUpWhere)
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
    // contacts: + notDeleted(contacts.deletedAt) (via followUpWhere)
    db.select({ followUpsDueCount: count() }).from(contactsTable).where(followUpWhere),
  ]);

  return { hot, warm, cold, scoredCount, unscoredCount, avgRow, hotLeads, followUpsDue, followUpsDueCount };
}

// ---------------------------------------------------------------------------
// getMobileDashboard (all contacts/leads reads exclude soft-deleted rows)
// ---------------------------------------------------------------------------
export async function mobileDashboardData(user: AuthUser, startOfToday: Date, todayDateStr: string) {
  const contactScope = tenantScope(user, contactsTable.companyId);
  const leadScope = tenantScope(user, leadsTable.companyId);

  const [
    [{ todayLeads }],
    [{ totalContacts }],
    [{ contactedLeads }],
    [{ hotLeads }],
    [{ followUpsDue }],
    [{ meetingsScheduled }],
    [{ proposalsSent }],
    valueRows,
    [{ wonCount }],
    [{ lostCount }],
  ] = await Promise.all([
    // contacts: + notDeleted(contacts.deletedAt)
    db
      .select({ todayLeads: count() })
      .from(contactsTable)
      .where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), gte(contactsTable.createdAt, startOfToday))),
    // contacts: + notDeleted(contacts.deletedAt)
    db.select({ totalContacts: count() }).from(contactsTable).where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt))),
    // contacts: + notDeleted(contacts.deletedAt)
    db
      .select({ contactedLeads: count() })
      .from(contactsTable)
      .where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), eq(contactsTable.status, "contacted"))),
    // contacts: + notDeleted(contacts.deletedAt)
    db
      .select({ hotLeads: count() })
      .from(contactsTable)
      .where(and(contactScope, isNull(contactsTable.duplicateOfId), notDeleted(contactsTable.deletedAt), inArray(contactsTable.status, ["qualified", "interested"]))),
    // contacts: + notDeleted(contacts.deletedAt)
    db
      .select({ followUpsDue: count() })
      .from(contactsTable)
      .where(
        and(
          contactScope,
          isNull(contactsTable.duplicateOfId),
          notDeleted(contactsTable.deletedAt),
          isNotNull(contactsTable.followUpDate),
          lte(contactsTable.followUpDate, todayDateStr),
          sql`${contactsTable.status} NOT IN ('won', 'lost')`,
        ),
      ),
    // leads: + notDeleted(leads.deletedAt)
    db
      .select({ meetingsScheduled: count() })
      .from(leadsTable)
      .where(and(leadScope, eq(leadsTable.stage, "meeting_scheduled"), notDeleted(leadsTable.deletedAt))),
    // leads: + notDeleted(leads.deletedAt)
    db
      .select({ proposalsSent: count() })
      .from(leadsTable)
      .where(and(leadScope, eq(leadsTable.stage, "proposal_sent"), notDeleted(leadsTable.deletedAt))),
    // leads: + notDeleted(leads.deletedAt). Pipeline/won/lost value sums grouped
    // by currency in ONE pass; the service converts each bucket to USD before
    // summing (cross-currency totals can't be summed raw at the SQL level).
    db
      .select({
        currency: leadsTable.currency,
        pipelineValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} NOT IN ('won', 'lost')), 0)`,
        wonValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} = 'won'), 0)`,
        lostValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} = 'lost'), 0)`,
      })
      .from(leadsTable)
      .where(and(leadScope, notDeleted(leadsTable.deletedAt)))
      .groupBy(leadsTable.currency),
    // leads: + notDeleted(leads.deletedAt)
    db
      .select({ wonCount: count() })
      .from(leadsTable)
      .where(and(leadScope, eq(leadsTable.stage, "won"), notDeleted(leadsTable.deletedAt))),
    // leads: + notDeleted(leads.deletedAt)
    db
      .select({ lostCount: count() })
      .from(leadsTable)
      .where(and(leadScope, eq(leadsTable.stage, "lost"), notDeleted(leadsTable.deletedAt))),
  ]);

  // contacts: + notDeleted(contacts.deletedAt)
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
    .where(and(contactScope, notDeleted(contactsTable.deletedAt)))
    .orderBy(desc(contactsTable.createdAt))
    .limit(8);

  return {
    todayLeads,
    totalContacts,
    contactedLeads,
    hotLeads,
    followUpsDue,
    meetingsScheduled,
    proposalsSent,
    valueRows,
    wonCount,
    lostCount,
    recentContacts,
  };
}

// ---------------------------------------------------------------------------
// getEventReport / getTeamMemberReport — shared event access check.
// Tenant scope + soft-delete exclusion centralized here. Returns row|undefined;
// the service throws the same 404 ("Event not found") for missing/inaccessible.
// ---------------------------------------------------------------------------
// events: + notDeleted(events.deletedAt)
export async function findEventById(user: AuthUser, id: number): Promise<EventRow | undefined> {
  const [evt] = await db
    .select()
    .from(eventsTable)
    .where(and(eq(eventsTable.id, id), tenantScope(user, eventsTable.companyId), notDeleted(eventsTable.deletedAt)))
    .limit(1);
  return evt;
}

export interface EventReportFilters {
  eventId: number;
  assignedToId: number | null;
  statusFilter: string | null;
  temperatureFilter: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface EventReportContactRow {
  id: number;
  status: string;
  leadTemperature: string | null;
  assignedToId: number | null;
  createdAt: Date;
  cardImageUrl: string | null;
}

// contacts: + notDeleted(contacts.deletedAt)
export async function eventReportContacts(user: AuthUser, filters: EventReportFilters): Promise<EventReportContactRow[]> {
  const { eventId, assignedToId, statusFilter, temperatureFilter, dateFrom, dateTo } = filters;
  const contactConds = [
    eq(contactsTable.eventId, eventId),
    isNull(contactsTable.duplicateOfId),
    notDeleted(contactsTable.deletedAt),
    tenantScope(user, contactsTable.companyId),
  ];
  if (assignedToId != null && !Number.isNaN(assignedToId)) contactConds.push(eq(contactsTable.assignedToId, assignedToId));
  if (statusFilter) contactConds.push(eq(contactsTable.status, statusFilter));
  if (temperatureFilter) contactConds.push(eq(contactsTable.leadTemperature, temperatureFilter));
  if (dateFrom) contactConds.push(gte(contactsTable.createdAt, new Date(`${dateFrom}T00:00:00.000`)));
  if (dateTo) contactConds.push(lte(contactsTable.createdAt, new Date(`${dateTo}T23:59:59.999`)));

  return await db
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
}

export interface ReportUserRow {
  id: number;
  name: string;
  avatarUrl: string | null;
}

export async function listUsersWithAvatar(user: AuthUser): Promise<ReportUserRow[]> {
  return await db
    .select({ id: usersTable.id, name: usersTable.name, avatarUrl: usersTable.avatarUrl })
    .from(usersTable)
    .where(tenantScope(user, usersTable.companyId));
}

export interface EventReportLeadRow {
  stage: string;
  value: string | null;
  currency: string | null;
  assignedToId: number | null;
}

// leads: + notDeleted(leads.deletedAt)
export async function eventReportLeads(
  user: AuthUser,
  filters: { eventId: number; assignedToId: number | null; dateFrom: string | null; dateTo: string | null },
): Promise<EventReportLeadRow[]> {
  const { eventId, assignedToId, dateFrom, dateTo } = filters;
  const leadConds = [eq(leadsTable.eventId, eventId), notDeleted(leadsTable.deletedAt), tenantScope(user, leadsTable.companyId)];
  if (assignedToId != null && !Number.isNaN(assignedToId)) leadConds.push(eq(leadsTable.assignedToId, assignedToId));
  if (dateFrom) leadConds.push(gte(leadsTable.createdAt, new Date(`${dateFrom}T00:00:00.000`)));
  if (dateTo) leadConds.push(lte(leadsTable.createdAt, new Date(`${dateTo}T23:59:59.999`)));
  return await db
    .select({ stage: leadsTable.stage, value: leadsTable.value, currency: leadsTable.currency, assignedToId: leadsTable.assignedToId })
    .from(leadsTable)
    .where(and(...leadConds));
}

// meetings has no deletedAt.
export async function meetingsScheduledCount(contactIds: number[]): Promise<number> {
  const [m] = await db
    .select({ c: count() })
    .from(meetingsTable)
    .where(and(inArray(meetingsTable.contactId, contactIds), eq(meetingsTable.status, "scheduled")));
  return m.c;
}

// follow_ups has no deletedAt.
export async function followUpsPendingCount(contactIds: number[]): Promise<number> {
  const [f] = await db
    .select({ c: count() })
    .from(followUpsTable)
    .where(and(inArray(followUpsTable.contactId, contactIds), eq(followUpsTable.status, "pending")));
  return f.c;
}

// ---------------------------------------------------------------------------
// getTeamMemberReport
// ---------------------------------------------------------------------------
// users has no deletedAt.
export async function findTeamMember(user: AuthUser, userId: number): Promise<ReportUserRow | undefined> {
  const [member] = await db
    .select({ id: usersTable.id, name: usersTable.name, avatarUrl: usersTable.avatarUrl })
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), tenantScope(user, usersTable.companyId)))
    .limit(1);
  return member;
}

export interface TeamMemberContactRow {
  id: number;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string;
  createdAt: Date;
}

// contacts: + notDeleted(contacts.deletedAt)
export async function teamMemberContacts(user: AuthUser, eventId: number, userId: number): Promise<TeamMemberContactRow[]> {
  return await db
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
        notDeleted(contactsTable.deletedAt),
        tenantScope(user, contactsTable.companyId),
      ),
    );
}

export interface TeamMemberLeadRow {
  stage: string;
  value: string | null;
  currency: string | null;
}

// leads: + notDeleted(leads.deletedAt)
export async function teamMemberLeads(user: AuthUser, eventId: number, userId: number): Promise<TeamMemberLeadRow[]> {
  return await db
    .select({ stage: leadsTable.stage, value: leadsTable.value, currency: leadsTable.currency })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.eventId, eventId),
        eq(leadsTable.assignedToId, userId),
        notDeleted(leadsTable.deletedAt),
        tenantScope(user, leadsTable.companyId),
      ),
    );
}

export interface StatusHistoryRow {
  contactId: number;
  fromStatus: string | null;
  toStatus: string;
  createdAt: Date;
}

// contact_status_history has no deletedAt.
export async function statusHistoryForContacts(contactIds: number[], userId: number): Promise<StatusHistoryRow[]> {
  return await db
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
    .limit(40);
}
