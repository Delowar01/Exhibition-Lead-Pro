import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible } from "../lib/tenant.js";
import { scoreLead, enrichContact as aiEnrichContact, logAiError } from "../lib/ai.js";
import { notifyUser } from "../lib/push.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import type { ContactRow } from "../repositories/contacts.repository.js";

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try { return JSON.parse(tags); } catch { return []; }
}

function formatContact(c: ContactRow, eventName?: string | null, assignedToName?: string | null) {
  return {
    ...c,
    fullName: c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
    tags: parseTags(c.tags),
    talkingPoints: parseTags(c.talkingPoints),
    eventName: eventName ?? null,
    assignedToName: assignedToName ?? null,
  };
}

async function namesFor(c: ContactRow) {
  const event = c.eventId ? await contactsRepo.eventName(c.eventId) : null;
  const assignee = c.assignedToId ? await contactsRepo.assigneeName(c.assignedToId) : null;
  return { eventName: event?.name, assignedToName: assignee?.name };
}

export interface ListContactsParams {
  search?: string;
  status?: string;
  temperature?: string;
  eventId?: string;
  assignedTo?: string;
  sort?: string;
  hasFollowUp?: string;
  hasMeeting?: string;
  dateFrom?: string;
  dateTo?: string;
  includeDuplicates?: string;
  page?: string;
  limit?: string;
}

export async function listContacts(user: AuthUser, params: ListContactsParams) {
  const { search, status, temperature, eventId, assignedTo, sort, hasFollowUp, hasMeeting, dateFrom, dateTo, includeDuplicates, page = "1", limit = "20" } = params;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(200, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const { rows, total } = await contactsRepo.list(user, {
    search,
    status,
    temperature,
    eventId: eventId && !isNaN(parseInt(eventId)) ? parseInt(eventId) : undefined,
    assignedToId: assignedTo && !isNaN(parseInt(assignedTo)) ? parseInt(assignedTo) : undefined,
    excludeDuplicates: includeDuplicates !== "true",
    followUp: hasFollowUp === "true" ? "has" : hasFollowUp === "false" ? "none" : undefined,
    scheduledMeetingOnly: hasMeeting === "true",
    dateFrom,
    dateTo,
    sort,
    limit: limitNum,
    offset,
  });

  const enriched = await Promise.all(rows.map(async (c) => {
    const { eventName, assignedToName } = await namesFor(c);
    return formatContact(c, eventName, assignedToName);
  }));

  return { contacts: enriched, total, page: pageNum, limit: limitNum };
}

export interface CreateContactInput {
  firstName?: string | null;
  lastName?: string | null;
  arabicName?: string | null;
  jobTitle?: string | null;
  contactCompany?: string | null;
  email?: string | null;
  mobile?: string | null;
  officePhone?: string | null;
  website?: string | null;
  country?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracy?: number | null;
  linkedin?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: string;
  followUpDate?: string | null;
  followUpTime?: string | null;
  eventId?: number | null;
  assignedToId?: number | null;
  cardImageUrl?: string | null;
}

export async function createContact(user: AuthUser, input: CreateContactInput) {
  const companyId = user.companyId ?? null;
  if (!companyId) throw new AppError(400, "No company context");
  const { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, latitude, longitude, gpsAccuracy, linkedin, notes, tags, status, followUpDate, followUpTime, eventId, assignedToId, cardImageUrl } = input;
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const { arabicName } = input;

  // AI lead qualification is deferred to a background task (see below) so the
  // contact appears IMMEDIATELY. The score/temperature/reasoning start null and
  // are filled in asynchronously; the mobile client refetches and shows them
  // within a second or two. Blocking the response on the Gemini call was the
  // single biggest avoidable latency in the save path.
  const contact = await contactsRepo.insert({ companyId, firstName, lastName, fullName, arabicName: arabicName ?? null, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, latitude: latitude ?? null, longitude: longitude ?? null, gpsAccuracy: gpsAccuracy ?? null, linkedin, notes, tags: JSON.stringify(tags ?? []), status: status ?? "new", leadScore: null, leadTemperature: null, aiReasoning: null, followUpDate: followUpDate ?? null, followUpTime: followUpTime ?? null, eventId: eventId ?? null, assignedToId: assignedToId ?? null, cardImageUrl: cardImageUrl ?? null });
  // Record the initial lead status in the append-only history.
  void contactsRepo.insertStatusHistory({ companyId, contactId: contact.id, fromStatus: null, toStatus: contact.status, comment: null, changedById: user.id }).catch(() => {});

  // Auto-link: if this new contact matches an existing original (same email /
  // phone / name+company), mark it as a duplicate immediately so it is hidden
  // from All Contacts, stats, and reports without waiting for a manual merge.
  let finalContact = contact;
  try {
    const original = await findOriginalContact(
      companyId,
      { email: contact.email, mobile: contact.mobile, officePhone: contact.officePhone, fullName: contact.fullName, firstName: contact.firstName, lastName: contact.lastName, contactCompany: contact.contactCompany },
      contact.id,
    );
    if (original) {
      const linked = await contactsRepo.linkAsDuplicate(contact.id, original.id);
      if (linked) finalContact = linked;
    }
  } catch {
    // Non-fatal: duplicate detection must never block contact creation.
  }

  // Background: AI lead qualification + hot-lead notify. Skip for auto-linked
  // duplicates (they are hidden from the list, so a score is pointless). The
  // scored row is picked up by the client on its next contacts refetch.
  if (!finalContact.duplicateOfId) {
    const ownerId = user.id;
    void (async () => {
      try {
        let eventName: string | null = null;
        if (finalContact.eventId) {
          const ev = await contactsRepo.eventName(finalContact.eventId);
          eventName = ev?.name ?? null;
        }
        const score = await scoreLead(
          { firstName: finalContact.firstName, lastName: finalContact.lastName, jobTitle: finalContact.jobTitle, contactCompany: finalContact.contactCompany, email: finalContact.email, mobile: finalContact.mobile, website: finalContact.website, linkedin: finalContact.linkedin, country: finalContact.country, notes: finalContact.notes },
          eventName,
        );
        const isHot = score.temperature === "hot";
        // Re-target the still-existing, still-original row. If the contact was
        // deleted or merged-away while scoring ran, `updated` is empty and we
        // skip the notification to avoid a stale "hot lead" push.
        const updated = await contactsRepo.updateScoreIfOriginal(finalContact.id, { leadScore: score.score, leadTemperature: score.temperature, aiReasoning: score.reasoning, hotNotifiedAt: isHot ? new Date() : undefined, updatedAt: new Date() });
        if (isHot && updated) {
          const target = finalContact.assignedToId ?? ownerId;
          void notifyUser(target, {
            title: "\uD83D\uDD25 Hot lead captured",
            body: `${finalContact.fullName ?? "New contact"}${finalContact.contactCompany ? ` \u00b7 ${finalContact.contactCompany}` : ""} scored ${score.score}`,
            data: { type: "hot_lead", contactId: finalContact.id },
          });
        }
      } catch (aiErr) {
        logAiError("lead-scoring", aiErr);
      }
    })();
  }

  return formatContact(finalContact);
}

export async function contactStats(user: AuthUser) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const { total, todayCount, byStatus } = await contactsRepo.stats(user, today);

  const wonCount = byStatus.find(s => s.status === "won")?.count ?? 0;
  const conversionRate = total > 0 ? Math.round((wonCount / total) * 100) : 0;

  return {
    total,
    newToday: todayCount,
    byStatus: byStatus.map(s => ({ status: s.status, count: s.count, label: s.status })),
    conversionRate,
  };
}

function normEmail(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 ? t : null;
}
function normPhone(v: string | null): string | null {
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}
function normName(c: ContactRow): string | null {
  const name = (c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ")).trim().toLowerCase().replace(/\s+/g, " ");
  const company = (c.contactCompany ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name || !company) return null;
  return `${name}|${company}`;
}

// Finds the first ORIGINAL contact (duplicateOfId IS NULL) in the same company
// that matches by email, phone, or name+company. Returns null if no match.
// Used by POST /contacts to auto-link new duplicates immediately at scan time.
async function findOriginalContact(
  companyId: number,
  fields: {
    email?: string | null; mobile?: string | null; officePhone?: string | null;
    fullName?: string | null; firstName?: string | null; lastName?: string | null;
    contactCompany?: string | null;
  },
  excludeId: number,
): Promise<ContactRow | null> {
  const candidates = await contactsRepo.originalCandidates(companyId, excludeId);

  const normE = normEmail(fields.email ?? null);
  const normM = normPhone(fields.mobile ?? null);
  const normO = normPhone(fields.officePhone ?? null);
  const fn = (fields.fullName ?? [fields.firstName, fields.lastName].filter(Boolean).join(" ")) || null;
  const nc = fn ? fn.trim().toLowerCase().replace(/\s+/g, " ") : null;
  const comp = fields.contactCompany ? fields.contactCompany.trim().toLowerCase().replace(/\s+/g, " ") : null;
  const normN = nc && comp ? `${nc}|${comp}` : null;

  for (const c of candidates) {
    if (normE && normE === normEmail(c.email)) return c;
    const cMobile = normPhone(c.mobile);
    const cOffice = normPhone(c.officePhone);
    if (normM && (normM === cMobile || normM === cOffice)) return c;
    if (normO && (normO === cMobile || normO === cOffice)) return c;
    if (normN && normN === normName(c)) return c;
  }
  return null;
}

export async function listDuplicates(user: AuthUser) {
  const allGroups: { matchType: string; matchValue: string; contacts: ReturnType<typeof formatContact>[] }[] = [];

  // ── 1. Linked groups — auto-detected duplicates (duplicateOfId IS NOT NULL)
  // These are definite duplicates stored at scan time; show original + duplicates.
  const linked = await contactsRepo.duplicatesLinked(user);

  if (linked.length > 0) {
    const originalIds = [...new Set(linked.map((c) => c.duplicateOfId).filter((id): id is number => id != null))];
    const originals = await contactsRepo.byIds(originalIds);
    const origMap = new Map(originals.map((o) => [o.id, o]));
    const byOriginal = new Map<number, ContactRow[]>();
    for (const c of linked) {
      if (!c.duplicateOfId) continue;
      const arr = byOriginal.get(c.duplicateOfId) ?? [];
      arr.push(c);
      byOriginal.set(c.duplicateOfId, arr);
    }
    for (const [origId, dups] of byOriginal) {
      const orig = origMap.get(origId);
      if (!orig) continue;
      allGroups.push({
        matchType: "linked",
        matchValue: (orig.fullName ?? [orig.firstName, orig.lastName].filter(Boolean).join(" ")) || `Contact #${origId}`,
        contacts: [orig, ...dups].map((m) => formatContact(m)),
      });
    }
  }

  // ── 2. Similarity groups — unlinked contacts only (legacy / still-pending)
  const rows = await contactsRepo.duplicatesUnlinked(user);

  const byKey = (extract: (c: ContactRow) => string | null) => {
    const map = new Map<string, ContactRow[]>();
    for (const c of rows) {
      const k = extract(c);
      if (!k) continue;
      const arr = map.get(k) ?? [];
      arr.push(c);
      map.set(k, arr);
    }
    return map;
  };

  const sources: { matchType: "email" | "phone" | "name"; map: Map<string, ContactRow[]> }[] = [
    { matchType: "email", map: byKey((c) => normEmail(c.email)) },
    { matchType: "phone", map: byKey((c) => normPhone(c.mobile) ?? normPhone(c.officePhone)) },
    { matchType: "name", map: byKey(normName) },
  ];

  const seen = new Set<string>();
  for (const { matchType, map } of sources) {
    for (const [key, members] of map) {
      if (members.length < 2) continue;
      const idKey = members.map((m) => m.id).sort((a, b) => a - b).join(",");
      if (seen.has(idKey)) continue;
      seen.add(idKey);
      allGroups.push({ matchType, matchValue: key, contacts: members.map((m) => formatContact(m)) });
    }
  }

  return { groups: allGroups };
}

const MERGE_BACKFILL_FIELDS = [
  "firstName", "lastName", "fullName", "arabicName", "jobTitle", "contactCompany",
  "email", "mobile", "officePhone", "website", "country", "address", "linkedin",
  "notes", "leadScore", "leadTemperature", "aiReasoning", "industry", "seniority",
  "enrichmentSummary", "talkingPoints", "followUpDate", "cardImageUrl", "eventId", "assignedToId",
] as const;

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

export async function makeOriginal(user: AuthUser, body: { duplicateId?: number; groupOriginalId?: number }) {
  const { duplicateId, groupOriginalId } = body;
  if (typeof duplicateId !== "number" || typeof groupOriginalId !== "number") {
    throw new AppError(400, "duplicateId and groupOriginalId are required integers");
  }
  if (duplicateId === groupOriginalId) {
    throw new AppError(400, "duplicateId and groupOriginalId must be different");
  }

  // Load both contacts
  const dup = await contactsRepo.findById(user, duplicateId);
  const orig = await contactsRepo.findById(user, groupOriginalId);

  if (!dup) throw new AppError(404, "Duplicate contact not found");
  if (!orig) throw new AppError(404, "Original contact not found");
  if (dup.companyId !== orig.companyId) {
    throw new AppError(400, "Both contacts must belong to the same company");
  }
  // The duplicate must actually point at the original
  if (dup.duplicateOfId !== groupOriginalId) {
    throw new AppError(400, "The specified contact is not a duplicate of the given original");
  }

  // Perform the swap in a transaction:
  // 1. Promote the dup: clear its duplicateOfId (it becomes the new original)
  // 2. Demote the old original: set its duplicateOfId to the new original
  // 3. Re-point any other duplicates of the old original to the new original
  await contactsRepo.makeOriginalSwap(duplicateId, groupOriginalId);

  return { success: true, message: "Contact promoted to original" };
}

export async function mergeContacts(user: AuthUser, body: { primaryId?: number; duplicateIds?: number[] }) {
  const { primaryId, duplicateIds } = body;
  if (typeof primaryId !== "number" || !Array.isArray(duplicateIds) || duplicateIds.length === 0) {
    throw new AppError(400, "primaryId and a non-empty duplicateIds array are required");
  }
  const dupIds = [...new Set(duplicateIds)].filter((id) => id !== primaryId);
  if (dupIds.length === 0) throw new AppError(400, "No distinct duplicate ids to merge");

  const primary = await contactsRepo.findById(user, primaryId);
  if (!primary) throw new AppError(404, "Primary contact not found");

  const dups = await contactsRepo.byIds(dupIds);
  if (dups.length !== dupIds.length || dups.some((d) => d.companyId !== primary.companyId)) {
    throw new AppError(400, "All duplicates must exist and belong to the same company as the primary contact");
  }

  // Backfill empty primary fields from duplicates (in request order), and union tags.
  const updates: Record<string, unknown> = {};
  for (const field of MERGE_BACKFILL_FIELDS) {
    if (!isEmpty(primary[field])) continue;
    for (const d of dups) {
      if (!isEmpty(d[field])) { updates[field] = d[field]; break; }
    }
  }
  const tagSet = new Set<string>(parseTags(primary.tags));
  for (const d of dups) for (const t of parseTags(d.tags)) tagSet.add(t);
  updates.tags = JSON.stringify([...tagSet]);
  updates.updatedAt = new Date();

  const merged = await contactsRepo.mergeTransaction(primaryId, dupIds, updates as Partial<ContactRow>);

  const { eventName, assignedToName } = await namesFor(merged);
  return formatContact(merged, eventName, assignedToName);
}

export async function getContact(user: AuthUser, id: number) {
  const c = await contactsRepo.findById(user, id);
  if (!c) throw new AppError(404, "Contact not found");
  const { eventName, assignedToName } = await namesFor(c);
  return formatContact(c, eventName, assignedToName);
}

export interface UpdateContactInput {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  contactCompany?: string | null;
  email?: string | null;
  mobile?: string | null;
  officePhone?: string | null;
  website?: string | null;
  country?: string | null;
  address?: string | null;
  linkedin?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: string;
  statusComment?: string | null;
  followUpDate?: string | null;
  followUpTime?: string | null;
  eventId?: number | null;
  assignedToId?: number | null;
}

export async function updateContact(user: AuthUser, id: number, body: UpdateContactInput) {
  const existing = await contactsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Contact not found");
  const { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, linkedin, notes, tags, status, statusComment, followUpDate, followUpTime, eventId, assignedToId } = body;
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  const fullName = firstName !== undefined || lastName !== undefined ? [firstName, lastName].filter(Boolean).join(" ") || null : undefined;
  const updateData: Record<string, unknown> = { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, linkedin, notes, status, followUpDate, followUpTime, eventId, assignedToId };
  if (fullName !== undefined) updateData.fullName = fullName;
  if (tags !== undefined) updateData.tags = JSON.stringify(tags);
  // Remove undefined
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  if (Object.keys(updateData).length === 0) throw new AppError(400, "No valid fields to update");
  const statusChanged = status !== undefined && status !== existing.status;
  const c = await contactsRepo.update(id, updateData as Partial<ContactRow>);
  if (!c) throw new AppError(404, "Contact not found");
  // Log lead status transitions to the append-only history.
  if (statusChanged) {
    void contactsRepo.insertStatusHistory({ companyId: existing.companyId, contactId: id, fromStatus: existing.status, toStatus: status, comment: statusComment ?? null, changedById: user.id }).catch(() => {});
  }
  const { eventName, assignedToName } = await namesFor(c);
  return formatContact(c, eventName, assignedToName);
}

export async function deleteContact(user: AuthUser, id: number) {
  const existing = await contactsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Contact not found");
  await contactsRepo.softDelete(id);
  return { success: true, message: "Contact deleted" };
}

export async function enrichContact(user: AuthUser, id: number) {
  const c = await contactsRepo.findById(user, id);
  if (!c) throw new AppError(404, "Contact not found");

  let result;
  try {
    result = await aiEnrichContact({
      firstName: c.firstName, lastName: c.lastName, jobTitle: c.jobTitle,
      contactCompany: c.contactCompany, email: c.email, website: c.website,
      linkedin: c.linkedin, country: c.country, notes: c.notes,
    });
  } catch (aiErr) {
    logAiError("contact-enrichment", aiErr);
    throw new AppError(502, "AI enrichment is temporarily unavailable. Please try again.");
  }

  const updated = await contactsRepo.update(id, {
    industry: result.industry,
    seniority: result.seniority,
    enrichmentSummary: result.summary,
    talkingPoints: JSON.stringify(result.talkingPoints),
    enrichedAt: new Date(),
    updatedAt: new Date(),
  });
  if (!updated) throw new AppError(404, "Contact not found");

  const { eventName, assignedToName } = await namesFor(updated);
  return formatContact(updated, eventName, assignedToName);
}

export async function statusHistory(user: AuthUser, id: number) {
  const c = await contactsRepo.findById(user, id);
  if (!c) throw new AppError(404, "Contact not found");
  const rows = await contactsRepo.statusHistoryRows(id);
  const userIds = [...new Set(rows.map(r => r.changedById).filter((v): v is number => v != null))];
  const users = await contactsRepo.usersByIds(userIds);
  const nameById = new Map(users.map(u => [u.id, u.name]));
  const history = rows.map(r => ({ ...r, changedByName: r.changedById != null ? (nameById.get(r.changedById) ?? null) : null }));
  return { history, total: history.length };
}
