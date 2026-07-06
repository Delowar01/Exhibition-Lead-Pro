import {
  db,
  leadsTable,
  contactsTable,
  organizationsTable,
  tasksTable,
  followUpsTable,
  usersTable,
  territoriesTable,
  leadActivitiesTable,
} from "@workspace/db";
import type { AiWorkflowRecommendation } from "@workspace/db";
import { and, eq, isNull, inArray, notInArray, desc, type AnyColumn } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import { canAccessCompany, tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "../repositories/base.js";
import { PROMPTS, type AppLanguage } from "../ai/prompts.js";
import type { AiFeature } from "../ai/types.js";
import {
  logAiError,
  phraseWorkflowNextAction,
  phraseWorkflowRouting,
  phraseWorkflowProgression,
  phraseWorkflowReminder,
  phraseWorkflowTask,
  type WorkflowNextActionResult,
  type WorkflowRoutingResult,
  type WorkflowProgressionResult,
  type WorkflowReminderResult,
  type WorkflowTaskResult,
} from "../lib/ai.js";
import { resolveSettings } from "./ai.service.js";
import * as repo from "../repositories/ai_workflow.repository.js";
import type { EntityType, RecommendationType, UpsertRecommendationInput } from "../repositories/ai_workflow.repository.js";
import * as analyticsRepo from "../repositories/analytics.repository.js";
import {
  localDateStr,
  addDaysStr,
  detectLeadRisks,
  detectContactRisks,
  detectTaskRisks,
  detectFollowUpRisks,
  leadFollowupCore,
  contactFollowupCore,
  leadNextActionCore,
  contactNextActionCore,
  leadPriorityCore,
  computeRouting,
  leadProgressionCore,
  computeHealth,
  analyzeBottlenecks,
  simulate,
  type LeadRow,
  type ContactRow,
  type TaskRow,
  type FollowUpRow,
  type RoutingCandidate,
  type WorkloadEntry,
  type SlaRisk,
  type ScenarioType,
} from "../lib/workflow-intelligence.js";

// ---------------------------------------------------------------------------
// Stage 5F — Enterprise AI Workflow & Automation Intelligence service.
//
// Orchestrates the ADVISORY workflow layer. Every recommendation, health rollup,
// SLA-risk list, bottleneck report, and simulation is a REVIEWABLE suggestion
// derived from real, tenant-scoped CRM rows. This service NEVER executes anything:
// it never assigns an owner, routes a lead, changes a stage, creates/sends a task,
// reminder, or message, and never writes back to the CRM tables. It only writes
// its own `ai_workflow_recommendations` rows (upserted for later human review) and
// reads everything else. Deterministic decision cores come from the pure engines in
// lib/workflow-intelligence.ts; AI phrasing (5 runners) is best-effort on top and
// soft-degrades — on any AI failure the deterministic core survives (HTTP 200) and
// a deterministic row NEVER carries AI provenance.
// ---------------------------------------------------------------------------

const MAX_ROWS = 5000; // bound the per-scope working set for the read-only rollups

function isManager(role: string): boolean {
  return role === "primary_admin" || role === "admin";
}

// ── Entity loaders (tenant isolation via canAccessCompany → 404) ───────────────

async function loadLead(user: AuthUser, id: number) {
  const [row] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt))).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Lead not found");
  return row;
}

async function loadContact(user: AuthUser, id: number) {
  const [row] = await db.select().from(contactsTable).where(and(eq(contactsTable.id, id), isNull(contactsTable.deletedAt))).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Contact not found");
  return row;
}

async function loadOrganization(user: AuthUser, id: number) {
  const [row] = await db.select().from(organizationsTable).where(and(eq(organizationsTable.id, id), isNull(organizationsTable.deletedAt))).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Company not found");
  return row;
}

export function assertEntityType(raw: string): EntityType {
  if (raw === "lead" || raw === "contact" || raw === "organization") return raw;
  throw new AppError(400, `entityType must be one of: lead, contact, organization`);
}

// Verify the caller can access the entity (tenant isolation → 404). Used by read paths
// that must not leak existence with an empty 200 for a foreign/nonexistent entity.
async function assertEntityAccess(user: AuthUser, entityType: EntityType, id: number): Promise<void> {
  if (entityType === "lead") await loadLead(user, id);
  else if (entityType === "contact") await loadContact(user, id);
  else await loadOrganization(user, id);
}

// ── Provenance helpers ─────────────────────────────────────────────────────────
//
// A deterministic row NEVER carries provider/model/promptKey/promptVersion — those
// are stamped ONLY when the AI phrasing succeeds and the source flips to "ai".

function detRec(
  companyId: number,
  entityType: EntityType,
  entityId: number,
  type: RecommendationType,
  data: Record<string, unknown>,
  confidence: number,
  reasoning: string,
): UpsertRecommendationInput {
  return { companyId, entityType, entityId, recommendationType: type, data, confidence, reasoning, source: "deterministic" };
}

interface PhraseCore {
  data: Record<string, unknown>;
  reasoning: string;
}

// Compose a recommendation whose DECISION CORE is deterministic and whose WORDING is
// best-effort AI. Starts as the deterministic core; on AI success the wording is merged
// in, confidence/reasoning come from the model, and provenance flips to source="ai".
async function phrasedRec<T extends { confidence: number | null; reasoning: string | null }>(
  companyId: number,
  entityType: EntityType,
  entityId: number,
  type: RecommendationType,
  feature: AiFeature,
  runtime: { provider?: string; model?: string },
  core: PhraseCore,
  run: () => Promise<T>,
  merge: (p: T) => Record<string, unknown>,
): Promise<UpsertRecommendationInput> {
  try {
    const p = await run();
    const prompt = PROMPTS[feature];
    return {
      companyId, entityType, entityId, recommendationType: type,
      data: merge(p),
      confidence: p.confidence,
      reasoning: p.reasoning || core.reasoning,
      source: "ai",
      provider: runtime.provider ?? null,
      model: runtime.model ?? null,
      promptKey: prompt.key,
      promptVersion: prompt.version,
    };
  } catch (err) {
    logAiError(`ai-workflow:${type}`, err);
    return detRec(companyId, entityType, entityId, type, core.data, 100, core.reasoning);
  }
}

// ── Context builders for the AI phrasing runners ───────────────────────────────

function leadLines(lead: LeadRow): string {
  const parts = [
    `Lead: ${lead.title ?? `#${lead.id}`}`,
    `Stage: ${lead.stage}`,
    lead.value != null ? `Value: ${lead.value} ${lead.currency ?? "USD"}` : null,
    lead.closingDate ? `Closing date: ${lead.closingDate}` : null,
    lead.priority ? `Priority: ${lead.priority}` : null,
    lead.probability != null ? `Probability: ${lead.probability}%` : null,
    `Created: ${lead.createdAt.toISOString().slice(0, 10)}`,
    `Last updated: ${lead.updatedAt.toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  return parts.join("\n");
}

function contactLinesText(c: ContactRow): string {
  const parts = [
    `Contact #${c.id}`,
    `Status: ${c.status}`,
    c.followUpDate ? `Follow-up date: ${c.followUpDate}` : "Follow-up date: (none set)",
    `Email: ${c.email ? "on file" : "missing"}`,
    `Mobile: ${c.mobile ? "on file" : "missing"}`,
  ];
  return parts.join("\n");
}

function withSignals(lines: string, signals: string[]): string {
  return `${lines}\n\nComputed signals:\n${signals.map((s) => `- ${s}`).join("\n")}`;
}

// ── Per-entity analysis ────────────────────────────────────────────────────────

async function lastActivityForLead(companyId: number, leadId: number): Promise<Date | null> {
  const [row] = await db
    .select({ occurredAt: leadActivitiesTable.occurredAt })
    .from(leadActivitiesTable)
    .where(and(
      eq(leadActivitiesTable.companyId, companyId),
      eq(leadActivitiesTable.leadId, leadId),
      isNull(leadActivitiesTable.deletedAt),
      inArray(leadActivitiesTable.type, ["call", "email", "meeting", "message"]),
    ))
    .orderBy(desc(leadActivitiesTable.occurredAt))
    .limit(1);
  return row?.occurredAt ?? null;
}

// Resolve the lead's geography + industry from its linked organization, then contact.
async function leadGeoIndustry(companyId: number, lead: LeadRow): Promise<{ country: string | null; industry: string | null }> {
  let country: string | null = null;
  let industry: string | null = null;
  if (lead.organizationId != null) {
    const [o] = await db
      .select({ country: organizationsTable.country, industry: organizationsTable.industry })
      .from(organizationsTable)
      .where(and(eq(organizationsTable.id, lead.organizationId), eq(organizationsTable.companyId, companyId)))
      .limit(1);
    country = o?.country ?? null;
    industry = o?.industry ?? null;
  }
  if ((country == null || industry == null) && lead.contactId != null) {
    const [c] = await db
      .select({ country: contactsTable.country, industry: contactsTable.industry })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, lead.contactId), eq(contactsTable.companyId, companyId)))
      .limit(1);
    country = country ?? c?.country ?? null;
    industry = industry ?? c?.industry ?? null;
  }
  return { country, industry };
}

// Build the routing candidate pool for a lead: active tenant reps with workload,
// historical win/loss, and territory/industry match — all grounded, read-only.
async function loadRoutingCandidates(companyId: number, lead: LeadRow): Promise<{ candidates: RoutingCandidate[]; byId: Map<number, { departmentId: number | null; teamId: number | null }> }> {
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, departmentId: usersTable.departmentId, teamId: usersTable.teamId })
    .from(usersTable)
    .where(and(
      eq(usersTable.companyId, companyId),
      eq(usersTable.isActive, true),
      isNull(usersTable.deletedAt),
      inArray(usersTable.role, ["primary_admin", "admin", "employee"]),
    ));
  if (users.length === 0) return { candidates: [], byId: new Map() };
  const ids = users.map((u) => u.id);

  const allLeads = await db
    .select({ assignedToId: leadsTable.assignedToId, stage: leadsTable.stage })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), isNull(leadsTable.deletedAt), inArray(leadsTable.assignedToId, ids)))
    .limit(MAX_ROWS);

  const openByUser = new Map<number, number>();
  const wonByUser = new Map<number, number>();
  const lostByUser = new Map<number, number>();
  for (const l of allLeads) {
    if (l.assignedToId == null) continue;
    const s = l.stage.toLowerCase();
    if (s === "won") wonByUser.set(l.assignedToId, (wonByUser.get(l.assignedToId) ?? 0) + 1);
    else if (s === "lost") lostByUser.set(l.assignedToId, (lostByUser.get(l.assignedToId) ?? 0) + 1);
    else openByUser.set(l.assignedToId, (openByUser.get(l.assignedToId) ?? 0) + 1);
  }

  const geo = await leadGeoIndustry(companyId, lead);

  // Territory match: any territory owned by the user whose matchCriteria.countries
  // includes the lead's country.
  const territoryOwners = new Set<number>();
  if (geo.country) {
    const terrs = await db
      .select({ assignedToId: territoriesTable.assignedToId, matchCriteria: territoriesTable.matchCriteria })
      .from(territoriesTable)
      .where(and(eq(territoriesTable.companyId, companyId), isNull(territoriesTable.deletedAt), inArray(territoriesTable.assignedToId, ids)));
    const wanted = geo.country.toLowerCase();
    for (const t of terrs) {
      if (t.assignedToId == null || !t.matchCriteria) continue;
      try {
        const parsed = JSON.parse(t.matchCriteria) as { countries?: unknown };
        const countries = Array.isArray(parsed.countries) ? parsed.countries.map((c) => String(c).toLowerCase()) : [];
        if (countries.includes(wanted)) territoryOwners.add(t.assignedToId);
      } catch {
        // ignore malformed criteria
      }
    }
  }

  // Industry match: user owns at least one contact in the lead's industry.
  const industryOwners = new Set<number>();
  if (geo.industry) {
    const rows = await db
      .select({ assignedToId: contactsTable.assignedToId })
      .from(contactsTable)
      .where(and(
        eq(contactsTable.companyId, companyId),
        isNull(contactsTable.deletedAt),
        eq(contactsTable.industry, geo.industry),
        inArray(contactsTable.assignedToId, ids),
      ))
      .limit(MAX_ROWS);
    for (const r of rows) if (r.assignedToId != null) industryOwners.add(r.assignedToId);
  }

  const candidates: RoutingCandidate[] = users.map((u) => ({
    userId: u.id,
    name: u.name,
    openLeads: openByUser.get(u.id) ?? 0,
    won: wonByUser.get(u.id) ?? 0,
    lost: lostByUser.get(u.id) ?? 0,
    territoryMatch: territoryOwners.has(u.id),
    industryMatch: industryOwners.has(u.id),
  }));
  const byId = new Map(users.map((u) => [u.id, { departmentId: u.departmentId, teamId: u.teamId }]));
  return { candidates, byId };
}

async function analyzeLead(user: AuthUser, lead: LeadRow & { companyId: number }, language: AppLanguage, runtime: { provider?: string; model?: string }): Promise<void> {
  const cid = lead.companyId;
  const today = localDateStr(new Date());
  const now = new Date();
  const ctx = { companyId: cid, userId: user.id };
  const lastActivity = await lastActivityForLead(cid, lead.id);
  const lines = leadLines(lead);
  const recs: UpsertRecommendationInput[] = [];

  // next_action (AI-phrased)
  const na = leadNextActionCore(lead, today, now, lastActivity);
  recs.push(await phrasedRec<WorkflowNextActionResult>(
    cid, "lead", lead.id, "next_action", "workflow_next_action", runtime,
    { data: { action: na.action, priority: na.priority, rationale: na.basis }, reasoning: na.basis },
    () => phraseWorkflowNextAction(withSignals(lines, [`Best next action: ${na.action}`, `Priority: ${na.priority}`, `Basis: ${na.basis}`]), language, ctx),
    (p) => ({ action: p.recommendedAction ?? na.action, priority: na.priority, rationale: p.rationale ?? na.basis }),
  ));

  // follow_up (deterministic)
  const fu = leadFollowupCore(lead, today, now);
  recs.push(detRec(cid, "lead", lead.id, "follow_up", { suggestedDate: fu.suggestedDate, priority: fu.priority, channel: fu.channel, overdue: fu.overdue, basis: fu.basis }, 100, fu.basis));

  // due_date (deterministic)
  recs.push(detRec(cid, "lead", lead.id, "due_date", { suggestedDate: fu.suggestedDate, basis: fu.basis }, 100, `Suggested next-action date: ${fu.suggestedDate}.`));

  // priority (deterministic)
  const pr = leadPriorityCore(lead, today, now);
  recs.push(detRec(cid, "lead", lead.id, "priority", { suggestedPriority: pr.priority, basis: pr.basis }, 100, pr.basis));

  // reminder (AI-phrased)
  const reminderCore = `Reminder to work "${lead.title ?? `Lead #${lead.id}`}" by ${fu.suggestedDate} — ${na.action}`;
  recs.push(await phrasedRec<WorkflowReminderResult>(
    cid, "lead", lead.id, "reminder", "workflow_reminder", runtime,
    { data: { reminderText: reminderCore, dueDate: fu.suggestedDate, basis: fu.basis }, reasoning: fu.basis },
    () => phraseWorkflowReminder(withSignals(lines, [`Reminder timing: ${fu.suggestedDate}`, `Subject: ${na.action}`, `Basis: ${fu.basis}`]), language, ctx),
    (p) => ({ reminderText: p.reminderText ?? reminderCore, dueDate: fu.suggestedDate, basis: fu.basis }),
  ));

  // task (AI-phrased)
  const taskTitleCore = `Follow up: ${lead.title ?? `Lead #${lead.id}`}`;
  recs.push(await phrasedRec<WorkflowTaskResult>(
    cid, "lead", lead.id, "task", "workflow_task", runtime,
    { data: { taskTitle: taskTitleCore, taskDescription: na.action, dueDate: fu.suggestedDate, type: "follow_up" }, reasoning: na.basis },
    () => phraseWorkflowTask(withSignals(lines, [`Task intent: ${na.action}`, `Due timing: ${fu.suggestedDate}`, `Basis: ${na.basis}`]), language, ctx),
    (p) => ({ taskTitle: p.taskTitle ?? taskTitleCore, taskDescription: p.taskDescription ?? na.action, dueDate: fu.suggestedDate, type: "follow_up" }),
  ));

  // progression (AI-phrased)
  const prog = leadProgressionCore(lead, []);
  recs.push(await phrasedRec<WorkflowProgressionResult>(
    cid, "lead", lead.id, "progression", "workflow_progression", runtime,
    { data: { currentStage: prog.currentStage, suggestedStageKey: prog.suggestedStageKey, suggestedStageName: prog.suggestedStageName, action: prog.action, basis: prog.basis }, reasoning: prog.basis },
    () => phraseWorkflowProgression(withSignals(lines, [`Current stage: ${prog.currentStage}`, `Suggested next stage: ${prog.suggestedStageName ?? "(none)"}`, `Basis: ${prog.basis}`]), language, ctx),
    (p) => ({ currentStage: prog.currentStage, suggestedStageKey: prog.suggestedStageKey, suggestedStageName: prog.suggestedStageName, action: p.recommendation ?? prog.action, basis: prog.basis }),
  ));

  // routing + owner/department/team (only when a real candidate exists)
  const { candidates, byId } = await loadRoutingCandidates(cid, lead);
  const routing = computeRouting(candidates);
  if (routing.suggestedOwnerId != null) {
    const routingLines = withSignals(lines, [
      `Suggested owner: ${routing.suggestedOwnerName}`,
      `Basis: ${routing.basis}`,
      `Ranked: ${routing.ranked.slice(0, 3).map((r) => `${r.name} (${r.score})`).join(", ")}`,
    ]);
    recs.push(await phrasedRec<WorkflowRoutingResult>(
      cid, "lead", lead.id, "routing", "workflow_routing", runtime,
      { data: { suggestedOwnerId: routing.suggestedOwnerId, suggestedOwnerName: routing.suggestedOwnerName, ranked: routing.ranked, basis: routing.basis }, reasoning: routing.basis },
      () => phraseWorkflowRouting(routingLines, language, ctx),
      (p) => ({ suggestedOwnerId: routing.suggestedOwnerId, suggestedOwnerName: routing.suggestedOwnerName, ranked: routing.ranked, recommendation: p.recommendation ?? routing.basis, basis: routing.basis }),
    ));
    recs.push(detRec(cid, "lead", lead.id, "owner", { suggestedOwnerId: routing.suggestedOwnerId, suggestedOwnerName: routing.suggestedOwnerName, basis: routing.basis }, routing.confidence, routing.basis));
    const org = byId.get(routing.suggestedOwnerId);
    if (org?.departmentId != null) {
      recs.push(detRec(cid, "lead", lead.id, "department", { departmentId: org.departmentId, basis: `${routing.suggestedOwnerName} belongs to this department.` }, 100, `Derived from the suggested owner's department.`));
    }
    if (org?.teamId != null) {
      recs.push(detRec(cid, "lead", lead.id, "team", { teamId: org.teamId, basis: `${routing.suggestedOwnerName} belongs to this team.` }, 100, `Derived from the suggested owner's team.`));
    }
  }

  for (const r of recs) await repo.upsertRecommendation(r);
}

async function analyzeContact(user: AuthUser, contact: ContactRow & { companyId: number }, language: AppLanguage, runtime: { provider?: string; model?: string }): Promise<void> {
  const cid = contact.companyId;
  const today = localDateStr(new Date());
  const now = new Date();
  const ctx = { companyId: cid, userId: user.id };
  const lines = contactLinesText(contact);
  const recs: UpsertRecommendationInput[] = [];

  const na = contactNextActionCore(contact, today);
  recs.push(await phrasedRec<WorkflowNextActionResult>(
    cid, "contact", contact.id, "next_action", "workflow_next_action", runtime,
    { data: { action: na.action, priority: na.priority, rationale: na.basis }, reasoning: na.basis },
    () => phraseWorkflowNextAction(withSignals(lines, [`Best next action: ${na.action}`, `Priority: ${na.priority}`, `Basis: ${na.basis}`]), language, ctx),
    (p) => ({ action: p.recommendedAction ?? na.action, priority: na.priority, rationale: p.rationale ?? na.basis }),
  ));

  const fu = contactFollowupCore(contact, today, now);
  recs.push(detRec(cid, "contact", contact.id, "follow_up", { suggestedDate: fu.suggestedDate, priority: fu.priority, channel: fu.channel, overdue: fu.overdue, basis: fu.basis }, 100, fu.basis));
  recs.push(detRec(cid, "contact", contact.id, "due_date", { suggestedDate: fu.suggestedDate, basis: fu.basis }, 100, `Suggested next-action date: ${fu.suggestedDate}.`));
  recs.push(detRec(cid, "contact", contact.id, "priority", { suggestedPriority: fu.priority, basis: fu.basis }, 100, fu.basis));

  const reminderCore = `Reminder to follow up with contact #${contact.id} by ${fu.suggestedDate}`;
  recs.push(await phrasedRec<WorkflowReminderResult>(
    cid, "contact", contact.id, "reminder", "workflow_reminder", runtime,
    { data: { reminderText: reminderCore, dueDate: fu.suggestedDate, basis: fu.basis }, reasoning: fu.basis },
    () => phraseWorkflowReminder(withSignals(lines, [`Reminder timing: ${fu.suggestedDate}`, `Subject: ${na.action}`, `Basis: ${fu.basis}`]), language, ctx),
    (p) => ({ reminderText: p.reminderText ?? reminderCore, dueDate: fu.suggestedDate, basis: fu.basis }),
  ));

  const taskTitleCore = `Follow up with contact #${contact.id}`;
  recs.push(await phrasedRec<WorkflowTaskResult>(
    cid, "contact", contact.id, "task", "workflow_task", runtime,
    { data: { taskTitle: taskTitleCore, taskDescription: na.action, dueDate: fu.suggestedDate, type: "follow_up" }, reasoning: na.basis },
    () => phraseWorkflowTask(withSignals(lines, [`Task intent: ${na.action}`, `Due timing: ${fu.suggestedDate}`, `Basis: ${na.basis}`]), language, ctx),
    (p) => ({ taskTitle: p.taskTitle ?? taskTitleCore, taskDescription: p.taskDescription ?? na.action, dueDate: fu.suggestedDate, type: "follow_up" }),
  ));

  for (const r of recs) await repo.upsertRecommendation(r);
}

async function analyzeOrganization(user: AuthUser, org: { id: number; companyId: number; industry: string | null }, language: AppLanguage, runtime: { provider?: string; model?: string }): Promise<void> {
  const cid = org.companyId;
  const ctx = { companyId: cid, userId: user.id };
  // Count linked contacts to ground the next action (read-only).
  const linked = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, cid), eq(contactsTable.organizationId, org.id), isNull(contactsTable.deletedAt)))
    .limit(50);
  const action = linked.length === 0
    ? "Link the key contacts at this company so their leads can be worked."
    : "Review this company's open opportunities and plan coordinated outreach.";
  const basis = linked.length === 0 ? "No contacts are linked to this company yet." : `${linked.length} contact(s) are linked to this company.`;
  const lines = [`Company #${org.id}`, org.industry ? `Industry: ${org.industry}` : "Industry: (unknown)", `Linked contacts: ${linked.length}`].join("\n");

  const rec = await phrasedRec<WorkflowNextActionResult>(
    cid, "organization", org.id, "next_action", "workflow_next_action", runtime,
    { data: { action, priority: linked.length === 0 ? "High" : "Normal", rationale: basis }, reasoning: basis },
    () => phraseWorkflowNextAction(withSignals(lines, [`Best next action: ${action}`, `Basis: ${basis}`]), language, ctx),
    (p) => ({ action: p.recommendedAction ?? action, priority: linked.length === 0 ? "High" : "Normal", rationale: p.rationale ?? basis }),
  );
  await repo.upsertRecommendation(rec);
}

export interface AnalyzeOptions {
  language?: AppLanguage;
}

export async function analyzeEntity(user: AuthUser, entityTypeRaw: string, id: number, opts: AnalyzeOptions = {}): Promise<AiWorkflowRecommendation[]> {
  const entityType = assertEntityType(entityTypeRaw);
  const language: AppLanguage = opts.language === "ar" ? "ar" : "en";

  let cid: number;
  if (entityType === "lead") {
    const lead = await loadLead(user, id);
    cid = lead.companyId;
  } else if (entityType === "contact") {
    const contact = await loadContact(user, id);
    cid = contact.companyId;
  } else {
    const org = await loadOrganization(user, id);
    cid = org.companyId;
  }

  // Stamp the ACTUAL runtime provider/model (resolveSettings) on AI rows; guarded so a
  // resolve failure never breaks the deterministic cores.
  let runtime: { provider?: string; model?: string } = {};
  try {
    const s = await resolveSettings(cid);
    runtime = { provider: s.provider, model: s.model };
  } catch {
    runtime = {};
  }

  if (entityType === "lead") {
    const lead = await loadLead(user, id);
    await analyzeLead(user, lead, language, runtime);
  } else if (entityType === "contact") {
    const contact = await loadContact(user, id);
    await analyzeContact(user, contact, language, runtime);
  } else {
    const org = await loadOrganization(user, id);
    await analyzeOrganization(user, org, language, runtime);
  }

  return repo.listByEntity(user, entityType, id);
}

// Batch entry point (used by the workflow batch queue) — same analysis, no extra return.
export async function analyzeForBatch(user: AuthUser, entityType: EntityType, id: number): Promise<void> {
  await analyzeEntity(user, entityType, id, {});
}

// ── Scope resolution (mirrors executive-analytics scope privacy) ───────────────

type ScopeType = "company" | "department" | "team" | "employee";

interface ResolvedScope {
  scope: { type: ScopeType; id: number | null; name: string };
  userIds: number[] | null; // null => whole tenant (company overview)
}

function collectDescendants(all: analyticsRepo.DepartmentRow[], rootId: number): number[] {
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

async function resolveScope(user: AuthUser, opts: { scopeType?: string; id?: number }): Promise<ResolvedScope> {
  const t = opts.scopeType;
  if (t === "employee" && opts.id != null) {
    const emp = await analyticsRepo.findEmployee(user, opts.id);
    if (!emp) throw new AppError(404, "Employee not found");
    if (!isManager(user.role) && emp.id !== user.id) throw new AppError(403, "You can only view your own workflow");
    return { scope: { type: "employee", id: opts.id, name: emp.name }, userIds: [opts.id] };
  }
  if (t === "team" && opts.id != null) {
    const team = await analyticsRepo.findTeam(user, opts.id);
    if (!team) throw new AppError(404, "Team not found");
    if (!isManager(user.role) && team.leaderId !== user.id) throw new AppError(403, "Only the team lead can view this team's workflow");
    const userIds = await analyticsRepo.userIdsByTeam(user, opts.id);
    return { scope: { type: "team", id: opts.id, name: team.name }, userIds };
  }
  if (t === "department" && opts.id != null) {
    const dept = await analyticsRepo.findDepartment(user, opts.id);
    if (!dept) throw new AppError(404, "Department not found");
    if (!isManager(user.role) && dept.headId !== user.id) throw new AppError(403, "Only the department head can view this department's workflow");
    const all = await analyticsRepo.listTenantDepartments(user);
    const deptIds = collectDescendants(all, opts.id);
    const userIds = await analyticsRepo.userIdsByDepartments(user, deptIds);
    return { scope: { type: "department", id: opts.id, name: dept.name }, userIds };
  }
  // Company overview — managers only; non-managers fall back to their own employee scope.
  if (!isManager(user.role)) {
    const emp = await analyticsRepo.findEmployee(user, user.id);
    return { scope: { type: "employee", id: user.id, name: emp?.name ?? "You" }, userIds: [user.id] };
  }
  return { scope: { type: "company", id: null, name: "Company" }, userIds: null };
}

// ── Scoped loaders for the read-only rollups ───────────────────────────────────

function ownerFilter(column: AnyColumn, userIds: number[] | null) {
  return userIds ? inArray(column, userIds) : undefined;
}

async function loadScopedLeads(user: AuthUser, userIds: number[] | null): Promise<Array<LeadRow & { companyId: number }>> {
  return db
    .select({
      id: leadsTable.id, title: leadsTable.title, stage: leadsTable.stage, value: leadsTable.value,
      currency: leadsTable.currency, closingDate: leadsTable.closingDate, probability: leadsTable.probability,
      priority: leadsTable.priority, assignedToId: leadsTable.assignedToId, teamId: leadsTable.teamId,
      contactId: leadsTable.contactId, organizationId: leadsTable.organizationId,
      createdAt: leadsTable.createdAt, updatedAt: leadsTable.updatedAt, companyId: leadsTable.companyId,
    })
    .from(leadsTable)
    .where(combine(tenantScope(user, leadsTable.companyId), isNull(leadsTable.deletedAt), ownerFilter(leadsTable.assignedToId, userIds)))
    .limit(MAX_ROWS);
}

async function loadScopedContacts(user: AuthUser, userIds: number[] | null): Promise<ContactRow[]> {
  return db
    .select({
      id: contactsTable.id, status: contactsTable.status, followUpDate: contactsTable.followUpDate,
      email: contactsTable.email, mobile: contactsTable.mobile, assignedToId: contactsTable.assignedToId,
      createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
    })
    .from(contactsTable)
    .where(combine(tenantScope(user, contactsTable.companyId), isNull(contactsTable.deletedAt), ownerFilter(contactsTable.assignedToId, userIds)))
    .limit(MAX_ROWS);
}

async function loadScopedTasks(user: AuthUser, userIds: number[] | null): Promise<TaskRow[]> {
  return db
    .select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, dueDate: tasksTable.dueDate, assignedToId: tasksTable.assignedToId })
    .from(tasksTable)
    .where(combine(tenantScope(user, tasksTable.companyId), notInArray(tasksTable.status, ["completed", "cancelled"]), ownerFilter(tasksTable.assignedToId, userIds)))
    .limit(MAX_ROWS);
}

async function loadScopedFollowUps(user: AuthUser, userIds: number[] | null): Promise<FollowUpRow[]> {
  return db
    .select({ id: followUpsTable.id, status: followUpsTable.status, scheduledDate: followUpsTable.scheduledDate, assignedToId: followUpsTable.assignedToId, contactId: followUpsTable.contactId })
    .from(followUpsTable)
    .where(combine(tenantScope(user, followUpsTable.companyId), eq(followUpsTable.status, "pending"), ownerFilter(followUpsTable.assignedToId, userIds)))
    .limit(MAX_ROWS);
}

async function lastActivityMap(user: AuthUser, leadIds: number[]): Promise<Map<number, Date | null>> {
  const map = new Map<number, Date | null>();
  if (leadIds.length === 0) return map;
  const rows = await db
    .select({ leadId: leadActivitiesTable.leadId, occurredAt: leadActivitiesTable.occurredAt })
    .from(leadActivitiesTable)
    .where(and(
      tenantScope(user, leadActivitiesTable.companyId)!,
      isNull(leadActivitiesTable.deletedAt),
      inArray(leadActivitiesTable.type, ["call", "email", "meeting", "message"]),
      inArray(leadActivitiesTable.leadId, leadIds),
    ))
    .orderBy(desc(leadActivitiesTable.occurredAt));
  for (const r of rows) {
    if (r.leadId == null) continue;
    if (!map.has(r.leadId)) map.set(r.leadId, r.occurredAt); // rows are DESC, first seen = latest
  }
  return map;
}

async function userNameMap(user: AuthUser, ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(combine(tenantScope(user, usersTable.companyId), inArray(usersTable.id, ids)));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

const STALLED_DAYS = 14;

function isTerminal(stage: string): boolean {
  const s = (stage ?? "").toLowerCase();
  return ["won", "lost", "closed"].some((t) => s.includes(t));
}

// Compute the full risk set for a scope (shared by health + sla-risk assemblers).
async function computeScopeRisks(user: AuthUser, userIds: number[] | null): Promise<{
  risks: SlaRisk[];
  leads: Array<LeadRow & { companyId: number }>;
  contacts: ContactRow[];
  tasks: TaskRow[];
  followUps: FollowUpRow[];
}> {
  const [leads, contacts, tasks, followUps] = await Promise.all([
    loadScopedLeads(user, userIds),
    loadScopedContacts(user, userIds),
    loadScopedTasks(user, userIds),
    loadScopedFollowUps(user, userIds),
  ]);
  const today = localDateStr(new Date());
  const now = new Date();
  const openLeadIds = leads.filter((l) => !isTerminal(l.stage)).map((l) => l.id);
  const lastActivityByLead = await lastActivityMap(user, openLeadIds);
  const risks = [
    ...detectLeadRisks(leads, { today, now, lastActivityByLead }),
    ...detectContactRisks(contacts, today),
    ...detectTaskRisks(tasks, today),
    ...detectFollowUpRisks(followUps, today),
  ];
  return { risks, leads, contacts, tasks, followUps };
}

export async function getHealth(user: AuthUser, opts: { scopeType?: string; id?: number } = {}) {
  const resolved = await resolveScope(user, opts);
  const { risks, leads, tasks, followUps } = await computeScopeRisks(user, resolved.userIds);

  const openLeads = leads.filter((l) => !isTerminal(l.stage));
  const trackedItems = openLeads.length + tasks.length + followUps.length;

  // Per-owner workload (open leads + overdue items).
  const overdueByOwner = new Map<number, number>();
  for (const r of risks) {
    if (r.ownerId == null) continue;
    const overdue = (r.category === "overdue_lead" || r.category === "missed_follow_up") || (r.category === "expiring_task" && (r.ageDays ?? 0) > 0);
    if (overdue) overdueByOwner.set(r.ownerId, (overdueByOwner.get(r.ownerId) ?? 0) + 1);
  }
  const openByOwner = new Map<number, number>();
  for (const l of openLeads) if (l.assignedToId != null) openByOwner.set(l.assignedToId, (openByOwner.get(l.assignedToId) ?? 0) + 1);
  const ownerIds = [...new Set([...openByOwner.keys(), ...overdueByOwner.keys()])];
  const names = await userNameMap(user, ownerIds);
  const workload: WorkloadEntry[] = ownerIds.map((uid) => ({
    userId: uid, name: names.get(uid) ?? `User #${uid}`,
    openLeads: openByOwner.get(uid) ?? 0, overdueItems: overdueByOwner.get(uid) ?? 0,
  }));

  const health = computeHealth({ risks, openLeads: openLeads.length, trackedItems, workload });
  return { scope: resolved.scope, ...health };
}

export async function getSlaRisks(user: AuthUser, opts: { scopeType?: string; id?: number; category?: string } = {}) {
  const resolved = await resolveScope(user, opts);
  const { risks } = await computeScopeRisks(user, resolved.userIds);
  const filtered = opts.category ? risks.filter((r) => r.category === opts.category) : risks;
  const rankOrder: Record<SlaRisk["riskLevel"], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...filtered].sort((a, b) => rankOrder[a.riskLevel] - rankOrder[b.riskLevel] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of filtered) counts[r.riskLevel] += 1;
  return { scope: resolved.scope, total: sorted.length, counts, risks: sorted };
}

export async function getBottlenecks(user: AuthUser, opts: { scopeType?: string; id?: number } = {}) {
  const resolved = await resolveScope(user, opts);
  const { risks, leads, tasks, followUps } = await computeScopeRisks(user, resolved.userIds);
  const now = new Date();

  const openLeads = leads.filter((l) => !isTerminal(l.stage));
  const stageMap = new Map<string, { open: number; stalled: number }>();
  for (const l of openLeads) {
    const cur = stageMap.get(l.stage) ?? { open: 0, stalled: 0 };
    cur.open += 1;
    if ((now.getTime() - l.updatedAt.getTime()) / 86_400_000 >= STALLED_DAYS) cur.stalled += 1;
    stageMap.set(l.stage, cur);
  }
  const stageStats = [...stageMap.entries()].map(([stage, v]) => ({ stage, open: v.open, stalled: v.stalled }));

  const openByOwner = new Map<number, number>();
  for (const l of openLeads) if (l.assignedToId != null) openByOwner.set(l.assignedToId, (openByOwner.get(l.assignedToId) ?? 0) + 1);
  const ownerIds = [...openByOwner.keys()];
  const names = await userNameMap(user, ownerIds);
  const workload: WorkloadEntry[] = ownerIds
    .map((uid) => ({ userId: uid, name: names.get(uid) ?? `User #${uid}`, openLeads: openByOwner.get(uid) ?? 0, overdueItems: 0 }))
    .sort((a, b) => b.openLeads - a.openLeads);

  const today = localDateStr(now);
  const overdueTasks = tasks.filter((t) => t.dueDate && t.dueDate < today).length;
  const overdueFollowUps = followUps.filter((f) => f.scheduledDate && f.scheduledDate < today).length;
  const wonCount = leads.filter((l) => l.stage.toLowerCase() === "won").length;
  const lostCount = leads.filter((l) => l.stage.toLowerCase() === "lost").length;

  const bottlenecks = analyzeBottlenecks({ stageStats, workload, overdueTasks, overdueFollowUps, wonCount, lostCount });
  return { scope: resolved.scope, bottlenecks, riskCount: risks.length };
}

// ── What-if simulation (predicted outcomes; writes NOTHING) ────────────────────

export interface SimulateInput {
  leadId: number;
  scenario: string;
  candidateUserId?: number;
  delayDays?: number;
}

export async function simulateScenario(user: AuthUser, input: SimulateInput) {
  const lead = await loadLead(user, input.leadId);
  const scenario = input.scenario;
  if (scenario !== "reassign" && scenario !== "follow_up" && scenario !== "delay") {
    throw new AppError(400, "scenario must be one of: reassign, follow_up, delay");
  }
  const today = localDateStr(new Date());
  const now = new Date();

  let candidate: RoutingCandidate | undefined;
  if (scenario === "reassign") {
    if (input.candidateUserId == null) throw new AppError(400, "candidateUserId is required for the reassign scenario");
    const { candidates } = await loadRoutingCandidates(lead.companyId, lead);
    candidate = candidates.find((c) => c.userId === input.candidateUserId);
    if (!candidate) throw new AppError(400, "candidateUserId is not an eligible owner in this company");
  }

  const result = simulate(lead, scenario as ScenarioType, { candidate, delayDays: input.delayDays }, today, now);
  return { leadId: lead.id, ...result };
}

// ── Recommendation review lifecycle (accept / dismiss) ─────────────────────────

export async function listEntityRecommendations(user: AuthUser, entityTypeRaw: string, id: number): Promise<AiWorkflowRecommendation[]> {
  const entityType = assertEntityType(entityTypeRaw);
  // Verify entity access first so a foreign/nonexistent entity 404s (no existence
  // leak), matching the analyze path and /ai/copilot — never return an empty 200.
  await assertEntityAccess(user, entityType, id);
  return repo.listByEntity(user, entityType, id);
}

export async function setRecommendationStatus(user: AuthUser, id: number, status: "accepted" | "dismissed"): Promise<AiWorkflowRecommendation> {
  const existing = await repo.getById(user, id);
  if (!existing) throw new AppError(404, "Recommendation not found");
  const row = await repo.setStatus(user, id, status, status === "accepted" ? user.id : null);
  if (!row) throw new AppError(404, "Recommendation not found");
  return row;
}

export async function getOverview(user: AuthUser) {
  // The overview is the COMPANY-WIDE review summary (tenant-wide counts + recent
  // recommendations). Per the Stage 5F scope-privacy contract, company-wide views
  // are manager-only — non-managers must use their own scoped rollups instead of
  // seeing every colleague's recommendations.
  if (!isManager(user.role)) throw new AppError(403, "The workflow overview is available to managers only");
  const [counts, recent] = await Promise.all([repo.statusCounts(user), repo.recentForCompany(user, 20)]);
  return { counts, recent };
}

export { addDaysStr };
