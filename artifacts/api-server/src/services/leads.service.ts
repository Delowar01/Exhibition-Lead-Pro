import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible, refInCompany } from "../lib/tenant.js";
import * as orgRepo from "../repositories/organizations.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as pipelineRepo from "../repositories/pipeline_stages.repository.js";
import * as tagsRepo from "../repositories/tags.repository.js";
import * as activitiesRepo from "../repositories/lead_activities.repository.js";
import * as territoriesRepo from "../repositories/territories.repository.js";
import { ensureStages } from "./pipeline.service.js";
import * as customFields from "./custom_fields.service.js";
import { parseListQuery } from "../lib/list-query.js";
import { convertCurrency } from "../lib/currency.js";
import { recommendAssignee as aiRecommendAssignee, logAiError } from "../lib/ai.js";

// Legacy default stage order — kept only as a fallback when a tenant somehow
// has no configured stages (getPipeline now honours the configured list).
const PIPELINE_STAGES = ["prospect", "qualified", "proposal_sent", "negotiation", "won", "lost"];

// ── Canonical closed-stage semantics ─────────────────────────────────────────
// Terminal ("closed") status comes from the CONFIGURED stage flags isWon/isLost;
// the literal keys "won"/"lost" are only a fallback for legacy rows that do not
// resolve to a live configured stage. Every consumer (create conflict, reopen
// conflict, lifecycle activities, pipeline totals, import dedup) shares this.
export interface StageOutcomeFlags {
  isWon?: boolean | null;
  isLost?: boolean | null;
}

export function stageOutcome(
  flags: StageOutcomeFlags | null | undefined,
  stageKey: string | null | undefined,
): { closed: boolean; won: boolean; lost: boolean } {
  if (flags) {
    const won = flags.isWon === true;
    const lost = flags.isLost === true;
    return { closed: won || lost, won, lost };
  }
  const won = stageKey === "won";
  const lost = stageKey === "lost";
  return { closed: won || lost, won, lost };
}

type ContactSummary = { firstName: string | null; lastName: string | null; fullName: string | null; email: string | null; contactCompany: string | null };
type LeadHistoryItem = { id: number; leadId: number; changedBy: number | null; changedByName: string | null; fieldName: string; oldValue: string | null; newValue: string | null; changedAt: string };
type StageLite = { name: string; key: string };
type TagLite = { id: number; companyId: number; name: string; color: string | null; category: string | null; createdAt: string };
type HistoryInsert = { leadId: number; changedBy: number; fieldName: string; oldValue: string | null; newValue: string | null };

function fmtTags(tags: Array<{ id: number; companyId: number; name: string; color: string | null; category: string | null; createdAt: Date }>): TagLite[] {
  return tags.map((t) => ({ id: t.id, companyId: t.companyId, name: t.name, color: t.color ?? null, category: t.category ?? null, createdAt: t.createdAt.toISOString() }));
}

// Emit a system (non-user-authored) lifecycle activity. Never throws — activity
// logging must not break the underlying lead mutation.
async function emitSystemActivity(lead: leadsRepo.LeadRow, userId: number, type: string, subject: string, metadata?: Record<string, unknown>): Promise<void> {
  try {
    await activitiesRepo.insert({
      companyId: lead.companyId,
      leadId: lead.id,
      contactId: lead.contactId ?? null,
      userId,
      type,
      source: "system",
      subject,
      metadata: metadata ?? null,
    });
  } catch {
    // swallow — see above
  }
}

// Single source of truth for the enriched-lead response shape. Both the per-row
// path (enrichLead, needs history) and the batched path (enrichLeads, for
// list/pipeline) build their output here so the JSON is byte-for-byte identical.
function formatLead(
  l: leadsRepo.LeadRow,
  contact: ContactSummary | null | undefined,
  assignedToName: string | null,
  eventName: string | null,
  opts?: { stage?: StageLite | null; teamName?: string | null; tags?: TagLite[]; history?: LeadHistoryItem[]; organizationName?: string | null },
) {
  return {
    ...l,
    organizationName: opts?.organizationName ?? null,
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
    assignedToName: assignedToName ?? null,
    eventName: eventName ?? null,
    stageName: opts?.stage?.name ?? null,
    stageKey: opts?.stage?.key ?? null,
    teamName: opts?.teamName ?? null,
    tags: opts?.tags ?? [],
    history: opts?.history,
  };
}

async function enrichLead(l: leadsRepo.LeadRow, includeHistory = false) {
  const contact = l.contactId ? await leadsRepo.contactSummary(l.contactId) : null;
  const assignee = l.assignedToId ? await leadsRepo.assigneeName(l.assignedToId) : null;
  const event = l.eventId ? await leadsRepo.eventName(l.eventId) : null;
  const stage = l.stageId ? await leadsRepo.stageInfo(l.stageId) : null;
  const team = l.teamId ? await leadsRepo.teamName(l.teamId) : null;
  const organizationName = l.organizationId ? await orgRepo.nameById(l.organizationId) : null;
  const tags = fmtTags(await tagsRepo.tagsForLead(l.id));

  let history: LeadHistoryItem[] = [];
  if (includeHistory) {
    const rows = await leadsRepo.history(l.id);
    history = rows.map(r => ({ ...r, changedAt: r.changedAt.toISOString() }));
  }

  return formatLead(l, contact, assignee?.name ?? null, event?.name ?? null, {
    stage: stage ? { name: stage.name, key: stage.key } : null,
    teamName: team?.name ?? null,
    tags,
    organizationName,
    history: includeHistory ? history : undefined,
  });
}

// Batched enrichment for list/pipeline: a fixed number of lookups (contacts +
// users + events + stages + teams + tags) instead of per row. Never includes
// history (list views don't need it), matching enrichLead(l, false) exactly.
export async function enrichLeads(rows: leadsRepo.LeadRow[]) {
  const contactIds = [...new Set(rows.map((l) => l.contactId).filter((v): v is number => v != null))];
  const userIds = [...new Set(rows.map((l) => l.assignedToId).filter((v): v is number => v != null))];
  const eventIds = [...new Set(rows.map((l) => l.eventId).filter((v): v is number => v != null))];
  const stageIds = [...new Set(rows.map((l) => l.stageId).filter((v): v is number => v != null))];
  const teamIds = [...new Set(rows.map((l) => l.teamId).filter((v): v is number => v != null))];
  const orgIds = [...new Set(rows.map((l) => l.organizationId).filter((v): v is number => v != null))];
  const leadIds = rows.map((l) => l.id);
  const [contacts, users, events, stages, teams, tagMap, orgNameById] = await Promise.all([
    leadsRepo.contactSummariesByIds(contactIds),
    leadsRepo.userNamesByIds(userIds),
    leadsRepo.eventNamesByIds(eventIds),
    leadsRepo.stageInfosByIds(stageIds),
    leadsRepo.teamNamesByIds(teamIds),
    tagsRepo.tagsForLeads(leadIds),
    orgRepo.namesByIds(orgIds),
  ]);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const userNameById = new Map(users.map((u) => [u.id, u.name]));
  const eventNameById = new Map(events.map((e) => [e.id, e.name]));
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]));
  return rows.map((l) => {
    const stage = l.stageId != null ? stageById.get(l.stageId) : undefined;
    return formatLead(
      l,
      l.contactId != null ? contactById.get(l.contactId) : null,
      l.assignedToId != null ? (userNameById.get(l.assignedToId) ?? null) : null,
      l.eventId != null ? (eventNameById.get(l.eventId) ?? null) : null,
      {
        stage: stage ? { name: stage.name, key: stage.key } : null,
        teamName: l.teamId != null ? (teamNameById.get(l.teamId) ?? null) : null,
        tags: fmtTags(tagMap.get(l.id) ?? []),
        organizationName: l.organizationId != null ? (orgNameById.get(l.organizationId) ?? null) : null,
      },
    );
  });
}

export interface ListLeadsParams {
  stage?: string;
  assignedTo?: string;
  eventId?: string;
  contactId?: string;
  page?: string;
  limit?: string;
}

export async function listLeads(user: AuthUser, params: ListLeadsParams) {
  const { stage, assignedTo, eventId, contactId } = params;
  const { page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 100, maxPageSize: 500 });

  const { rows, total } = await leadsRepo.list(user, {
    stage,
    assignedToId: assignedTo && !isNaN(parseInt(assignedTo)) ? parseInt(assignedTo) : undefined,
    eventId: eventId && !isNaN(parseInt(eventId)) ? parseInt(eventId) : undefined,
    contactId: contactId && !isNaN(parseInt(contactId)) ? parseInt(contactId) : undefined,
    limit: limitNum,
    offset,
  });
  const enriched = await enrichLeads(rows);
  return { leads: enriched, total };
}

export interface LeadInput {
  contactId?: number | null;
  stage?: string;
  title?: string | null;
  value?: unknown;
  currency?: string | null;
  closingDate?: string | null;
  probability?: number | null;
  priority?: string | null;
  notes?: string | null;
  companyName?: string | null;
  assignedToId?: number | null;
  eventId?: number | null;
  stageId?: number | null;
  teamId?: number | null;
  organizationId?: number | null;
  source?: string | null;
}

export type CreateLeadResult =
  | { conflict: true; existingId: number }
  | { conflict: false; lead: Awaited<ReturnType<typeof enrichLead>> };

export async function createLead(user: AuthUser, input: LeadInput): Promise<CreateLeadResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { contactId, stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId, stageId, teamId, organizationId, source } = input;

  if (contactId != null && !(await refAccessible(user, "contacts", contactId))) throw new AppError(400, "Invalid contactId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (stageId != null && !(await refInCompany("pipelineStages", companyId, stageId))) throw new AppError(400, "Invalid stageId");
  if (teamId != null && !(await refInCompany("teams", companyId, teamId))) throw new AppError(400, "Invalid teamId");
  if (organizationId != null && !(await refInCompany("organizations", companyId, organizationId))) throw new AppError(400, "Invalid organizationId");

  // 409 if this contact already has an OPEN (non-terminal-stage) lead here
  if (contactId != null) {
    const existingId = await leadsRepo.activeLeadIdForContact(companyId, contactId);
    if (existingId !== undefined) {
      return { conflict: true, existingId };
    }
  }

  // Keep the legacy text `stage` and the configurable `stageId` consistent: a
  // provided stageId wins and drives the text; otherwise resolve stageId from
  // the stage key. Seed defaults first so key resolution succeeds. A supplied
  // stage/stageId MUST resolve to a live configured stage for this company —
  // unknown keys and soft-deleted stages are rejected, nothing is written.
  await ensureStages(companyId);
  let stageText = stage ?? "prospect";
  let resolvedStageId = stageId ?? null;
  if (stageId != null) {
    const s = await leadsRepo.stageInfo(stageId);
    if (!s) throw new AppError(400, "Invalid stageId");
    stageText = s.key;
  } else {
    const s = await pipelineRepo.findByKey(companyId, stageText);
    if (!s) throw new AppError(400, `Unknown stage "${stageText}" — it must match a configured pipeline stage`);
    resolvedStageId = s.id;
  }

  const lead = await leadsRepo.insert({
    companyId,
    contactId: contactId ?? null,
    stage: stageText,
    stageId: resolvedStageId,
    teamId: teamId ?? null,
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
    organizationId: organizationId ?? null,
    source: source ?? null,
    createdById: user.id,
  });
  await emitSystemActivity(lead, user.id, "created", "Lead created", { stage: stageText });
  return { conflict: false, lead: await enrichLead(lead, false) };
}

export async function getPipeline(user: AuthUser) {
  const companyId = user.companyId;
  const allLeads = await leadsRepo.pipelineLeads(user);
  const enriched = await enrichLeads(allLeads);

  // The pipeline honours the tenant's CONFIGURED stages (custom stages never
  // disappear), in sortOrder; default tenants keep the exact legacy six. Any
  // orphan stage key still present on leads is appended so no lead is hidden.
  let configured: Array<{ key: string; isWon: boolean; isLost: boolean }> = [];
  if (companyId) {
    await ensureStages(companyId);
    configured = (await pipelineRepo.listForCompany(user)).map((s) => ({ key: s.key, isWon: s.isWon, isLost: s.isLost }));
  }
  const flagsByKey = new Map(configured.map((s) => [s.key, s]));
  const stageKeys = configured.length > 0 ? configured.map((s) => s.key) : [...PIPELINE_STAGES];
  for (const l of enriched) {
    if (l.stage && !stageKeys.includes(l.stage)) stageKeys.push(l.stage);
  }

  // Cross-currency aggregation: convert each lead's value to USD (the server
  // base) BEFORE summing — never add raw amounts across currencies. Per-lead
  // `value`/`currency` in the response stay in the lead's own currency.
  const usdValue = (l: { value: number | null; currency: string }) =>
    convertCurrency(l.value ?? 0, l.currency, "USD");

  const stages = stageKeys.map((stage) => {
    const stageLeads = enriched.filter(l => l.stage === stage);
    const value = stageLeads.reduce((sum, l) => sum + usdValue(l), 0);
    return { stage, leads: stageLeads, count: stageLeads.length, value };
  });

  // Open pipeline = every lead whose stage is not a configured terminal stage
  // (isWon/isLost), with the literal won/lost fallback for unconfigured keys.
  const totalValue = enriched
    .filter((l) => !stageOutcome(flagsByKey.get(l.stage) ?? null, l.stage).closed)
    .reduce((sum, l) => sum + usdValue(l), 0);
  return { stages, totalValue };
}

export async function getLead(user: AuthUser, id: number) {
  const lead = await leadsRepo.findById(user, id);
  if (!lead) throw new AppError(404, "Lead not found");
  return await enrichLead(lead, true);
}

export async function updateLead(user: AuthUser, id: number, input: LeadInput) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");

  const { stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId, stageId, teamId, organizationId, source } = input;
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (stageId != null && !(await refInCompany("pipelineStages", existing.companyId, stageId))) throw new AppError(400, "Invalid stageId");
  if (teamId != null && !(await refInCompany("teams", existing.companyId, teamId))) throw new AppError(400, "Invalid teamId");
  if (organizationId != null && !(await refInCompany("organizations", existing.companyId, organizationId))) throw new AppError(400, "Invalid organizationId");

  const updateData: Record<string, unknown> = {};
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
  if (teamId !== undefined) updateData.teamId = teamId;
  if (organizationId !== undefined) updateData.organizationId = organizationId;
  if (source !== undefined) updateData.source = source;

  // Stage sync: the configurable `stageId` and the legacy text `stage` are kept
  // consistent. A provided stageId wins and drives the text; a bare stage text
  // resolves back to its stageId. Either form MUST resolve to a live configured
  // stage for this company — unknown keys and soft-deleted stages are rejected
  // before anything is written. The resolved stage row is kept so lifecycle
  // decisions below use its configured isWon/isLost flags, not the key text.
  let newStageRow: StageOutcomeFlags | null = null;
  if (stageId !== undefined) {
    updateData.stageId = stageId;
    if (stageId != null) {
      const s = await leadsRepo.stageInfo(stageId);
      if (!s) throw new AppError(400, "Invalid stageId");
      updateData.stage = s.key;
      newStageRow = s;
    }
  } else if (stage !== undefined) {
    const s = await pipelineRepo.findByKey(existing.companyId, String(stage));
    if (!s) throw new AppError(400, `Unknown stage "${String(stage)}" — it must match a configured pipeline stage`);
    updateData.stage = stage;
    updateData.stageId = s.id;
    newStageRow = s;
  }

  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");

  const newStage = (updateData.stage as string | undefined) ?? existing.stage;
  const stageChanged = updateData.stage !== undefined && newStage !== existing.stage;
  const assigneeChanged = assignedToId !== undefined && assignedToId !== existing.assignedToId;

  // Reopen guard: moving a CLOSED lead back to an OPEN stage while the same
  // contact already has another open opportunity conflicts (one open
  // opportunity per contact — same rule as createLead). Rejected reopens leave
  // the closed lead, its history, and its activities completely untouched.
  let newOutcome = stageOutcome(newStageRow, String(newStage));
  if (stageChanged) {
    // Resolve the OLD stage like every other consumer: live stage by id first,
    // then live stage by key (legacy rows with a NULL/stale stageId), then the
    // literal won/lost fallback inside stageOutcome.
    let oldRow: StageOutcomeFlags | undefined = existing.stageId != null ? await leadsRepo.stageInfo(existing.stageId) : undefined;
    if (!oldRow) oldRow = await pipelineRepo.findByKey(existing.companyId, existing.stage);
    const oldOutcome = stageOutcome(oldRow ?? null, existing.stage);
    if (oldOutcome.closed && !newOutcome.closed && existing.contactId != null) {
      const openId = await leadsRepo.activeLeadIdForContact(existing.companyId, existing.contactId, id);
      if (openId !== undefined) return { conflict: true as const, existingId: openId };
    }
  }

  // Write history rows for tracked fields
  const trackedFields: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [];
  if (stageChanged) {
    trackedFields.push({ field: "stage", oldVal: existing.stage, newVal: String(newStage) });
  }
  if (value !== undefined) {
    const oldVal = existing.value ? String(parseFloat(existing.value)) : null;
    const newVal = value != null ? String(parseFloat(String(value))) : null;
    if (oldVal !== newVal) trackedFields.push({ field: "value", oldVal, newVal });
  }
  if (assigneeChanged) {
    trackedFields.push({ field: "assignedToId", oldVal: existing.assignedToId != null ? String(existing.assignedToId) : null, newVal: assignedToId != null ? String(assignedToId) : null });
  }

  const lead = await leadsRepo.updateWithHistory(
    id,
    updateData as Partial<leadsRepo.LeadRow>,
    trackedFields.map(f => ({ leadId: id, changedBy: user.id, fieldName: f.field, oldValue: f.oldVal, newValue: f.newVal })),
  );

  if (!lead) throw new AppError(404, "Lead not found");

  // Emit system lifecycle activities for stage moves (won/lost/generic) and
  // reassignment. Won/lost come from the CONFIGURED stage flags, so custom
  // terminal stages (e.g. "closed_success") emit the same lifecycle types.
  if (stageChanged) {
    const type = newOutcome.won ? "won" : newOutcome.lost ? "lost" : "stage_change";
    await emitSystemActivity(lead, user.id, type, `Stage changed to ${newStage}`, { from: existing.stage, to: newStage });
  }
  if (assigneeChanged) {
    await emitSystemActivity(lead, user.id, "assignment", "Owner changed", { from: existing.assignedToId, to: assignedToId ?? null });
  }

  return { conflict: false as const, lead: await enrichLead(lead, true) };
}

export async function deleteLead(user: AuthUser, id: number) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  await leadsRepo.softDelete(id);
  return { success: true, message: "Lead deleted" };
}

export const ASSIGN_STRATEGIES = ["manual", "round_robin", "load_balanced", "availability", "territory", "ai"] as const;
export type AssignStrategy = (typeof ASSIGN_STRATEGIES)[number];

export interface AssignLeadInput {
  assignedToId?: number | null;
  teamId?: number | null;
  strategy?: AssignStrategy;
}

// Build the assignedToId lead-history row for an owner change (or [] if unchanged).
function assignHistory(existing: leadsRepo.LeadRow, newAssigneeId: number | null, userId: number): HistoryInsert[] {
  if (newAssigneeId === existing.assignedToId) return [];
  return [{ leadId: existing.id, changedBy: userId, fieldName: "assignedToId", oldValue: existing.assignedToId != null ? String(existing.assignedToId) : null, newValue: newAssigneeId != null ? String(newAssigneeId) : null }];
}

// Resolve the lead's contact attributes (country/industry/etc.) against the
// tenant's territories (ordered by sortOrder). A territory matches when EVERY
// non-empty criteria dimension it declares includes the lead's value (OR within a
// dimension, AND across dimensions). Returns the first matching territory or null.
async function resolveTerritory(user: AuthUser, contactAttrs: { country?: string | null; industry?: string | null } | null): Promise<{ assignedToId: number | null; teamId: number | null; name: string } | null> {
  if (!contactAttrs) return null;
  const { rows } = await territoriesRepo.list(user);
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const country = norm(contactAttrs.country);
  const industry = norm(contactAttrs.industry);
  for (const t of rows) {
    let criteria: { countries?: string[]; regions?: string[]; industries?: string[]; cities?: string[] } = {};
    try { criteria = t.matchCriteria ? JSON.parse(t.matchCriteria) : {}; } catch { criteria = {}; }
    const dims: Array<{ values: string[]; test: boolean }> = [];
    if (Array.isArray(criteria.countries) && criteria.countries.length > 0) dims.push({ values: criteria.countries.map(norm), test: !!country && criteria.countries.map(norm).includes(country) });
    if (Array.isArray(criteria.industries) && criteria.industries.length > 0) dims.push({ values: criteria.industries.map(norm), test: !!industry && criteria.industries.map(norm).includes(industry) });
    // regions/cities have no matching contact attribute yet — a territory that
    // declares ONLY those dimensions can never match and is skipped.
    if (dims.length === 0) continue;
    if (dims.every((d) => d.test)) return { assignedToId: t.assignedToId ?? null, teamId: t.teamId ?? null, name: t.name };
  }
  return null;
}

// Resolve the owner id for a rule-based strategy (everything except manual +
// round_robin, which are handled inline in assignLead). Returns the chosen id and
// the team the lead should be bound to, plus a human-readable reason.
async function resolveStrategyAssignee(
  user: AuthUser,
  existing: leadsRepo.LeadRow,
  strategy: AssignStrategy,
  teamId: number | null,
): Promise<{ assigneeId: number; teamId: number | null; reason: string }> {
  const companyId = existing.companyId;
  if (strategy === "load_balanced" || strategy === "availability") {
    if (teamId == null) throw new AppError(400, "A team is required for this assignment strategy");
    const assigneeId = strategy === "availability"
      ? await leadsRepo.availableLeastLoadedMember(companyId, teamId)
      : await leadsRepo.leastLoadedTeamMember(companyId, teamId);
    if (!assigneeId) throw new AppError(400, strategy === "availability" ? "No available team members" : "No active team members available");
    return { assigneeId, teamId, reason: strategy === "availability" ? "Assigned to least-loaded available member" : "Assigned to least-loaded team member" };
  }
  if (strategy === "territory") {
    const contactAttrs = existing.contactId ? await leadsRepo.contactForAssignment(existing.contactId) : null;
    const match = await resolveTerritory(user, contactAttrs);
    if (!match) throw new AppError(400, "No matching territory for this lead");
    let assigneeId = match.assignedToId ?? null;
    const targetTeam = match.teamId ?? teamId;
    if (assigneeId == null) {
      if (targetTeam == null) throw new AppError(400, "Matching territory has no owner or team");
      assigneeId = (await leadsRepo.leastLoadedTeamMember(companyId, targetTeam)) ?? null;
      if (assigneeId == null) throw new AppError(400, "Matching territory's team has no active members");
    }
    return { assigneeId, teamId: targetTeam, reason: `Territory match: ${match.name}` };
  }
  // ai
  const candidates = await leadsRepo.assignmentCandidates(companyId, teamId);
  if (candidates.length === 0) throw new AppError(400, "No candidate members for AI recommendation");
  const contact = existing.contactId ? await leadsRepo.contactForAssignment(existing.contactId) : null;
  let assigneeId = candidates.reduce((best, c) => (c.openLeads < best.openLeads ? c : best), candidates[0]).id;
  let reason = "Assigned to least-loaded member";
  try {
    const rec = await aiRecommendAssignee(
      {
        contactName: contact?.fullName ?? [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ?? null,
        contactCompany: contact?.contactCompany ?? existing.companyName ?? null,
        jobTitle: contact?.jobTitle ?? null,
        industry: contact?.industry ?? null,
        country: contact?.country ?? null,
        value: existing.value ? parseFloat(existing.value) : null,
        notes: existing.notes ?? null,
      },
      candidates,
      { companyId, userId: user.id },
    );
    if (candidates.some((c) => c.id === rec.userId)) {
      assigneeId = rec.userId;
      reason = rec.reasoning || "AI-recommended owner";
    }
  } catch (err) {
    logAiError("assignee-recommendation", err);
  }
  return { assigneeId, teamId, reason };
}

export async function assignLead(user: AuthUser, id: number, input: AssignLeadInput) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  const strategy: AssignStrategy = input.strategy ?? "manual";

  // Validate an explicitly-provided team once, up front (used by every strategy).
  if (input.teamId != null && !(await refInCompany("teams", existing.companyId, input.teamId))) throw new AppError(400, "Invalid teamId");

  // ── Manual: caller supplies the exact owner/team.
  if (strategy === "manual") {
    const { assignedToId, teamId } = input;
    if (assignedToId != null && !(await refInCompany("users", existing.companyId, assignedToId))) throw new AppError(400, "Invalid assignedToId");
    const updateData: Record<string, unknown> = {};
    if (assignedToId !== undefined) updateData.assignedToId = assignedToId;
    if (teamId !== undefined) updateData.teamId = teamId;
    if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");
    const historyRows = assignedToId !== undefined ? assignHistory(existing, assignedToId ?? null, user.id) : [];
    const lead = await leadsRepo.updateWithHistory(id, updateData as Partial<leadsRepo.LeadRow>, historyRows);
    if (!lead) throw new AppError(404, "Lead not found");
    if (historyRows.length > 0) await emitSystemActivity(lead, user.id, "assignment", "Owner assigned", { from: existing.assignedToId, to: assignedToId ?? null });
    return await enrichLead(lead, true);
  }

  const teamId = input.teamId ?? existing.teamId ?? null;

  // ── Round-robin: race-safe, atomic in a single locked transaction.
  if (strategy === "round_robin") {
    if (teamId == null) throw new AppError(400, "A team is required for round-robin assignment");
    const result = await leadsRepo.assignByRoundRobin(existing.companyId, teamId, id, (assigneeId) => assignHistory(existing, assigneeId, user.id));
    if (!result) throw new AppError(400, "No active team members available for round-robin");
    if (result.assigneeId !== existing.assignedToId) {
      await emitSystemActivity(result.lead, user.id, "assignment", "Round-robin assigned", { from: existing.assignedToId, to: result.assigneeId });
    }
    return await enrichLead(result.lead, true);
  }

  // ── Load-balanced / availability / territory / AI.
  const { assigneeId, teamId: resolvedTeamId, reason } = await resolveStrategyAssignee(user, existing, strategy, teamId);
  const updateData: Record<string, unknown> = { assignedToId: assigneeId };
  if (resolvedTeamId !== existing.teamId) updateData.teamId = resolvedTeamId;
  const historyRows = assignHistory(existing, assigneeId, user.id);
  const lead = await leadsRepo.updateWithHistory(id, updateData as Partial<leadsRepo.LeadRow>, historyRows);
  if (!lead) throw new AppError(404, "Lead not found");
  if (historyRows.length > 0) await emitSystemActivity(lead, user.id, "assignment", reason, { from: existing.assignedToId, to: assigneeId, strategy });
  return await enrichLead(lead, true);
}

// Legacy endpoint: least-loaded auto-assign within the lead's existing team.
export async function autoAssignLead(user: AuthUser, id: number) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  if (!existing.teamId) throw new AppError(400, "Assign the lead to a team before auto-assigning");
  return assignLead(user, id, { strategy: "load_balanced", teamId: existing.teamId });
}

export interface BulkAssignInput {
  leadIds?: number[];
  strategy?: AssignStrategy;
  assignedToId?: number | null;
  teamId?: number | null;
}

// Bulk assignment: apply the chosen strategy to many leads. Each lead is assigned
// independently (so round-robin still rotates and per-lead failures don't abort
// the batch); the response reports per-lead success/failure.
export async function bulkAssign(user: AuthUser, input: BulkAssignInput) {
  const ids = [...new Set(input.leadIds ?? [])].filter((n) => Number.isInteger(n));
  if (ids.length === 0) throw new AppError(400, "leadIds must be a non-empty array");
  if (ids.length > 200) throw new AppError(400, "Cannot assign more than 200 leads at once");
  const strategy: AssignStrategy = input.strategy ?? "manual";

  const results: Array<{ leadId: number; success: boolean; assignedToId: number | null; error: string | null }> = [];
  for (const leadId of ids) {
    try {
      const lead = await assignLead(user, leadId, { strategy, assignedToId: input.assignedToId, teamId: input.teamId });
      results.push({ leadId, success: true, assignedToId: lead.assignedToId ?? null, error: null });
    } catch (err) {
      results.push({ leadId, success: false, assignedToId: null, error: err instanceof AppError ? err.message : "Assignment failed" });
    }
  }
  const assigned = results.filter((r) => r.success).length;
  return { results, assigned, failed: results.length - assigned };
}

// AI assignment recommendation PREVIEW (does not mutate the lead). Returns the
// recommended owner + reasoning + the candidate load list so the UI can show why.
export async function recommendAssignee(user: AuthUser, id: number, input: { teamId?: number | null }) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  const teamId = input.teamId ?? existing.teamId ?? null;
  if (teamId != null && !(await refInCompany("teams", existing.companyId, teamId))) throw new AppError(400, "Invalid teamId");
  const candidates = await leadsRepo.assignmentCandidates(existing.companyId, teamId);
  if (candidates.length === 0) throw new AppError(400, "No candidate members for AI recommendation");
  const contact = existing.contactId ? await leadsRepo.contactForAssignment(existing.contactId) : null;
  let chosen = candidates.reduce((best, c) => (c.openLeads < best.openLeads ? c : best), candidates[0]);
  let reasoning = "Least-loaded member";
  try {
    const rec = await aiRecommendAssignee(
      {
        contactName: contact?.fullName ?? [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ?? null,
        contactCompany: contact?.contactCompany ?? existing.companyName ?? null,
        jobTitle: contact?.jobTitle ?? null,
        industry: contact?.industry ?? null,
        country: contact?.country ?? null,
        value: existing.value ? parseFloat(existing.value) : null,
        notes: existing.notes ?? null,
      },
      candidates,
      { companyId: existing.companyId, userId: user.id, entityType: "lead", entityId: existing.id },
    );
    const match = candidates.find((c) => c.id === rec.userId);
    if (match) { chosen = match; reasoning = rec.reasoning || "AI-recommended owner"; }
  } catch (err) {
    logAiError("assignee-recommendation", err);
  }
  return {
    assignedToId: chosen.id,
    assignedToName: chosen.name,
    reasoning,
    candidates: candidates.map((c) => ({ id: c.id, name: c.name, jobTitle: c.jobTitle, openLeads: c.openLeads })),
  };
}

// ── Lead tags
export async function listLeadTags(user: AuthUser, leadId: number) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  return { tags: fmtTags(await tagsRepo.tagsForLead(leadId)) };
}

export async function attachLeadTag(user: AuthUser, leadId: number, input: { tagId?: number }) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  const tagId = input.tagId;
  if (tagId == null) throw new AppError(400, "tagId required");
  const tag = await tagsRepo.findById(user, tagId);
  if (!tag) throw new AppError(400, "Invalid tagId");
  await tagsRepo.attach(lead.companyId, leadId, tagId);
  return { tags: fmtTags(await tagsRepo.tagsForLead(leadId)) };
}

export async function detachLeadTag(user: AuthUser, leadId: number, tagId: number) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  await tagsRepo.detach(leadId, tagId);
  return { tags: fmtTags(await tagsRepo.tagsForLead(leadId)) };
}

// ── Custom-field values (delegates validation/persistence to custom_fields service) ──

export async function getLeadCustomFields(user: AuthUser, id: number) {
  const lead = await leadsRepo.findById(user, id);
  if (!lead) throw new AppError(404, "Lead not found");
  return customFields.getValues(user, "lead", lead.companyId, id);
}

export async function setLeadCustomFields(user: AuthUser, id: number, body: { values?: Array<{ definitionId?: unknown; value?: unknown }> }) {
  const lead = await leadsRepo.findById(user, id);
  if (!lead) throw new AppError(404, "Lead not found");
  return customFields.setValues(user, "lead", lead.companyId, id, body);
}
