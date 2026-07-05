import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/lead_note_comments.repository.js";
import * as notesRepo from "../repositories/lead_notes.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import { extractMentionIds, normalizeBody } from "../lib/richtext.js";
import { notifyMentions } from "./lead_notes.service.js";

function formatComment(c: repo.LeadNoteCommentWithUser) {
  return {
    id: c.id,
    companyId: c.companyId,
    noteId: c.noteId,
    userId: c.userId ?? null,
    userName: c.userName ?? null,
    body: c.body,
    mentions: c.mentions ?? [],
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt ? c.updatedAt.toISOString() : null,
  };
}

async function resolveMentions(companyId: number, body: string): Promise<number[]> {
  const requested = extractMentionIds(body);
  if (requested.length === 0) return [];
  return usersRepo.activeIdsInCompany(companyId, requested);
}

// Loads the parent note with tenant scope. 404s if the caller cannot see it.
async function requireNote(user: AuthUser, noteId: number) {
  const note = await notesRepo.findById(user, noteId);
  if (!note) throw new AppError(404, "Note not found");
  return note;
}

export async function listComments(user: AuthUser, noteId: number) {
  await requireNote(user, noteId);
  return { comments: (await repo.listForNote(user, noteId)).map(formatComment) };
}

export async function createComment(user: AuthUser, noteId: number, input: { body?: string }) {
  const note = await requireNote(user, noteId);
  const body = normalizeBody(input.body);
  if (!body) throw new AppError(400, "body required");
  const mentions = await resolveMentions(note.companyId, body);
  const row = await repo.insert({ companyId: note.companyId, noteId, userId: user.id, body, mentions });
  const full = await repo.getByIdWithUser(row.id);
  await notifyMentions(user, { companyId: note.companyId, leadId: note.leadId, mentionIds: mentions, body, context: "comment" });
  return formatComment(full!);
}

export async function updateComment(user: AuthUser, id: number, input: { body?: string }) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Comment not found");
  if (existing.userId !== user.id) throw new AppError(403, "You can only edit your own comments");
  const body = normalizeBody(input.body);
  if (!body) throw new AppError(400, "body cannot be empty");
  const mentions = await resolveMentions(existing.companyId, body);
  await repo.updateRow(id, { body, mentions });
  const full = await repo.getByIdWithUser(id);
  const note = await notesRepo.getByIdWithUser(existing.noteId);
  const added = mentions.filter((mid) => !(existing.mentions ?? []).includes(mid));
  if (note) await notifyMentions(user, { companyId: existing.companyId, leadId: note.leadId, mentionIds: added, body, context: "comment" });
  return formatComment(full!);
}

export async function deleteComment(user: AuthUser, id: number) {
  const existing = await repo.findById(user, id);
  if (!existing) throw new AppError(404, "Comment not found");
  if (existing.userId !== user.id) throw new AppError(403, "You can only delete your own comments");
  await repo.softDelete(id);
  return { success: true, message: "Comment deleted" };
}
