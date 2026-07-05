import { db } from "@workspace/db";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/lead_notes.repository.js";
import * as historyRepo from "../repositories/lead_note_history.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import { createNotification } from "./notifications.service.js";
import { extractMentionIds, normalizeBody, toPlainText } from "../lib/richtext.js";
import { logger } from "../lib/logger.js";

export function formatNote(n: repo.LeadNoteWithUser) {
  return {
    id: n.id,
    companyId: n.companyId,
    leadId: n.leadId,
    contactId: n.contactId ?? null,
    userId: n.userId ?? null,
    userName: n.userName ?? null,
    body: n.body,
    mentions: n.mentions ?? [],
    isPinned: n.isPinned,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt ? n.updatedAt.toISOString() : null,
  };
}

function formatHistory(h: historyRepo.LeadNoteHistoryWithUser) {
  return {
    id: h.id,
    noteId: h.noteId,
    body: h.body,
    mentions: h.mentions ?? [],
    editedById: h.editedById ?? null,
    editedByName: h.editedByName ?? null,
    createdAt: h.createdAt.toISOString(),
  };
}

// Resolve the authoritative set of mentioned users for a body: parse mention
// tokens, then keep only ids that are active members of THIS note's tenant.
// Mentions can never cross the tenant boundary.
async function resolveMentions(companyId: number, body: string): Promise<number[]> {
  const requested = extractMentionIds(body);
  if (requested.length === 0) return [];
  return usersRepo.activeIdsInCompany(companyId, requested);
}

// Best-effort mention notifications. Fired for the delta set only (so an edit
// that keeps existing mentions does not re-notify). Never notifies the actor.
export async function notifyMentions(
  actor: AuthUser,
  opts: { companyId: number; leadId: number; mentionIds: number[]; body: string; context: "note" | "comment" },
): Promise<void> {
  const recipients = opts.mentionIds.filter((id) => id !== actor.id);
  if (recipients.length === 0) return;
  const preview = toPlainText(opts.body).slice(0, 140);
  const title = opts.context === "comment" ? `${actor.name} mentioned you in a comment` : `${actor.name} mentioned you in a note`;
  for (const userId of recipients) {
    try {
      await createNotification({
        userId,
        companyId: opts.companyId,
        category: "mentions",
        title,
        body: preview || null,
        link: `/admin/leads/${opts.leadId}`,
        metadata: { leadId: opts.leadId, actorId: actor.id, context: opts.context },
      });
    } catch (err) {
      logger.error({ err, userId }, "Failed to send mention notification");
    }
  }
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
  const body = normalizeBody(input.body);
  if (!body) throw new AppError(400, "body required");
  const mentions = await resolveMentions(lead.companyId, body);
  const row = await repo.insert({
    companyId: lead.companyId,
    leadId,
    contactId: lead.contactId ?? null,
    userId: user.id,
    body,
    mentions,
    isPinned: input.isPinned ?? false,
  });
  const full = await repo.getByIdWithUser(row.id);
  await notifyMentions(user, { companyId: lead.companyId, leadId, mentionIds: mentions, body, context: "note" });
  return formatNote(full!);
}

export async function updateNote(user: AuthUser, id: number, input: NoteInput) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Note not found");
  const data: Record<string, unknown> = {};
  let newMentions: number[] | null = null;
  let bodyChanged = false;
  if (input.body !== undefined) {
    const body = normalizeBody(input.body);
    if (!body) throw new AppError(400, "body cannot be empty");
    if (body !== existing.body) {
      bodyChanged = true;
      data.body = body;
      newMentions = await resolveMentions(existing.companyId, body);
      data.mentions = newMentions;
    }
  }
  if (input.isPinned !== undefined) data.isPinned = input.isPinned;
  if (Object.keys(data).length === 0) throw new AppError(400, "No valid fields to update");

  // Append the PRIOR body to the append-only history in the same transaction as
  // the update, so a revision is never lost on edit.
  if (bodyChanged) {
    await db.transaction(async (tx) => {
      await historyRepo.insert(
        {
          companyId: existing.companyId,
          noteId: id,
          body: existing.body,
          mentions: existing.mentions ?? [],
          editedById: user.id,
        },
        tx,
      );
      await repo.updateRow(id, data, tx);
    });
  } else {
    await repo.updateRow(id, data);
  }

  const full = await repo.getByIdWithUser(id);
  if (bodyChanged && newMentions) {
    const added = newMentions.filter((mid) => !(existing.mentions ?? []).includes(mid));
    await notifyMentions(user, { companyId: existing.companyId, leadId: existing.leadId, mentionIds: added, body: full!.body, context: "note" });
  }
  return formatNote(full!);
}

export async function deleteNote(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Note not found");
  await repo.softDelete(id);
  return { success: true, message: "Note deleted" };
}

export async function listHistory(user: AuthUser, noteId: number) {
  const note = await repo.findById(user, noteId);
  if (!note) throw new AppError(404, "Note not found");
  return { history: (await historyRepo.listForNote(noteId)).map(formatHistory) };
}
