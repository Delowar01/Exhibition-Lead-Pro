import {
  db,
  contactsTable,
  leadsTable,
  scansTable,
  usersTable,
  departmentsTable,
  teamsTable,
  companiesTable,
  meetingsTable,
} from "@workspace/db";
import { and, eq, count, sql, desc, inArray, gte, lte, isNull, isNotNull, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { notDeleted } from "./base.js";

// ---------------------------------------------------------------------------
// Executive analytics (Stage 3 Phase 2) — read-only org-scoped aggregations.
//
// Every query is doubly scoped:
//   1. tenantScope(user, table.companyId)  — tenant isolation (never by companyId
//      alone; platform_owner is blocked upstream by requireTenantUser).
//   2. an optional org-membership filter on the owning user column — null = the
//      whole accessible tenant (company overview); a userId set = a
//      department/team/employee slice. An EMPTY set means "a scope with no
//      members" and must match NO rows (sql`false`), never all rows.
//
// Soft-deleted rows are excluded via notDeleted(); duplicate contacts via
// isNull(duplicateOfId), matching the existing reports repository.
// ---------------------------------------------------------------------------

export interface AnalyticsScope {
  user: AuthUser;
  // null => company-wide (all accessible companies). Otherwise the exact set of
  // user ids that make up the scope (department members, team members, or a
  // single employee). An empty array is a real (member-less) scope.
  userIds: number[] | null;
}

// Per-user membership filter for a given owning-user column. Returns undefined
// for company-wide scope (no extra filter), sql`false` for an empty member set
// (drizzle's inArray with [] is unsafe), otherwise an inArray condition.
function userIdFilter(column: PgColumn, userIds: number[] | null): SQL | undefined {
  if (userIds === null) return undefined;
  if (userIds.length === 0) return sql`false`;
  return inArray(column, userIds);
}

const CONTACT_OWNER = contactsTable.assignedToId;
const LEAD_OWNER = leadsTable.assignedToId;
const SCAN_OWNER = scansTable.userId;

// ---- Count aggregations over a [from, to] window -------------------------

export async function countScans(scope: AnalyticsScope, from: Date, to: Date): Promise<number> {
  const [{ c }] = await db
    .select({ c: count() })
    .from(scansTable)
    .where(
      and(
        tenantScope(scope.user, scansTable.companyId),
        userIdFilter(SCAN_OWNER, scope.userIds),
        gte(scansTable.createdAt, from),
        lte(scansTable.createdAt, to),
      ),
    );
  return c;
}

export async function countNewContacts(scope: AnalyticsScope, from: Date, to: Date): Promise<number> {
  const [{ c }] = await db
    .select({ c: count() })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    );
  return c;
}

export async function countNewLeads(scope: AnalyticsScope, from: Date, to: Date): Promise<number> {
  const [{ c }] = await db
    .select({ c: count() })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    );
  return c;
}

// won/lost counts for leads created in the window (cohort conversion).
export async function leadOutcomeCounts(
  scope: AnalyticsScope,
  from: Date,
  to: Date,
): Promise<{ wonCount: number; lostCount: number }> {
  const [row] = await db
    .select({
      wonCount: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.stage} = 'won')`.mapWith(Number),
      lostCount: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.stage} = 'lost')`.mapWith(Number),
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    );
  return { wonCount: row?.wonCount ?? 0, lostCount: row?.lostCount ?? 0 };
}

export interface CurrencyValueRow {
  currency: string | null;
  wonValue: string;
  lostValue: string;
}

// won/lost value sums grouped by currency for leads created in the window. The
// service converts each currency bucket to USD before summing.
export async function leadOutcomeValues(scope: AnalyticsScope, from: Date, to: Date): Promise<CurrencyValueRow[]> {
  return await db
    .select({
      currency: leadsTable.currency,
      wonValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} = 'won'), 0)`,
      lostValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} = 'lost'), 0)`,
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    )
    .groupBy(leadsTable.currency);
}

export interface CurrencyPipelineRow {
  currency: string | null;
  pipelineValue: string;
}

// Open-pipeline value (stage NOT won/lost) grouped by currency. Point-in-time
// (not date-filtered): the current open pipeline for the scope.
export async function openPipelineValues(scope: AnalyticsScope): Promise<CurrencyPipelineRow[]> {
  return await db
    .select({
      currency: leadsTable.currency,
      pipelineValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} NOT IN ('won', 'lost')), 0)`,
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
      ),
    )
    .groupBy(leadsTable.currency);
}

// Follow-up adherence inputs (point-in-time). scheduled = active contacts with a
// follow-up date; due = on/before today; overdue = strictly before today. Active
// excludes won/lost. followUpDate is a date-only string compared as a string.
export async function followUpStats(
  scope: AnalyticsScope,
  todayDateStr: string,
): Promise<{ scheduled: number; due: number; overdue: number }> {
  const base = and(
    tenantScope(scope.user, contactsTable.companyId),
    isNull(contactsTable.duplicateOfId),
    notDeleted(contactsTable.deletedAt),
    userIdFilter(CONTACT_OWNER, scope.userIds),
    isNotNull(contactsTable.followUpDate),
    sql`${contactsTable.status} NOT IN ('won', 'lost')`,
  );
  const [row] = await db
    .select({
      scheduled: count(),
      due: sql<number>`COUNT(*) FILTER (WHERE ${contactsTable.followUpDate} <= ${todayDateStr})`.mapWith(Number),
      overdue: sql<number>`COUNT(*) FILTER (WHERE ${contactsTable.followUpDate} < ${todayDateStr})`.mapWith(Number),
    })
    .from(contactsTable)
    .where(base);
  return { scheduled: row?.scheduled ?? 0, due: row?.due ?? 0, overdue: row?.overdue ?? 0 };
}

export interface UserFollowUpRow {
  userId: number | null;
  scheduled: number;
  overdue: number;
}

// Per-user follow-up adherence inputs (point-in-time) — backs the fairness-aware
// executive team-performance hygiene score. Same active/scheduled/overdue definition
// as followUpStats, grouped by the contact's owner.
export async function followUpStatsByUser(scope: AnalyticsScope, todayDateStr: string): Promise<UserFollowUpRow[]> {
  return await db
    .select({
      userId: CONTACT_OWNER,
      scheduled: count(),
      overdue: sql<number>`COUNT(*) FILTER (WHERE ${contactsTable.followUpDate} < ${todayDateStr})`.mapWith(Number),
    })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        isNotNull(contactsTable.followUpDate),
        sql`${contactsTable.status} NOT IN ('won', 'lost')`,
      ),
    )
    .groupBy(CONTACT_OWNER);
}

// ---- Trend (per-day) over a window ---------------------------------------

export interface DayCountRow {
  day: string;
  value: number;
}

export async function scansByDay(scope: AnalyticsScope, from: Date, to: Date): Promise<DayCountRow[]> {
  return await db
    .select({ day: sql<string>`to_char(${scansTable.createdAt}, 'YYYY-MM-DD')`, value: count() })
    .from(scansTable)
    .where(
      and(
        tenantScope(scope.user, scansTable.companyId),
        userIdFilter(SCAN_OWNER, scope.userIds),
        gte(scansTable.createdAt, from),
        lte(scansTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${scansTable.createdAt}, 'YYYY-MM-DD')`);
}

export async function contactsByDay(scope: AnalyticsScope, from: Date, to: Date): Promise<DayCountRow[]> {
  return await db
    .select({ day: sql<string>`to_char(${contactsTable.createdAt}, 'YYYY-MM-DD')`, value: count() })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${contactsTable.createdAt}, 'YYYY-MM-DD')`);
}

export async function leadsByDay(scope: AnalyticsScope, from: Date, to: Date): Promise<DayCountRow[]> {
  return await db
    .select({ day: sql<string>`to_char(${leadsTable.createdAt}, 'YYYY-MM-DD')`, value: count() })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${leadsTable.createdAt}, 'YYYY-MM-DD')`);
}

// ---- Funnel (current pipeline composition by stage) ----------------------

export interface StageCountRow {
  stage: string;
  count: number;
}

export async function leadCountsByStage(scope: AnalyticsScope): Promise<StageCountRow[]> {
  return await db
    .select({ stage: leadsTable.stage, count: count() })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
      ),
    )
    .groupBy(leadsTable.stage);
}

// ---- Source mix (contacts captured in the window) ------------------------

export async function sourceMix(
  scope: AnalyticsScope,
  from: Date,
  to: Date,
): Promise<{ card: number; manual: number }> {
  const [row] = await db
    .select({
      card: sql<number>`COUNT(*) FILTER (WHERE ${contactsTable.cardImageUrl} IS NOT NULL)`.mapWith(Number),
      manual: sql<number>`COUNT(*) FILTER (WHERE ${contactsTable.cardImageUrl} IS NULL)`.mapWith(Number),
    })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    );
  return { card: row?.card ?? 0, manual: row?.manual ?? 0 };
}

// ---- Top performers (per-user breakdown within scope) --------------------

export interface UserCountRow {
  userId: number | null;
  value: number;
}

export async function scanCountsByUser(scope: AnalyticsScope, from: Date, to: Date): Promise<UserCountRow[]> {
  return await db
    .select({ userId: scansTable.userId, value: count() })
    .from(scansTable)
    .where(
      and(
        tenantScope(scope.user, scansTable.companyId),
        userIdFilter(SCAN_OWNER, scope.userIds),
        gte(scansTable.createdAt, from),
        lte(scansTable.createdAt, to),
      ),
    )
    .groupBy(scansTable.userId);
}

export async function contactCountsByUser(scope: AnalyticsScope, from: Date, to: Date): Promise<UserCountRow[]> {
  return await db
    .select({ userId: contactsTable.assignedToId, value: count() })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    )
    .groupBy(contactsTable.assignedToId);
}

export async function leadCountsByUser(scope: AnalyticsScope, from: Date, to: Date): Promise<UserCountRow[]> {
  return await db
    .select({ userId: leadsTable.assignedToId, value: count() })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    )
    .groupBy(leadsTable.assignedToId);
}

export async function wonCountsByUser(scope: AnalyticsScope, from: Date, to: Date): Promise<UserCountRow[]> {
  return await db
    .select({
      userId: leadsTable.assignedToId,
      value: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.stage} = 'won')`.mapWith(Number),
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    )
    .groupBy(leadsTable.assignedToId);
}

export interface UserCurrencyValueRow {
  userId: number | null;
  currency: string | null;
  pipelineValue: string;
}

// Open-pipeline value per user + currency (point-in-time). The service converts
// each currency bucket to USD before summing per user.
export async function openPipelineByUser(scope: AnalyticsScope): Promise<UserCurrencyValueRow[]> {
  return await db
    .select({
      userId: leadsTable.assignedToId,
      currency: leadsTable.currency,
      pipelineValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} NOT IN ('won', 'lost')), 0)`,
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
      ),
    )
    .groupBy(leadsTable.assignedToId, leadsTable.currency);
}

export interface ScopeUserRow {
  id: number;
  name: string;
  avatarUrl: string | null;
}

// Users that make up the scope (for headcount + name/avatar resolution).
export async function usersInScope(scope: AnalyticsScope): Promise<ScopeUserRow[]> {
  return await db
    .select({ id: usersTable.id, name: usersTable.name, avatarUrl: usersTable.avatarUrl })
    .from(usersTable)
    .where(and(tenantScope(scope.user, usersTable.companyId), userIdFilter(usersTable.id, scope.userIds), isNull(usersTable.deletedAt)));
}

// ---- Recent activity (recent contacts in scope) --------------------------

export interface RecentContactRow {
  id: number;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  contactCompany: string | null;
  createdAt: Date;
}

export async function recentContacts(scope: AnalyticsScope, limit: number): Promise<RecentContactRow[]> {
  return await db
    .select({
      id: contactsTable.id,
      fullName: contactsTable.fullName,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      contactCompany: contactsTable.contactCompany,
      createdAt: contactsTable.createdAt,
    })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
      ),
    )
    .orderBy(desc(contactsTable.createdAt))
    .limit(limit);
}

// ---- Org lookups (scope resolution + scope-options) ----------------------

export interface DepartmentRow {
  id: number;
  name: string;
  companyId: number;
  headId: number | null;
  parentDepartmentId: number | null;
}

export async function findDepartment(user: AuthUser, id: number): Promise<DepartmentRow | undefined> {
  const [row] = await db
    .select({
      id: departmentsTable.id,
      name: departmentsTable.name,
      companyId: departmentsTable.companyId,
      headId: departmentsTable.headId,
      parentDepartmentId: departmentsTable.parentDepartmentId,
    })
    .from(departmentsTable)
    .where(and(eq(departmentsTable.id, id), tenantScope(user, departmentsTable.companyId), notDeleted(departmentsTable.deletedAt)))
    .limit(1);
  return row;
}

export async function listTenantDepartments(user: AuthUser): Promise<DepartmentRow[]> {
  return await db
    .select({
      id: departmentsTable.id,
      name: departmentsTable.name,
      companyId: departmentsTable.companyId,
      headId: departmentsTable.headId,
      parentDepartmentId: departmentsTable.parentDepartmentId,
    })
    .from(departmentsTable)
    .where(and(tenantScope(user, departmentsTable.companyId), notDeleted(departmentsTable.deletedAt)));
}

export interface TeamRow {
  id: number;
  name: string;
  companyId: number;
  leaderId: number | null;
  departmentId: number | null;
}

export async function findTeam(user: AuthUser, id: number): Promise<TeamRow | undefined> {
  const [row] = await db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      companyId: teamsTable.companyId,
      leaderId: teamsTable.leaderId,
      departmentId: teamsTable.departmentId,
    })
    .from(teamsTable)
    .where(and(eq(teamsTable.id, id), tenantScope(user, teamsTable.companyId), notDeleted(teamsTable.deletedAt)))
    .limit(1);
  return row;
}

export async function listTenantTeams(user: AuthUser): Promise<TeamRow[]> {
  return await db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      companyId: teamsTable.companyId,
      leaderId: teamsTable.leaderId,
      departmentId: teamsTable.departmentId,
    })
    .from(teamsTable)
    .where(and(tenantScope(user, teamsTable.companyId), notDeleted(teamsTable.deletedAt)));
}

export interface EmployeeRow {
  id: number;
  name: string;
  companyId: number | null;
  departmentId: number | null;
  teamId: number | null;
  jobTitle: string | null;
}

export async function findEmployee(user: AuthUser, id: number): Promise<EmployeeRow | undefined> {
  const [row] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      companyId: usersTable.companyId,
      departmentId: usersTable.departmentId,
      teamId: usersTable.teamId,
      jobTitle: usersTable.jobTitle,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, id), tenantScope(user, usersTable.companyId), isNull(usersTable.deletedAt)))
    .limit(1);
  return row;
}

export async function listTenantEmployees(user: AuthUser): Promise<EmployeeRow[]> {
  return await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      companyId: usersTable.companyId,
      departmentId: usersTable.departmentId,
      teamId: usersTable.teamId,
      jobTitle: usersTable.jobTitle,
    })
    .from(usersTable)
    .where(and(tenantScope(user, usersTable.companyId), isNull(usersTable.deletedAt)));
}

// User ids whose departmentId is in the given set (department membership,
// including descendant departments resolved by the service).
export async function userIdsByDepartments(user: AuthUser, departmentIds: number[]): Promise<number[]> {
  if (departmentIds.length === 0) return [];
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(tenantScope(user, usersTable.companyId), isNull(usersTable.deletedAt), inArray(usersTable.departmentId, departmentIds)));
  return rows.map((r) => r.id);
}

export async function userIdsByTeam(user: AuthUser, teamId: number): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(tenantScope(user, usersTable.companyId), isNull(usersTable.deletedAt), eq(usersTable.teamId, teamId)));
  return rows.map((r) => r.id);
}

// ---- Unified dashboard extras (Stage 4F) ---------------------------------
//
// Additional read-only aggregations that back the premium Unified Lead
// Dashboard. Every query reuses the same double scoping (tenantScope + optional
// per-user membership filter) and soft-delete / duplicate exclusions as the
// executive-analytics queries above. No new heavy computation — these are the
// missing slices (industry / country distribution, monthly series, duplicate /
// AI-queue / meeting counts) needed to assemble the full dashboard shape.

export interface LabelCountRow {
  label: string;
  count: number;
}

// Contact distribution by AI-enriched industry over a window. NULL/blank
// industries collapse to "Unknown". Ordered by count desc, top `limit`.
export async function contactsByIndustry(
  scope: AnalyticsScope,
  from: Date,
  to: Date,
  limit: number,
): Promise<LabelCountRow[]> {
  return await db
    .select({
      label: sql<string>`COALESCE(NULLIF(TRIM(${contactsTable.industry}), ''), 'Unknown')`,
      count: count(),
    })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    )
    .groupBy(sql`COALESCE(NULLIF(TRIM(${contactsTable.industry}), ''), 'Unknown')`)
    .orderBy(desc(count()))
    .limit(limit);
}

// Contact distribution by country over a window. Same NULL/blank collapse.
export async function contactsByCountry(
  scope: AnalyticsScope,
  from: Date,
  to: Date,
  limit: number,
): Promise<LabelCountRow[]> {
  return await db
    .select({
      label: sql<string>`COALESCE(NULLIF(TRIM(${contactsTable.country}), ''), 'Unknown')`,
      count: count(),
    })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    )
    .groupBy(sql`COALESCE(NULLIF(TRIM(${contactsTable.country}), ''), 'Unknown')`)
    .orderBy(desc(count()))
    .limit(limit);
}

// Count of duplicate contacts (duplicateOfId IS NOT NULL) captured in the
// window — surfaces the dedup workload for the scope.
export async function duplicateContactCount(scope: AnalyticsScope, from: Date, to: Date): Promise<number> {
  const [{ c }] = await db
    .select({ c: count() })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNotNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    );
  return c;
}

// AI enrichment queue = active, non-duplicate contacts still missing a lead
// score (point-in-time). Excludes won/lost. Represents pending AI work.
export async function aiQueueCount(scope: AnalyticsScope): Promise<number> {
  const [{ c }] = await db
    .select({ c: count() })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        isNull(contactsTable.leadScore),
        sql`${contactsTable.status} NOT IN ('won', 'lost')`,
      ),
    );
  return c;
}

// Scheduled meetings for the scope (point-in-time). Scoped by tenant + the
// meeting's assignedTo owner column. Meetings have no soft-delete column.
export async function scheduledMeetingCount(scope: AnalyticsScope): Promise<number> {
  const [{ c }] = await db
    .select({ c: count() })
    .from(meetingsTable)
    .where(
      and(
        tenantScope(scope.user, meetingsTable.companyId),
        userIdFilter(meetingsTable.assignedToId, scope.userIds),
        eq(meetingsTable.status, "scheduled"),
      ),
    );
  return c;
}

export interface MonthLeadRow {
  month: string;
  leads: number;
  won: number;
}

// Leads created per calendar month (YYYY-MM) over a window, with a won filter.
export async function leadsByMonth(scope: AnalyticsScope, from: Date, to: Date): Promise<MonthLeadRow[]> {
  return await db
    .select({
      month: sql<string>`to_char(${leadsTable.createdAt}, 'YYYY-MM')`,
      leads: count(),
      won: sql<number>`COUNT(*) FILTER (WHERE ${leadsTable.stage} = 'won')`.mapWith(Number),
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${leadsTable.createdAt}, 'YYYY-MM')`);
}

export interface MonthCountRow {
  month: string;
  value: number;
}

export async function contactsByMonth(scope: AnalyticsScope, from: Date, to: Date): Promise<MonthCountRow[]> {
  return await db
    .select({ month: sql<string>`to_char(${contactsTable.createdAt}, 'YYYY-MM')`, value: count() })
    .from(contactsTable)
    .where(
      and(
        tenantScope(scope.user, contactsTable.companyId),
        isNull(contactsTable.duplicateOfId),
        notDeleted(contactsTable.deletedAt),
        userIdFilter(CONTACT_OWNER, scope.userIds),
        gte(contactsTable.createdAt, from),
        lte(contactsTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${contactsTable.createdAt}, 'YYYY-MM')`);
}

export async function scansByMonth(scope: AnalyticsScope, from: Date, to: Date): Promise<MonthCountRow[]> {
  return await db
    .select({ month: sql<string>`to_char(${scansTable.createdAt}, 'YYYY-MM')`, value: count() })
    .from(scansTable)
    .where(
      and(
        tenantScope(scope.user, scansTable.companyId),
        userIdFilter(SCAN_OWNER, scope.userIds),
        gte(scansTable.createdAt, from),
        lte(scansTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${scansTable.createdAt}, 'YYYY-MM')`);
}

export interface MonthCurrencyValueRow {
  month: string;
  currency: string | null;
  wonValue: string;
}

// Won-lead value per calendar month (YYYY-MM) grouped by currency, over a window.
// The service converts each currency bucket to the display currency before summing
// — the monthly revenue series that backs deterministic revenue forecasting.
export async function wonValueByMonth(scope: AnalyticsScope, from: Date, to: Date): Promise<MonthCurrencyValueRow[]> {
  return await db
    .select({
      month: sql<string>`to_char(${leadsTable.createdAt}, 'YYYY-MM')`,
      currency: leadsTable.currency,
      wonValue: sql<string>`COALESCE(SUM(${leadsTable.value}) FILTER (WHERE ${leadsTable.stage} = 'won'), 0)`,
    })
    .from(leadsTable)
    .where(
      and(
        tenantScope(scope.user, leadsTable.companyId),
        notDeleted(leadsTable.deletedAt),
        userIdFilter(LEAD_OWNER, scope.userIds),
        gte(leadsTable.createdAt, from),
        lte(leadsTable.createdAt, to),
      ),
    )
    .groupBy(sql`to_char(${leadsTable.createdAt}, 'YYYY-MM')`, leadsTable.currency);
}

export async function companyName(user: AuthUser, companyId: number): Promise<string | null> {
  const [row] = await db
    .select({ name: companiesTable.name })
    .from(companiesTable)
    .where(and(eq(companiesTable.id, companyId), tenantScope(user, companiesTable.id)))
    .limit(1);
  return row?.name ?? null;
}
