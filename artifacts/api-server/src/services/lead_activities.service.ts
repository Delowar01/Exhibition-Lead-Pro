import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/lead_activities.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";

export function formatActivity(a: repo.LeadActivityWithUser) {
  return {
    id: a.id,
    companyId: a.companyId,
    leadId: a.leadId ?? null,
    contactId: a.contactId ?? null,
    userId: a.userId ?? null,
    userName: a.userName ?? null,
    type: a.type,
    source: a.source,
    subject: a.subject ?? null,
    body: a.body ?? null,
    outcome: a.outcome ?? null,
    metadata: a.metadata ?? null,
    occurredAt: a.occurredAt.toISOString(),
    createdAt: a.createdAt.toISOString(),
  };
}

const MANUAL_TYPES = new Set(["call", "email", "meeting", "message", "other", "note"]);

export async function listActivities(user: AuthUser, leadId: number) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  return { activities: (await repo.listForLead(user, leadId)).map(formatActivity) };
}

interface ActivityInput {
  type?: string;
  subject?: string | null;
  body?: string | null;
  outcome?: string | null;
  occurredAt?: string | null;
}

export async function createActivity(user: AuthUser, leadId: number, input: ActivityInput) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  if (!input.type || !MANUAL_TYPES.has(input.type)) throw new AppError(400, "Invalid activity type");
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (isNaN(occurredAt.getTime())) throw new AppError(400, "Invalid occurredAt");
  const row = await repo.insert({
    companyId: lead.companyId,
    leadId,
    contactId: lead.contactId ?? null,
    userId: user.id,
    type: input.type,
    source: "manual",
    subject: input.subject ?? null,
    body: input.body ?? null,
    outcome: input.outcome ?? null,
    occurredAt,
  });
  const full = await repo.getByIdWithUser(row.id);
  return formatActivity(full!);
}

export async function updateActivity(user: AuthUser, id: number, input: ActivityInput) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Activity not found");
  if (existing.source === "system") throw new AppError(403, "System activities cannot be edited");
  const data: Record<string, unknown> = {};
  if (input.type !== undefined) {
    if (!MANUAL_TYPES.has(input.type)) throw new AppError(400, "Invalid activity type");
    data.type = input.type;
  }
  if (input.subject !== undefined) data.subject = input.subject;
  if (input.body !== undefined) data.body = input.body;
  if (input.outcome !== undefined) data.outcome = input.outcome;
  if (input.occurredAt !== undefined) {
    if (input.occurredAt === null) throw new AppError(400, "occurredAt cannot be null");
    const d = new Date(input.occurredAt);
    if (isNaN(d.getTime())) throw new AppError(400, "Invalid occurredAt");
    data.occurredAt = d;
  }
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  await repo.updateRow(id, data);
  const full = await repo.getByIdWithUser(id);
  return formatActivity(full!);
}

export async function deleteActivity(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Activity not found");
  if (existing.source === "system") throw new AppError(403, "System activities cannot be deleted");
  await repo.softDelete(id);
  return { success: true, message: "Activity deleted" };
}
