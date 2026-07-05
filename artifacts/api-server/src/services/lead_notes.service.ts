import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/lead_notes.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";

export function formatNote(n: repo.LeadNoteWithUser) {
  return {
    id: n.id,
    companyId: n.companyId,
    leadId: n.leadId,
    contactId: n.contactId ?? null,
    userId: n.userId ?? null,
    userName: n.userName ?? null,
    body: n.body,
    isPinned: n.isPinned,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt ? n.updatedAt.toISOString() : null,
  };
}

export async function listNotes(user: AuthUser, leadId: number) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  return { notes: (await repo.listForLead(user, leadId)).map(formatNote) };
}

interface NoteInput {
  body?: string;
  isPinned?: boolean;
}

export async function createNote(user: AuthUser, leadId: number, input: NoteInput) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  const body = (input.body ?? "").trim();
  if (!body) throw new AppError(400, "body required");
  const row = await repo.insert({
    companyId: lead.companyId,
    leadId,
    contactId: lead.contactId ?? null,
    userId: user.id,
    body,
    isPinned: input.isPinned ?? false,
  });
  const full = await repo.getByIdWithUser(row.id);
  return formatNote(full!);
}

export async function updateNote(user: AuthUser, id: number, input: NoteInput) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Note not found");
  const data: Record<string, unknown> = {};
  if (input.body !== undefined) {
    const body = String(input.body).trim();
    if (!body) throw new AppError(400, "body cannot be empty");
    data.body = body;
  }
  if (input.isPinned !== undefined) data.isPinned = input.isPinned;
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");
  await repo.updateRow(id, data);
  const full = await repo.getByIdWithUser(id);
  return formatNote(full!);
}

export async function deleteNote(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Note not found");
  await repo.softDelete(id);
  return { success: true, message: "Note deleted" };
}
