import { AppError } from "../middlewares/errorHandler.js";
import { type AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/analytics.repository.js";
import { convertCurrency } from "../lib/currency.js";

// ---------------------------------------------------------------------------
// Executive analytics (Stage 3 Phase 2). Assembles the shared ScopedAnalytics
// shape for company / department / team / employee scopes from existing CRM
// data. Read-only. Tenant isolation + soft-delete are enforced in the repo;
// org-position scope authorization is enforced here (assertScopeAccess).
// ---------------------------------------------------------------------------

const MS_DAY = 86_400_000;
const MAX_RANGE_DAYS = 366; // bound the trend array / query window
const DEFAULT_RANGE_DAYS = 30;

// Canonical pipeline order (mirrors PIPELINE_STAGES in leads.service.ts).
const PIPELINE_STAGES = ["prospect", "qualified", "proposal_sent", "negotiation", "won", "lost"] as const;
const STAGE_LABELS: Record<string, string> = {
  prospect: "Prospect",
  qualified: "Qualified",
  proposal_sent: "Proposal Sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

type ScopeType = "company" | "department" | "team" | "employee";

function isManager(role: string): boolean {
  return role === "primary_admin" || role === "admin";
}

// ---- Date handling (all local-date strings, matching SQL to_char output) ----

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface ResolvedRange {
  fromStr: string;
  toStr: string;
  fromDate: Date;
  toDate: Date;
  prevFromDate: Date;
  prevToDate: Date;
}

function isValidDateStr(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00.000`).getTime());
}

function resolveRange(dateFrom?: string, dateTo?: string): ResolvedRange {
  const today = new Date();
  let toStr = isValidDateStr(dateTo) ? dateTo : localDateStr(today);
  let fromStr = isValidDateStr(dateFrom)
    ? dateFrom
    : localDateStr(new Date(today.getTime() - (DEFAULT_RANGE_DAYS - 1) * MS_DAY));

  // Ensure from <= to (swap if the caller inverted them).
  if (fromStr > toStr) [fromStr, toStr] = [toStr, fromStr];

  // Clamp to MAX_RANGE_DAYS counting back from `to`.
  let fromDate = new Date(`${fromStr}T00:00:00.000`);
  const toDate = new Date(`${toStr}T23:59:59.999`);
  const maxFrom = new Date(toDate.getTime() - (MAX_RANGE_DAYS - 1) * MS_DAY);
  if (fromDate < maxFrom) {
    fromDate = new Date(`${localDateStr(maxFrom)}T00:00:00.000`);
    fromStr = localDateStr(fromDate);
  }

  // Previous period = the equal-length window immediately preceding [from, to].
  const lengthMs = toDate.getTime() - fromDate.getTime();
  const prevToDate = new Date(fromDate.getTime() - 1);
  const prevFromDate = new Date(prevToDate.getTime() - lengthMs);

  return { fromStr, toStr, fromDate, toDate, prevFromDate, prevToDate };
}

function eachDay(fromStr: string, toStr: string): string[] {
  const days: string[] = [];
  let cur = new Date(`${fromStr}T00:00:00.000`);
  const end = new Date(`${toStr}T00:00:00.000`);
  while (cur <= end) {
    days.push(localDateStr(cur));
    cur = new Date(cur.getTime() + MS_DAY);
  }
  return days;
}

// ---- Cross-currency helpers ----

function sumUsd<T extends { currency: string | null }>(rows: T[], key: keyof T): number {
  let total = 0;
  for (const r of rows) {
    total += convertCurrency(Number(r[key] ?? 0), r.currency ?? "USD", "USD");
  }
  return total;
}

// Percentage change vs a previous-period baseline. null when there is no
// baseline (previous === 0) — we never fabricate a delta against zero.
function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ---- Scope resolution ----

interface ScopeAuthCtx {
  headId?: number | null; // department head (for department scope)
  leaderId?: number | null; // team leader (for team scope)
  employeeId?: number | null; // the target user (for employee scope)
}

function assertScopeAccess(user: AuthUser, scopeType: ScopeType, ctx: ScopeAuthCtx) {
  if (isManager(user.role)) return; // primary_admin / admin → any scope in tenant
  // employee: own employee scope; own team if leader; own department if head; no company overview.
  if (scopeType === "company") {
    throw new AppError(403, "You do not have access to company-wide analytics");
  }
  if (scopeType === "employee") {
    if (ctx.employeeId !== user.id) throw new AppError(403, "You can only view your own performance");
    return;
  }
  if (scopeType === "team") {
    if (ctx.leaderId !== user.id) throw new AppError(403, "Only the team lead can view this team's analytics");
    return;
  }
  if (scopeType === "department") {
    if (ctx.headId !== user.id) throw new AppError(403, "Only the department head can view this department's analytics");
    return;
  }
}

// Collect a department id plus all of its descendant department ids (the org
// subtree), so a department scope aggregates nested sub-departments too.
function collectDescendants(all: repo.DepartmentRow[], rootId: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const d of all) {
    if (d.parentDepartmentId != null) {
      const arr = childrenByParent.get(d.parentDepartmentId) ?? [];
      arr.push(d.id);
      childrenByParent.set(d.parentDepartmentId, arr);
    }
  }
  const result: number[] = [];
  const seen = new Set<number>();
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    result.push(cur);
    for (const c of childrenByParent.get(cur) ?? []) stack.push(c);
  }
  return result;
}

interface ResolvedScope {
  scope: { type: ScopeType; id: number | null; name: string };
  analyticsScope: repo.AnalyticsScope;
}

async function resolveOverview(user: AuthUser): Promise<ResolvedScope> {
  assertScopeAccess(user, "company", {});
  let name = "Company";
  if (user.accessibleCompanies.length === 1) {
    name = (await repo.companyName(user, user.accessibleCompanies[0])) ?? "Company";
  } else if (user.accessibleCompanies.length > 1) {
    name = "All Companies";
  } else if (user.companyId) {
    name = (await repo.companyName(user, user.companyId)) ?? "Company";
  }
  return { scope: { type: "company", id: null, name }, analyticsScope: { user, userIds: null } };
}

async function resolveDepartment(user: AuthUser, id: number): Promise<ResolvedScope> {
  const dept = await repo.findDepartment(user, id);
  if (!dept) throw new AppError(404, "Department not found");
  assertScopeAccess(user, "department", { headId: dept.headId });
  const all = await repo.listTenantDepartments(user);
  const deptIds = collectDescendants(all, id);
  const userIds = await repo.userIdsByDepartments(user, deptIds);
  return { scope: { type: "department", id, name: dept.name }, analyticsScope: { user, userIds } };
}

async function resolveTeam(user: AuthUser, id: number): Promise<ResolvedScope> {
  const team = await repo.findTeam(user, id);
  if (!team) throw new AppError(404, "Team not found");
  assertScopeAccess(user, "team", { leaderId: team.leaderId });
  const userIds = await repo.userIdsByTeam(user, id);
  return { scope: { type: "team", id, name: team.name }, analyticsScope: { user, userIds } };
}

async function resolveEmployee(user: AuthUser, id: number): Promise<ResolvedScope> {
  const emp = await repo.findEmployee(user, id);
  if (!emp) throw new AppError(404, "Employee not found");
  assertScopeAccess(user, "employee", { employeeId: emp.id });
  return { scope: { type: "employee", id, name: emp.name }, analyticsScope: { user, userIds: [id] } };
}

// ---- Assembly ----

async function assemble(resolved: ResolvedScope, dateFrom?: string, dateTo?: string) {
  const { scope, analyticsScope: s } = resolved;
  const range = resolveRange(dateFrom, dateTo);
  const todayStr = localDateStr(new Date());

  const [
    scans,
    newContacts,
    newLeads,
    outcomeCounts,
    outcomeValues,
    pipelineRows,
    followUp,
    scanDays,
    contactDays,
    leadDays,
    stageRows,
    mix,
    scanByUser,
    leadByUser,
    wonByUser,
    pipelineByUser,
    scopeUsers,
    recents,
    // previous-period baselines (for deltas)
    prevScans,
    prevNewContacts,
    prevNewLeads,
    prevOutcomeCounts,
  ] = await Promise.all([
    repo.countScans(s, range.fromDate, range.toDate),
    repo.countNewContacts(s, range.fromDate, range.toDate),
    repo.countNewLeads(s, range.fromDate, range.toDate),
    repo.leadOutcomeCounts(s, range.fromDate, range.toDate),
    repo.leadOutcomeValues(s, range.fromDate, range.toDate),
    repo.openPipelineValues(s),
    repo.followUpStats(s, todayStr),
    repo.scansByDay(s, range.fromDate, range.toDate),
    repo.contactsByDay(s, range.fromDate, range.toDate),
    repo.leadsByDay(s, range.fromDate, range.toDate),
    repo.leadCountsByStage(s),
    repo.sourceMix(s, range.fromDate, range.toDate),
    repo.scanCountsByUser(s, range.fromDate, range.toDate),
    repo.leadCountsByUser(s, range.fromDate, range.toDate),
    repo.wonCountsByUser(s, range.fromDate, range.toDate),
    repo.openPipelineByUser(s),
    repo.usersInScope(s),
    repo.recentContacts(s, 10),
    repo.countScans(s, range.prevFromDate, range.prevToDate),
    repo.countNewContacts(s, range.prevFromDate, range.prevToDate),
    repo.countNewLeads(s, range.prevFromDate, range.prevToDate),
    repo.leadOutcomeCounts(s, range.prevFromDate, range.prevToDate),
  ]);

  // KPIs
  const wonCount = outcomeCounts.wonCount;
  const lostCount = outcomeCounts.lostCount;
  const decided = wonCount + lostCount;
  const conversionRate = decided === 0 ? 0 : Math.round((wonCount / decided) * 100);
  const pipelineValue = Math.round(sumUsd(pipelineRows, "pipelineValue"));
  const wonValue = Math.round(sumUsd(outcomeValues, "wonValue"));
  const lostValue = Math.round(sumUsd(outcomeValues, "lostValue"));

  // Follow-up adherence = share of active scheduled follow-ups that are not
  // overdue. No scheduled follow-ups => 100 (nothing is overdue).
  const followUpAdherence =
    followUp.scheduled === 0 ? 100 : Math.round(((followUp.scheduled - followUp.overdue) / followUp.scheduled) * 100);

  const kpis = {
    scans,
    newContacts,
    newLeads,
    conversionRate,
    pipelineValue,
    wonValue,
    lostValue,
    wonCount,
    lostCount,
    followUpsDueCount: followUp.due,
    followUpsOverdueCount: followUp.overdue,
    followUpAdherence,
  };

  // Deltas vs previous period. pipelineValue is a point-in-time snapshot with no
  // historical baseline, so its delta is null (honest, not fabricated).
  const prevDecided = prevOutcomeCounts.wonCount + prevOutcomeCounts.lostCount;
  const prevConversion = prevDecided === 0 ? 0 : Math.round((prevOutcomeCounts.wonCount / prevDecided) * 100);
  const deltas = {
    scans: pctChange(scans, prevScans),
    newContacts: pctChange(newContacts, prevNewContacts),
    newLeads: pctChange(newLeads, prevNewLeads),
    conversionRate: prevDecided === 0 ? null : conversionRate - prevConversion,
    pipelineValue: null as number | null,
  };

  // Trend (gap-filled daily series).
  const scanMap = new Map(scanDays.map((r) => [r.day, r.value]));
  const contactMap = new Map(contactDays.map((r) => [r.day, r.value]));
  const leadMap = new Map(leadDays.map((r) => [r.day, r.value]));
  const trend = eachDay(range.fromStr, range.toStr).map((day) => ({
    date: day,
    scans: scanMap.get(day) ?? 0,
    contacts: contactMap.get(day) ?? 0,
    leads: leadMap.get(day) ?? 0,
    label: new Date(`${day}T00:00:00.000`).toLocaleDateString("default", { month: "short", day: "numeric" }),
  }));

  // Funnel (current pipeline composition, canonical stage order).
  const stageMap = new Map(stageRows.map((r) => [r.stage, r.count]));
  const funnel = PIPELINE_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage] ?? stage,
    count: stageMap.get(stage) ?? 0,
  }));

  // Source mix.
  const sourceMix = [
    { source: "Business Card", count: mix.card },
    { source: "Manual Entry", count: mix.manual },
  ].filter((x) => x.count > 0);

  // Top performers (merge per-user metrics, resolve names, top 10 by leads).
  const userInfo = new Map(scopeUsers.map((u) => [u.id, u]));
  const scanM = new Map(scanByUser.filter((r) => r.userId != null).map((r) => [r.userId as number, r.value]));
  const leadM = new Map(leadByUser.filter((r) => r.userId != null).map((r) => [r.userId as number, r.value]));
  const wonM = new Map(wonByUser.filter((r) => r.userId != null).map((r) => [r.userId as number, r.value]));
  const pipeM = new Map<number, number>();
  for (const r of pipelineByUser) {
    if (r.userId == null) continue;
    const prev = pipeM.get(r.userId) ?? 0;
    pipeM.set(r.userId, prev + convertCurrency(Number(r.pipelineValue ?? 0), r.currency ?? "USD", "USD"));
  }
  const performerIds = new Set<number>([...scanM.keys(), ...leadM.keys(), ...wonM.keys(), ...pipeM.keys()]);
  const topPerformers = [...performerIds]
    .map((uid) => {
      const info = userInfo.get(uid);
      return {
        userId: uid,
        userName: info?.name ?? "Unknown",
        avatarUrl: info?.avatarUrl ?? null,
        scans: scanM.get(uid) ?? 0,
        leads: leadM.get(uid) ?? 0,
        won: wonM.get(uid) ?? 0,
        pipelineValue: Math.round(pipeM.get(uid) ?? 0),
      };
    })
    .sort((a, b) => b.leads - a.leads || b.won - a.won || b.scans - a.scans)
    .slice(0, 10);

  // Recent activity.
  const recentActivity = recents.map((c) => {
    const name = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ") || "New contact";
    return {
      id: `contact-${c.id}`,
      type: "lead_captured",
      title: name,
      subtitle: c.contactCompany ?? null,
      at: c.createdAt.toISOString(),
    };
  });

  return {
    scope,
    dateRange: { from: range.fromStr, to: range.toStr },
    kpis,
    deltas,
    trend,
    funnel,
    sourceMix,
    topPerformers,
    recentActivity,
    headcount: scopeUsers.length,
  };
}

// ---- Unified dashboard assembly (Stage 4F) ----
//
// Superset of the executive-analytics shape: reuses `assemble` (KPIs, trend,
// funnel, source mix, top performers, recent activity) and layers on the extra
// slices the premium Unified Lead Dashboard needs — full lead KPI grid,
// industry/country distribution, and a 12-month trend. All from real,
// tenant-scoped, cross-currency-correct aggregations; no fabricated data.

const DASHBOARD_MONTHS = 12;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Resolve the dashboard scope from optional query params, honouring scope
// privacy. Managers default to the company overview; non-managers who cannot
// see the company overview default to their own employee scope.
async function resolveDashboardScope(
  user: AuthUser,
  scopeType?: string,
  id?: number,
): Promise<ResolvedScope> {
  if (scopeType === "department" && id != null) return resolveDepartment(user, id);
  if (scopeType === "team" && id != null) return resolveTeam(user, id);
  if (scopeType === "employee" && id != null) return resolveEmployee(user, id);
  if (isManager(user.role)) return resolveOverview(user);
  return resolveEmployee(user, user.id);
}

// Exposed for the Stage 5C executive-intelligence service so it reuses the SAME
// scope-privacy resolution (assertScopeAccess) + AnalyticsScope as the dashboard,
// rather than re-implementing tenant/org-position authorization.
export type { ResolvedScope };
export async function resolveScope(user: AuthUser, scopeType?: string, id?: number): Promise<ResolvedScope> {
  return resolveDashboardScope(user, scopeType, id);
}

export async function getDashboard(
  user: AuthUser,
  opts: { scopeType?: string; id?: number; dateFrom?: string; dateTo?: string } = {},
) {
  const resolved = await resolveDashboardScope(user, opts.scopeType, opts.id);
  const s = resolved.analyticsScope;
  const base = await assemble(resolved, opts.dateFrom, opts.dateTo);

  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = new Date(todayStart.getTime() - 6 * MS_DAY); // rolling 7-day
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthsAgo = new Date(now.getFullYear(), now.getMonth() - (DASHBOARD_MONTHS - 1), 1, 0, 0, 0, 0);
  const range = resolveRange(opts.dateFrom, opts.dateTo);

  const [
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    industry,
    country,
    duplicate,
    aiQueue,
    meetings,
    leadMonths,
    contactMonths,
    scanMonths,
  ] = await Promise.all([
    repo.countNewLeads(s, todayStart, now),
    repo.countNewLeads(s, weekStart, now),
    repo.countNewLeads(s, monthStart, now),
    repo.contactsByIndustry(s, range.fromDate, range.toDate, 8),
    repo.contactsByCountry(s, range.fromDate, range.toDate, 8),
    repo.duplicateContactCount(s, range.fromDate, range.toDate),
    repo.aiQueueCount(s),
    repo.scheduledMeetingCount(s),
    repo.leadsByMonth(s, monthsAgo, now),
    repo.contactsByMonth(s, monthsAgo, now),
    repo.scansByMonth(s, monthsAgo, now),
  ]);

  // Total-lead composition from the current funnel (point-in-time, all-time).
  const stageCount = (stage: string) => base.funnel.find((f) => f.stage === stage)?.count ?? 0;
  const totalLeads = base.funnel.reduce((sum, f) => sum + f.count, 0);
  const qualifiedLeads = stageCount("qualified");
  const convertedLeads = stageCount("won");
  const lostLeads = stageCount("lost");

  const leadKpis = {
    total: totalLeads,
    today: leadsToday,
    thisWeek: leadsThisWeek,
    thisMonth: leadsThisMonth,
    new: base.kpis.newLeads,
    qualified: qualifiedLeads,
    converted: convertedLeads,
    lost: lostLeads,
    duplicate,
    aiQueue,
    meetingsScheduled: meetings,
    followUpsDue: base.kpis.followUpsDueCount,
    conversionRate: base.kpis.conversionRate,
  };

  // 12-month gap-filled series.
  const leadM = new Map(leadMonths.map((r) => [r.month, r]));
  const contactM = new Map(contactMonths.map((r) => [r.month, r.value]));
  const scanM = new Map(scanMonths.map((r) => [r.month, r.value]));
  const monthlyTrend: {
    month: string;
    label: string;
    leads: number;
    won: number;
    contacts: number;
    scans: number;
  }[] = [];
  for (let i = DASHBOARD_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    const lm = leadM.get(key);
    monthlyTrend.push({
      month: key,
      label: d.toLocaleDateString("default", { month: "short", year: "2-digit" }),
      leads: lm?.leads ?? 0,
      won: lm?.won ?? 0,
      contacts: contactM.get(key) ?? 0,
      scans: scanM.get(key) ?? 0,
    });
  }

  const industryDistribution = industry.map((r) => ({ label: r.label, count: r.count }));
  const countryDistribution = country.map((r) => ({ label: r.label, count: r.count }));

  return {
    ...base,
    leadKpis,
    industryDistribution,
    countryDistribution,
    monthlyTrend,
  };
}

// ---- Public service API ----

export async function getOverview(user: AuthUser, dateFrom?: string, dateTo?: string) {
  return assemble(await resolveOverview(user), dateFrom, dateTo);
}

export async function getDepartment(user: AuthUser, id: number, dateFrom?: string, dateTo?: string) {
  return assemble(await resolveDepartment(user, id), dateFrom, dateTo);
}

export async function getTeam(user: AuthUser, id: number, dateFrom?: string, dateTo?: string) {
  return assemble(await resolveTeam(user, id), dateFrom, dateTo);
}

export async function getEmployee(user: AuthUser, id: number, dateFrom?: string, dateTo?: string) {
  return assemble(await resolveEmployee(user, id), dateFrom, dateTo);
}

export async function getScopeOptions(user: AuthUser) {
  const canViewCompany = isManager(user.role);

  if (isManager(user.role)) {
    const [departments, teams, employees] = await Promise.all([
      repo.listTenantDepartments(user),
      repo.listTenantTeams(user),
      repo.listTenantEmployees(user),
    ]);
    return {
      canViewCompany,
      departments: departments.map((d) => ({ id: d.id, name: d.name, parentDepartmentId: d.parentDepartmentId })),
      teams: teams.map((t) => ({ id: t.id, name: t.name, departmentId: t.departmentId })),
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        departmentId: e.departmentId,
        teamId: e.teamId,
        jobTitle: e.jobTitle,
      })),
    };
  }

  // employee: only the scopes they are positioned to view — own self, teams they
  // lead, departments they head.
  const [allDepts, allTeams, self] = await Promise.all([
    repo.listTenantDepartments(user),
    repo.listTenantTeams(user),
    repo.findEmployee(user, user.id),
  ]);
  return {
    canViewCompany,
    departments: allDepts
      .filter((d) => d.headId === user.id)
      .map((d) => ({ id: d.id, name: d.name, parentDepartmentId: d.parentDepartmentId })),
    teams: allTeams
      .filter((t) => t.leaderId === user.id)
      .map((t) => ({ id: t.id, name: t.name, departmentId: t.departmentId })),
    employees: self
      ? [{ id: self.id, name: self.name, departmentId: self.departmentId, teamId: self.teamId, jobTitle: self.jobTitle }]
      : [],
  };
}
