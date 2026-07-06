import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as activitiesRepo from "../repositories/lead_activities.repository.js";
import * as notesRepo from "../repositories/lead_notes.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as contactsRepo from "../repositories/contacts.repository.js";

interface TimelineEntry {
  id: string;
  kind: string;
  type: string | null;
  source: string | null;
  title: string | null;
  body: string | null;
  actorId: number | null;
  actorName: string | null;
  leadId: number | null;
  contactId: number | null;
  metadata: unknown;
  occurredAt: string;
}

function activityEntry(a: activitiesRepo.LeadActivityWithUser): TimelineEntry {
  return {
    id: `activity:${a.id}`,
    kind: "activity",
    type: a.type,
    source: a.source,
    title: a.subject ?? null,
    body: a.body ?? null,
    actorId: a.userId ?? null,
    actorName: a.userName ?? null,
    leadId: a.leadId ?? null,
    contactId: a.contactId ?? null,
    metadata: a.metadata ?? null,
    occurredAt: a.occurredAt.toISOString(),
  };
}

function noteEntry(n: notesRepo.LeadNoteWithUser): TimelineEntry {
  return {
    id: `note:${n.id}`,
    kind: "note",
    type: n.isPinned ? "pinned" : "note",
    source: "manual",
    title: null,
    body: n.body,
    actorId: n.userId ?? null,
    actorName: n.userName ?? null,
    leadId: n.leadId,
    contactId: n.contactId ?? null,
    metadata: null,
    occurredAt: n.createdAt.toISOString(),
  };
}

function merge(entries: TimelineEntry[]): { entries: TimelineEntry[] } {
  entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return { entries };
}

export async function leadTimeline(user: AuthUser, leadId: number) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  const [acts, notes] = await Promise.all([activitiesRepo.listForLead(user, leadId), notesRepo.listForLead(user, leadId)]);
  return merge([...acts.map(activityEntry), ...notes.map(noteEntry)]);
}

export async function contactTimeline(user: AuthUser, contactId: number) {
  const contact = await contactsRepo.findById(user, contactId);
  if (!contact) throw new AppError(404, "Contact not found");
  const [acts, notes] = await Promise.all([activitiesRepo.listForContact(user, contactId), notesRepo.listForContact(user, contactId)]);
  return merge([...acts.map(activityEntry), ...notes.map(noteEntry)]);
}

// Merged activity + note timeline across ALL of an organization's linked leads and
// contacts (Company Detail aggregate). Callers resolve the org + its id sets first.
export async function organizationTimeline(user: AuthUser, leadIds: number[], contactIds: number[]) {
  const [acts, notes] = await Promise.all([
    activitiesRepo.listForOrg(user, leadIds, contactIds),
    notesRepo.listForOrg(user, leadIds, contactIds),
  ]);
  return merge([...acts.map(activityEntry), ...notes.map(noteEntry)]);
}
