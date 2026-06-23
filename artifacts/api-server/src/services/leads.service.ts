import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible } from "../lib/tenant.js";
import * as leadsRepo from "../repositories/leads.repository.js";

const PIPELINE_STAGES = ["prospect", "qualified", "proposal_sent", "negotiation", "won", "lost"];

async function enrichLead(l: leadsRepo.LeadRow, includeHistory = false) {
  const contact = l.contactId ? await leadsRepo.contactSummary(l.contactId) : null;
  const assignee = l.assignedToId ? await leadsRepo.assigneeName(l.assignedToId) : null;
  const event = l.eventId ? await leadsRepo.eventName(l.eventId) : null;

  let history: Array<{ id: number; leadId: number; changedBy: number | null; changedByName: string | null; fieldName: string; oldValue: string | null; newValue: string | null; changedAt: string }> = [];
  if (includeHistory) {
    const rows = await leadsRepo.history(l.id);
    history = rows.map(r => ({ ...r, changedAt: r.changedAt.toISOString() }));
  }

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
    assignedToName: assignee?.name ?? null,
    eventName: event?.name ?? null,
    history: includeHistory ? history : undefined,
  };
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
  const { stage, assignedTo, eventId, contactId, page = "1", limit = "100" } = params;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(500, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const { rows, total } = await leadsRepo.list(user, {
    stage,
    assignedToId: assignedTo && !isNaN(parseInt(assignedTo)) ? parseInt(assignedTo) : undefined,
    eventId: eventId && !isNaN(parseInt(eventId)) ? parseInt(eventId) : undefined,
    contactId: contactId && !isNaN(parseInt(contactId)) ? parseInt(contactId) : undefined,
    limit: limitNum,
    offset,
  });
  const enriched = await Promise.all(rows.map(l => enrichLead(l, false)));
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
}

export type CreateLeadResult =
  | { conflict: true; existingId: number }
  | { conflict: false; lead: Awaited<ReturnType<typeof enrichLead>> };

export async function createLead(user: AuthUser, input: LeadInput): Promise<CreateLeadResult> {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { contactId, stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId } = input;

  if (contactId != null && !(await refAccessible(user, "contacts", contactId))) throw new AppError(400, "Invalid contactId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");

  // 409 if this contact already has a non-lost lead in this company
  if (contactId != null) {
    const existingId = await leadsRepo.activeLeadIdForContact(companyId, contactId);
    if (existingId !== undefined) {
      return { conflict: true, existingId };
    }
  }

  const lead = await leadsRepo.insert({
    companyId,
    contactId: contactId ?? null,
    stage: stage ?? "prospect",
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
  return { conflict: false, lead: await enrichLead(lead, false) };
}

export async function getPipeline(user: AuthUser) {
  const allLeads = await leadsRepo.pipelineLeads(user);
  const enriched = await Promise.all(allLeads.map(l => enrichLead(l, false)));

  const stages = await Promise.all(PIPELINE_STAGES.map(async (stage) => {
    const stageLeads = enriched.filter(l => l.stage === stage);
    const value = stageLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
    return { stage, leads: stageLeads, count: stageLeads.length, value };
  }));

  const totalValue = enriched
    .filter(l => l.stage !== "won" && l.stage !== "lost")
    .reduce((sum, l) => sum + (l.value ?? 0), 0);
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

  const { stage, title, value, currency, closingDate, probability, priority, notes, companyName, assignedToId, eventId } = input;
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");

  const updateData: Record<string, unknown> = {};
  if (stage !== undefined) updateData.stage = stage;
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

  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");

  // Write history rows for tracked fields
  const trackedFields: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [];
  if (stage !== undefined && stage !== existing.stage) {
    trackedFields.push({ field: "stage", oldVal: existing.stage, newVal: String(stage) });
  }
  if (value !== undefined) {
    const oldVal = existing.value ? String(parseFloat(existing.value)) : null;
    const newVal = value != null ? String(parseFloat(String(value))) : null;
    if (oldVal !== newVal) trackedFields.push({ field: "value", oldVal, newVal });
  }
  if (assignedToId !== undefined && assignedToId !== existing.assignedToId) {
    trackedFields.push({ field: "assignedToId", oldVal: existing.assignedToId != null ? String(existing.assignedToId) : null, newVal: assignedToId != null ? String(assignedToId) : null });
  }

  const lead = await leadsRepo.updateWithHistory(
    id,
    updateData as Partial<leadsRepo.LeadRow>,
    trackedFields.map(f => ({ leadId: id, changedBy: user.id, fieldName: f.field, oldValue: f.oldVal, newValue: f.newVal })),
  );

  if (!lead) throw new AppError(404, "Lead not found");
  return await enrichLead(lead, true);
}

export async function deleteLead(user: AuthUser, id: number) {
  const existing = await leadsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Lead not found");
  await leadsRepo.softDelete(id);
  return { success: true, message: "Lead deleted" };
}
