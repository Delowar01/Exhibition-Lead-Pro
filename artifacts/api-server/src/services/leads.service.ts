import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible, refInCompany } from "../lib/tenant.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as pipelineRepo from "../repositories/pipeline_stages.repository.js";
import * as tagsRepo from "../repositories/tags.repository.js";
import * as activitiesRepo from "../repositories/lead_activities.repository.js";
import { ensureStages } from "./pipeline.service.js";
import { parseListQuery } from "../lib/list-query.js";
import { convertCurrency } from "../lib/currency.js";

const PIPELINE_STAGES = ["prospect", "qualified", "proposal_sent", "negotiation", "won", "lost"];

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
  opts?: { stage?: StageLite | null; teamName?: string | null; tags?: TagLite[]; history?: LeadHistoryItem[] },
) {
  return {
    ...l,
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
    history: includeHistory ? history : undefined,
  });
}

// Batched enrichment for list/pipeline: a fixed number of lookups (contacts +
// users + events + stages + teams + tags) instead of per row. Never includes
// history (list views don't need it), matching enrichLead(l, false) exactly.
async function enrichLeads(rows: leadsRepo.LeadRow[]) {
  const contactIds = [...new Set(rows.map((l) => l.contactId).filter((v): v is number => v != null))];
  const userIds = [...new Set(rows.map((l) => l.assignedToId).filter((v): v is number => v != null))];
  const eventIds = [...new Set(rows.map((l) => l.eventId).filter((v): v is number => v != null))];
  const stageIds = [...new Set(rows.map((l) => l.stageId).filter((v): v is number => v != null))];
  const teamIds = [...new Set(rows.map((l) => l.teamId).filter((v): v is number => v != null))];
  const leadIds = rows.map((l) => l.id);
  const [contacts, users, events, stages, teams, tagMap] = await Promise.all([
    leadsRepo.contactSummariesByIds(contactIds),
    leadsRepo.userNamesByIds(userIds),
    leadsRepo.eventNamesByIds(eventIds),
    leadsRepo.stageInfosByIds(stageIds),
    leadsRepo.teamNamesByIds(teamIds),
    tagsRepo.tagsForLeads(leadIds),
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
}

export type CreateLeadResult =
  | { conflict: true; existingId: number }
  | { conflict: false; lead: Awaited<ReturnType<typeof enrichLead>> };

export async function createLead(user: AuthUser, input: LeadInput): Promise<CreateLeadResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { contactId, stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId, stageId, teamId } = input;

  if (contactId != null && !(await refAccessible(user, "contacts", contactId))) throw new AppError(400, "Invalid contactId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (stageId != null && !(await refInCompany("pipelineStages", companyId, stageId))) throw new AppError(400, "Invalid stageId");
  if (teamId != null && !(await refInCompany("teams", companyId, teamId))) throw new AppError(400, "Invalid teamId");

  // 409 if this contact already has a non-lost lead in this company
  if (contactId != null) {
    const existingId = await leadsRepo.activeLeadIdForContact(companyId, contactId);
    if (existingId !== undefined) {
      return { conflict: true, existingId };
    }
  }

  // Keep the legacy text `stage` and the configurable `stageId` consistent: a
  // provided stageId wins and drives the text; otherwise resolve stageId from
  // the stage key. Seed defaults first so key resolution succeeds.
  await ensureStages(companyId);
  let stageText = stage ?? "prospect";
  let resolvedStageId = stageId ?? null;
  if (stageId != null) {
    const s = await leadsRepo.stageInfo(stageId);
    if (s) stageText = s.key;
  } else {
    const s = await pipelineRepo.findByKey(companyId, stageText);
    resolvedStageId = s?.id ?? null;
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
    createdById: user.id,
  });
  await emitSystemActivity(lead, user.id, "created", "Lead created", { stage: stageText });
  return { conflict: false, lead: await enrichLead(lead, false) };
}

export async function getPipeline(user: AuthUser) {
  const allLeads = await leadsRepo.pipelineLeads(user);
  const enriched = await enrichLeads(allLeads);

  // Cross-currency aggregation: convert each lead's value to USD (the server
  // base) BEFORE summing — never add raw amounts across currencies. Per-lead
  // `value`/`currency` in the response stay in the lead's own currency.
  const usdValue = (l: { value: number | null; currency: string }) =>
    convertCurrency(l.value ?? 0, l.currency, "USD");

  const stages = PIPELINE_STAGES.map((stage) => {
    const stageLeads = enriched.filter(l => l.stage === stage);
    const value = stageLeads.reduce((sum, l) => sum + usdValue(l), 0);
    return { stage, leads: stageLeads, count: stageLeads.length, value };
  });

  const totalValue = enriched
    .filter(l => l.stage !== "won" && l.stage !== "lost")
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

  const { stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId, stageId, teamId } = input;
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (stageId != null && !(await refInCompany("pipelineStages", existing.companyId, stageId))) throw new AppError(400, "Invalid stageId");
  if (teamId != null && !(await refInCompany("teams", existing.companyId, teamId))) throw new AppError(400, "Invalid teamId");

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

  // Stage sync: the configurable `stageId` and the legacy text `stage` are kept
  // consistent. A provided stageId wins and drives the text; a bare stage text
  // resolves back to a stageId (or null when no matching stage is configured).
  if (stageId !== undefined) {
    updateData.stageId = stageId;
    if (stageId != null) {
      const s = await leadsRepo.stageInfo(stageId);
      if (s) updateData.stage = s.key;
    }
  } else if (stage !== undefined) {
    updateData.stage = stage;
    const s = await pipelineRepo.findByKey(existing.companyId, String(stage));
    updateData.stageId = s?.id ?? null;
  }

  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");

  const newStage = (updateData.stage as string | undefined) ?? existing.stage;
  const stageChanged = updateData.stage !== undefined && newStage !== existing.stage;
  const assigneeChanged = assignedToId !== undefined && assignedToId !== existing.assignedToId;

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

  // Emit system lifecycle activities for stage moves (won/lost/generic) and reassignment.
  if (stageChanged) {
    const type = newStage === "won" ? "won" : newStage === "lost" ? "lost" : "stage_change";
    await emitSystemActivity(lead, user.id, type, `Stage changed to ${newStage}`, { from: existing.stage, to: newStage });
  }
  if (assigneeChanged) {
    await emitSystemActivity(lead, user.id, "assignment", "Owner changed", { from: existing.assignedToId, to: assignedToId ?? null });
  }

  return await enrichLead(lead, true);
}

export async function deleteLead(user: AuthUser, id: number) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  await leadsRepo.softDelete(id);
  return { success: true, message: "Lead deleted" };
}

export interface AssignLeadInput {
  assignedToId?: number | null;
  teamId?: number | null;
}

export async function assignLead(user: AuthUser, id: number, input: AssignLeadInput) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  const { assignedToId, teamId } = input;
  if (assignedToId != null && !(await refInCompany("users", existing.companyId, assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (teamId != null && !(await refInCompany("teams", existing.companyId, teamId))) throw new AppError(400, "Invalid teamId");

  const updateData: Record<string, unknown> = {};
  if (assignedToId !== undefined) updateData.assignedToId = assignedToId;
  if (teamId !== undefined) updateData.teamId = teamId;
  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");

  const assigneeChanged = assignedToId !== undefined && assignedToId !== existing.assignedToId;
  const historyRows: HistoryInsert[] = [];
  if (assigneeChanged) {
    historyRows.push({ leadId: id, changedBy: user.id, fieldName: "assignedToId", oldValue: existing.assignedToId != null ? String(existing.assignedToId) : null, newValue: assignedToId != null ? String(assignedToId) : null });
  }

  const lead = await leadsRepo.updateWithHistory(id, updateData as Partial<leadsRepo.LeadRow>, historyRows);
  if (!lead) throw new AppError(404, "Lead not found");
  if (assigneeChanged) {
    await emitSystemActivity(lead, user.id, "assignment", "Owner assigned", { from: existing.assignedToId, to: assignedToId ?? null });
  }
  return await enrichLead(lead, true);
}

export async function autoAssignLead(user: AuthUser, id: number) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  if (!existing.teamId) throw new AppError(400, "Assign the lead to a team before auto-assigning");
  const assigneeId = await leadsRepo.leastLoadedTeamMember(existing.companyId, existing.teamId);
  if (!assigneeId) throw new AppError(400, "No active team members available for auto-assignment");

  const assigneeChanged = assigneeId !== existing.assignedToId;
  const historyRows: HistoryInsert[] = [];
  if (assigneeChanged) {
    historyRows.push({ leadId: id, changedBy: user.id, fieldName: "assignedToId", oldValue: existing.assignedToId != null ? String(existing.assignedToId) : null, newValue: String(assigneeId) });
  }

  const lead = await leadsRepo.updateWithHistory(id, { assignedToId: assigneeId } as Partial<leadsRepo.LeadRow>, historyRows);
  if (!lead) throw new AppError(404, "Lead not found");
  if (assigneeChanged) {
    await emitSystemActivity(lead, user.id, "assignment", "Auto-assigned to least-loaded team member", { from: existing.assignedToId, to: assigneeId });
  }
  return await enrichLead(lead, true);
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
