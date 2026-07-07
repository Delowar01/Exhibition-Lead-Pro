import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { refAccessible, refInCompany } from "../lib/tenant.js";
import * as orgRepo from "../repositories/organizations.repository.js";
import { scoreLead, enrichContact as aiEnrichContact, logAiError } from "../lib/ai.js";
import { notifyUser } from "../lib/push.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import * as scansRepo from "../repositories/scans.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import type { ContactRow } from "../repositories/contacts.repository.js";
import * as mergeHistoryRepo from "../repositories/merge_history.repository.js";
import * as customFields from "./custom_fields.service.js";
import { parseListQuery } from "../lib/list-query.js";

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try { return JSON.parse(tags); } catch { return []; }
}

function formatContact(c: ContactRow, eventName?: string | null, assignedToName?: string | null, organizationName?: string | null) {
  return {
    ...c,
    fullName: c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
    tags: parseTags(c.tags),
    talkingPoints: parseTags(c.talkingPoints),
    eventName: eventName ?? null,
    assignedToName: assignedToName ?? null,
    organizationName: organizationName ?? null,
  };
}

async function namesFor(c: ContactRow) {
  const event = c.eventId ? await contactsRepo.eventName(c.eventId) : null;
  const assignee = c.assignedToId ? await contactsRepo.assigneeName(c.assignedToId) : null;
  const organizationName = c.organizationId ? await orgRepo.nameById(c.organizationId) : null;
  return { eventName: event?.name, assignedToName: assignee?.name, organizationName };
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
  const { status, temperature, eventId, assignedTo, hasFollowUp, hasMeeting, dateFrom, dateTo, includeDuplicates } = params;
  const { search, sort, page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 20, maxPageSize: 200 });

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

  // Batch the FK name lookups: two queries total (events + users) instead of
  // two per row. Same output shape as the per-row namesFor() path.
  const eventIds = [...new Set(rows.map((c) => c.eventId).filter((v): v is number => v != null))];
  const userIds = [...new Set(rows.map((c) => c.assignedToId).filter((v): v is number => v != null))];
  const orgIds = [...new Set(rows.map((c) => c.organizationId).filter((v): v is number => v != null))];
  const [events, users, orgNameById] = await Promise.all([
    contactsRepo.eventNamesByIds(eventIds),
    contactsRepo.usersByIds(userIds),
    orgRepo.namesByIds(orgIds),
  ]);
  const eventNameById = new Map(events.map((e) => [e.id, e.name]));
  const userNameById = new Map(users.map((u) => [u.id, u.name]));

  const enriched = rows.map((c) =>
    formatContact(
      c,
      c.eventId != null ? eventNameById.get(c.eventId) : null,
      c.assignedToId != null ? userNameById.get(c.assignedToId) : null,
      c.organizationId != null ? orgNameById.get(c.organizationId) : null,
    ),
  );

  return { contacts: enriched, total, page: pageNum, limit: limitNum };
}

// Batch-enriches a set of contact rows into the standard list shape (tags parsed,
// event + assignee names resolved). Shared with advanced search so both surfaces
// return an identical contact payload.
export async function enrichContactRows(rows: ContactRow[]): Promise<ReturnType<typeof formatContact>[]> {
  const eventIds = [...new Set(rows.map((c) => c.eventId).filter((v): v is number => v != null))];
  const userIds = [...new Set(rows.map((c) => c.assignedToId).filter((v): v is number => v != null))];
  const orgIds = [...new Set(rows.map((c) => c.organizationId).filter((v): v is number => v != null))];
  const [events, users, orgNameById] = await Promise.all([contactsRepo.eventNamesByIds(eventIds), contactsRepo.usersByIds(userIds), orgRepo.namesByIds(orgIds)]);
  const eventNameById = new Map(events.map((e) => [e.id, e.name]));
  const userNameById = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((c) =>
    formatContact(
      c,
      c.eventId != null ? eventNameById.get(c.eventId) : null,
      c.assignedToId != null ? userNameById.get(c.assignedToId) : null,
      c.organizationId != null ? orgNameById.get(c.organizationId) : null,
    ),
  );
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
  city?: string | null;
  postalCode?: string | null;
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
  organizationId?: number | null;
  cardImageUrl?: string | null;
  source?: string | null;
  // ── Interaction model (Contact vs Interaction) ──
  /** Scan this contact is being created from — permanently linked as an interaction. */
  scanId?: number | null;
  /** Explicit human resolution for a detected existing contact. Never auto-applied. */
  dedupeResolution?: "add_interaction" | "create_separate" | null;
  /** With dedupeResolution=add_interaction: the existing contact to attach the interaction to. */
  matchedContactId?: number | null;
}

export type CreateContactResult =
  | { status: 201; body: ReturnType<typeof formatContact> }
  | { status: 409; body: {
      code: "existing_contact_found";
      message: string;
      contact: ReturnType<typeof formatContact>;
      matches: ContactMatch[];
      previousEvents: string[];
      interactionCount: number;
      lastInteractionDate: string | null;
    } };

export async function createContact(user: AuthUser, input: CreateContactInput) {
  const companyId = user.companyId ?? null;
  if (!companyId) throw new AppError(400, "No company context");
  const { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, city, postalCode, latitude, longitude, gpsAccuracy, linkedin, notes, tags, status, followUpDate, followUpTime, eventId, assignedToId, organizationId, cardImageUrl, source, scanId, dedupeResolution, matchedContactId } = input;
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  // organizationId is bound to the CONTACT's own tenant — use refInCompany
  // (target-company-scoped), NOT refAccessible (caller-scoped), so a multi-company
  // caller cannot point this contact at another tenant's organization.
  if (organizationId != null && !(await refInCompany("organizations", companyId, organizationId))) throw new AppError(400, "Invalid organizationId");
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const { arabicName } = input;

  // ── Interaction model: resolve the originating scan (must be in-tenant). ──
  let scanRow: Awaited<ReturnType<typeof scansRepo.findById>> = undefined;
  if (scanId != null) {
    scanRow = await scansRepo.findById(user, scanId);
    if (!scanRow || scanRow.companyId !== companyId) throw new AppError(400, "Invalid scanId");
  }
  // Context fields for the permanent interaction record: prefer values already
  // persisted on the scan at capture time, fall back to the create payload.
  const interactionExtra = {
    eventId: scanRow?.eventId ?? eventId ?? null,
    latitude: scanRow?.latitude ?? latitude ?? null,
    longitude: scanRow?.longitude ?? longitude ?? null,
    gpsAccuracy: scanRow?.gpsAccuracy ?? gpsAccuracy ?? null,
    notes: scanRow?.notes ?? null,
  };

  // ── Human-in-the-loop duplicate detection (409, never auto-merge). ──
  // Only when the client has not yet made an explicit resolution choice.
  if (dedupeResolution == null) {
    const matches = await matchExistingContacts(user, { email, mobile, officePhone, firstName, lastName, contactCompany, website, linkedin, address });
    const top = matches[0];
    if (top && top.confidence >= DUPLICATE_PROMPT_THRESHOLD) {
      const existing = await contactsRepo.findById(user, top.contactId);
      if (existing) {
        const summary = await scansRepo.interactionSummary(companyId, existing.id);
        return {
          status: 409,
          body: {
            code: "existing_contact_found",
            message: `${existing.fullName ?? "This contact"} already exists in your contacts.`,
            contact: formatContact(existing),
            matches,
            previousEvents: summary.eventNames,
            interactionCount: summary.count,
            lastInteractionDate: summary.lastAt ? summary.lastAt.toISOString() : null,
          },
        };
      }
    }
  }

  // ── Resolution: attach this capture as a NEW interaction on the existing
  // contact. The contact record itself is NOT modified (no auto-merge).
  if (dedupeResolution === "add_interaction") {
    if (matchedContactId == null) throw new AppError(400, "matchedContactId is required for add_interaction");
    const existing = await contactsRepo.findById(user, matchedContactId);
    if (!existing || existing.companyId !== companyId) throw new AppError(400, "Invalid matchedContactId");
    if (scanRow) {
      await scansRepo.linkScanToContact(companyId, scanRow.id, existing.id, interactionExtra);
    } else {
      await scansRepo.insert({ companyId, userId: user.id, contactId: existing.id, status: "completed", imageUrl: null, extractedData: null, captureSource: source ?? "manual", extractionMethod: "manual", ...interactionExtra });
    }
    return { status: 201, body: formatContact(existing) };
  }

  // AI lead qualification is deferred to a background task (see below) so the
  // contact appears IMMEDIATELY. The score/temperature/reasoning start null and
  // are filled in asynchronously; the mobile client refetches and shows them
  // within a second or two. Blocking the response on the Gemini call was the
  // single biggest avoidable latency in the save path.
  const contact = await contactsRepo.insert({ companyId, firstName, lastName, fullName, arabicName: arabicName ?? null, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, city: city ?? null, postalCode: postalCode ?? null, latitude: latitude ?? null, longitude: longitude ?? null, gpsAccuracy: gpsAccuracy ?? null, linkedin, notes, tags: JSON.stringify(tags ?? []), status: status ?? "new", leadScore: null, leadTemperature: null, aiReasoning: null, followUpDate: followUpDate ?? null, followUpTime: followUpTime ?? null, eventId: eventId ?? null, assignedToId: assignedToId ?? null, organizationId: organizationId ?? null, cardImageUrl: cardImageUrl ?? null, source: source ?? null });
  // Record the initial lead status in the append-only history.
  void contactsRepo.insertStatusHistory({ companyId, contactId: contact.id, fromStatus: null, toStatus: contact.status, comment: null, changedById: user.id }).catch(() => {});

  // NOTE (interaction model): scan-time auto-linking as a duplicate was removed —
  // duplicates are now handled BEFORE creation via the human-in-the-loop 409 flow
  // above. Every created contact gets a permanent interaction record: either the
  // originating scan is linked, or a synthetic "manual" interaction is inserted.
  const finalContact = contact;
  try {
    if (scanRow) {
      await scansRepo.linkScanToContact(companyId, scanRow.id, contact.id, interactionExtra);
    } else {
      await scansRepo.insert({ companyId, userId: user.id, contactId: contact.id, status: "completed", imageUrl: null, extractedData: null, captureSource: source ?? "manual", extractionMethod: "manual", ...interactionExtra });
    }
  } catch {
    // Non-fatal: the interaction record must never block contact creation.
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
          { companyId: finalContact.companyId, userId: ownerId },
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

  return { status: 201, body: formatContact(finalContact) };
}

/** Permanent interaction (capture) history for a contact — newest first. */
export async function listContactInteractions(user: AuthUser, contactId: number) {
  const contact = await contactsRepo.findById(user, contactId);
  if (!contact) throw new AppError(404, "Contact not found");
  const rows = await scansRepo.interactionsForContact(contact.companyId, contact.id);
  return {
    interactions: rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      contactId: r.contactId,
      userId: r.userId,
      userName: r.userName,
      eventId: r.eventId,
      eventName: r.eventName,
      captureSource: r.captureSource,
      extractionMethod: r.extractionMethod,
      imageUrl: r.imageUrl !== null ? `/api/scans/${r.id}/image` : null,
      latitude: r.latitude,
      longitude: r.longitude,
      gpsAccuracy: r.gpsAccuracy,
      notes: r.notes,
      aiSummary: r.aiSummary,
      ocrData: (() => { try { return r.extractedData ? JSON.parse(r.extractedData) : null; } catch { return null; } })(),
      occurredAt: r.createdAt,
    })),
    total: rows.length,
  };
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
// Person name only (no company) — for similarity clustering.
function normPersonName(c: ContactRow): string | null {
  const name = (c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ")).trim().toLowerCase().replace(/\s+/g, " ");
  return name.length > 0 ? name : null;
}
function normCompany(c: ContactRow): string | null {
  const company = (c.contactCompany ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return company.length > 0 ? company : null;
}
// Normalize a URL/handle for equality: drop scheme, leading www., trailing slash.
function normUrl(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return t.length > 0 ? t : null;
}
// Normalized Levenshtein similarity ratio in [0,1] (1 = identical).
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return 1 - prev[n] / Math.max(m, n);
}

// NOTE (interaction model): the former findOriginalContact auto-link helper was
// removed — POST /contacts no longer auto-links duplicates. Detection now runs
// through the weighted matchExistingContacts + human-in-the-loop 409 flow.

export interface DupeCandidateFields {
  email?: string | null; mobile?: string | null; officePhone?: string | null;
  fullName?: string | null; firstName?: string | null; lastName?: string | null;
  contactCompany?: string | null;
}

// Bulk-import helper: builds an in-memory duplicate matcher over ALL existing
// originals in a company ONCE (the per-row findOriginalContact would re-query
// per row — O(N) DB round-trips for an N-row import). Reuses the exact same
// email / phone / name+company matching rules as findOriginalContact so import
// dedupe and scan-time dedupe stay consistent. The returned matcher also folds
// in rows already matched during this import (via `remember`) so two identical
// rows in the same file collapse to one. Returns the matching original's id or null.
export async function buildContactDupeMatcher(companyId: number) {
  const candidates = await contactsRepo.originalCandidates(companyId, -1);
  const byEmail = new Map<string, number>();
  const byPhone = new Map<string, number>();
  const byName = new Map<string, number>();
  const index = (id: number, fields: DupeCandidateFields) => {
    const e = normEmail(fields.email ?? null);
    if (e && !byEmail.has(e)) byEmail.set(e, id);
    const m = normPhone(fields.mobile ?? null);
    if (m && !byPhone.has(m)) byPhone.set(m, id);
    const o = normPhone(fields.officePhone ?? null);
    if (o && !byPhone.has(o)) byPhone.set(o, id);
    const fn = (fields.fullName ?? [fields.firstName, fields.lastName].filter(Boolean).join(" ")) || null;
    const nc = fn ? fn.trim().toLowerCase().replace(/\s+/g, " ") : null;
    const comp = fields.contactCompany ? fields.contactCompany.trim().toLowerCase().replace(/\s+/g, " ") : null;
    const n = nc && comp ? `${nc}|${comp}` : null;
    if (n && !byName.has(n)) byName.set(n, id);
  };
  for (const c of candidates) index(c.id, c);

  const match = (fields: DupeCandidateFields): number | null => {
    const e = normEmail(fields.email ?? null);
    if (e && byEmail.has(e)) return byEmail.get(e)!;
    const m = normPhone(fields.mobile ?? null);
    if (m && byPhone.has(m)) return byPhone.get(m)!;
    const o = normPhone(fields.officePhone ?? null);
    if (o && byPhone.has(o)) return byPhone.get(o)!;
    const fn = (fields.fullName ?? [fields.firstName, fields.lastName].filter(Boolean).join(" ")) || null;
    const nc = fn ? fn.trim().toLowerCase().replace(/\s+/g, " ") : null;
    const comp = fields.contactCompany ? fields.contactCompany.trim().toLowerCase().replace(/\s+/g, " ") : null;
    const n = nc && comp ? `${nc}|${comp}` : null;
    if (n && byName.has(n)) return byName.get(n)!;
    return null;
  };
  return { match, remember: index };
}

export interface ContactMatchInput {
  email?: string | null; mobile?: string | null; officePhone?: string | null;
  firstName?: string | null; lastName?: string | null; fullName?: string | null;
  contactCompany?: string | null; website?: string | null; linkedin?: string | null;
  address?: string | null;
}

// Weighted 4-tier duplicate-signal model (0-100 confidence per signal):
//   HIGHEST — email (100), mobile (95): unique personal identifiers.
//   HIGH    — linkedin (90), office phone (88): strong but occasionally shared.
//   MEDIUM  — name+company (75), full name alone (65), company alone (55): suggestive, never merge-grade.
//   LOW     — website (45), address (40): company-level signals only.
// The human-in-the-loop 409 prompt fires at confidence >= DUPLICATE_PROMPT_THRESHOLD.
// Nothing is EVER auto-merged — the user always decides.
export const MATCH_WEIGHTS = {
  email: 100,
  mobile: 95,
  linkedin: 90,
  officePhone: 88,
  nameCompany: 75,
  nameOnly: 65,
  companyOnly: 55,
  website: 45,
  address: 40,
  fuzzyNameSameCompany: 70,
} as const;
export const DUPLICATE_PROMPT_THRESHOLD = 88;
export interface ContactMatch {
  contactId: number;
  fullName: string | null;
  email: string | null;
  mobile: string | null;
  contactCompany: string | null;
  status: string;
  confidence: number;
  reasons: string[];
  // Stage 5E recognition flags — all derived from live tenant CRM data, never guessed.
  /** Count of non-deleted leads linked to this contact. */
  leadCount: number;
  /** True when this contact already has at least one lead in the pipeline. */
  isLead: boolean;
  /** True when the contact's status is "won" (existing customer). */
  isCustomer: boolean;
  /** Deterministic seniority/title heuristic (C-Level/VP/Director or equivalent title). */
  isDecisionMaker: boolean;
}

// Deterministic decision-maker heuristic: AI-enriched seniority (when present) or a
// conservative job-title keyword check. No AI call, no guessing beyond stored fields.
const DECISION_TITLE_RE = /\b(ceo|cto|cfo|coo|cio|cmo|chief|founder|co-?founder|president|vice\s*president|vp|director|managing\s+director|general\s+manager|owner|partner|head\s+of)\b/i;
export function isDecisionMakerHeuristic(seniority: string | null, jobTitle: string | null): boolean {
  if (seniority && /^(c-level|vp|director)$/i.test(seniority.trim())) return true;
  return jobTitle != null && DECISION_TITLE_RE.test(jobTitle);
}

// Read-only recognition for the capture flow: given the fields on a card being
// captured (NOT yet saved), find EXISTING original contacts in the same tenant that
// likely refer to the same person, with an explainable confidence + reasons. Reuses
// the exact same signals as scan-time dedup (email/phone/linkedin/name+company/fuzzy
// name) so recognition and dedup never disagree. Never writes, never auto-links —
// this only surfaces candidates for the user to decide on. Tenant-scoped by companyId.
export async function matchExistingContacts(user: AuthUser, input: ContactMatchInput): Promise<ContactMatch[]> {
  if (!user.companyId) return [];
  const candidates = await contactsRepo.originalCandidates(user.companyId, -1);

  const normE = normEmail(input.email ?? null);
  const normM = normPhone(input.mobile ?? null);
  const normO = normPhone(input.officePhone ?? null);
  const normL = normUrl(input.linkedin ?? null);
  const normW = normUrl(input.website ?? null);
  const normA = input.address ? input.address.trim().toLowerCase().replace(/\s+/g, " ") : null;
  const fn = (input.fullName ?? [input.firstName, input.lastName].filter(Boolean).join(" ")) || null;
  const personName = fn ? fn.trim().toLowerCase().replace(/\s+/g, " ") : null;
  const comp = input.contactCompany ? input.contactCompany.trim().toLowerCase().replace(/\s+/g, " ") : null;
  const nameCompanyKey = personName && comp ? `${personName}|${comp}` : null;

  const matches: ContactMatch[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    let confidence = 0;
    const bump = (score: number, reason: string) => { confidence = Math.max(confidence, score); reasons.push(reason); };

    // HIGHEST tier — unique personal identifiers.
    if (normE && normE === normEmail(c.email)) bump(MATCH_WEIGHTS.email, "Same email address");
    const cMobile = normPhone(c.mobile);
    const cOffice = normPhone(c.officePhone);
    const mobileInvolved = (normM && (normM === cMobile || normM === cOffice)) || (normO && normO === cMobile);
    const officeOnly = !mobileInvolved && normO && normO === cOffice;
    if (mobileInvolved) bump(MATCH_WEIGHTS.mobile, "Same mobile number");
    // HIGH tier — strong but occasionally shared identifiers.
    if (normL && normL === normUrl(c.linkedin)) bump(MATCH_WEIGHTS.linkedin, "Same LinkedIn profile");
    if (officeOnly) bump(MATCH_WEIGHTS.officePhone, "Same office phone");
    // MEDIUM tier — suggestive; never merge-grade on their own.
    const cPerson = normPersonName(c);
    const cComp = normCompany(c);
    if (nameCompanyKey && nameCompanyKey === normName(c)) bump(MATCH_WEIGHTS.nameCompany, "Same name and company");
    else if (personName && cPerson === personName) bump(MATCH_WEIGHTS.nameOnly, "Same full name");
    else if (comp && cComp === comp) bump(MATCH_WEIGHTS.companyOnly, "Same company name");
    // LOW tier — company-level signals only.
    if (normW && normW === normUrl(c.website)) bump(MATCH_WEIGHTS.website, "Same website");
    if (normA && c.address && normA === c.address.trim().toLowerCase().replace(/\s+/g, " ")) bump(MATCH_WEIGHTS.address, "Same address");
    // Fuzzy same-company name (typos / ordering) only when we haven't already matched harder.
    if (confidence < MATCH_WEIGHTS.nameCompany && personName && comp) {
      if (cPerson && cComp === comp && cPerson !== personName && nameSimilarity(personName, cPerson) >= NAME_SIM_THRESHOLD) bump(MATCH_WEIGHTS.fuzzyNameSameCompany, "Similar name at the same company");
    }

    if (confidence > 0) {
      matches.push({
        contactId: c.id,
        fullName: (c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ")) || null,
        email: c.email,
        mobile: c.mobile,
        contactCompany: c.contactCompany,
        status: c.status,
        confidence,
        reasons,
        leadCount: 0, // filled below for the returned top matches only
        isLead: false,
        isCustomer: c.status === "won",
        isDecisionMaker: isDecisionMakerHeuristic(c.seniority, c.jobTitle),
      });
    }
  }
  matches.sort((a, b) => b.confidence - a.confidence);
  const top = matches.slice(0, 5);
  // Recognition flags: live lead linkage for just the returned matches (tenant-scoped).
  const leadCounts = await leadsRepo.leadCountsByContactIds(user.companyId, top.map((m) => m.contactId));
  for (const m of top) {
    m.leadCount = leadCounts.get(m.contactId) ?? 0;
    m.isLead = m.leadCount > 0;
  }
  return top;
}

// Explainable-signal weights (max confidence contributed by each shared signal).
const DUP_SIGNAL_WEIGHTS = { email: 100, phone: 95, linkedin: 95, nameCompany: 85, website: 70, nameOnly: 55 } as const;
const NAME_SIM_THRESHOLD = 0.85; // fuzzy same-company name clustering cutoff

// Inspect a formed group and explain WHY its members are considered duplicates,
// returning human-readable reasons + a 0-100 confidence score. Only signals ALL
// members share count; multiple shared signals add a small boost.
function explainGroup(members: ContactRow[]): { reasons: string[]; score: number } {
  const reasons: string[] = [];
  let score = 0;
  const shared = (extract: (c: ContactRow) => string | null): string | null => {
    const first = extract(members[0]);
    if (!first) return null;
    return members.every((m) => extract(m) === first) ? first : null;
  };
  const email = shared((c) => normEmail(c.email));
  if (email) { reasons.push(`Same email (${email})`); score = Math.max(score, DUP_SIGNAL_WEIGHTS.email); }
  const phone = shared((c) => normPhone(c.mobile) ?? normPhone(c.officePhone));
  if (phone) { reasons.push(`Same phone (${phone})`); score = Math.max(score, DUP_SIGNAL_WEIGHTS.phone); }
  const linkedin = shared((c) => normUrl(c.linkedin));
  if (linkedin) { reasons.push("Same LinkedIn profile"); score = Math.max(score, DUP_SIGNAL_WEIGHTS.linkedin); }
  const name = shared(normPersonName);
  const company = shared(normCompany);
  if (name && company) { reasons.push(`Same name & company (${name} @ ${company})`); score = Math.max(score, DUP_SIGNAL_WEIGHTS.nameCompany); }
  else if (name) { reasons.push(`Same name (${name})`); score = Math.max(score, DUP_SIGNAL_WEIGHTS.nameOnly); }
  const website = shared((c) => normUrl(c.website));
  if (website) { reasons.push(`Same website (${website})`); score = Math.max(score, DUP_SIGNAL_WEIGHTS.website); }
  if (reasons.length > 1) score = Math.min(100, score + 5);
  return { reasons, score };
}

export interface DuplicateGroup {
  matchType: string;
  matchValue: string;
  reasons: string[];
  score: number;
  contacts: ReturnType<typeof formatContact>[];
}

export async function listDuplicates(user: AuthUser) {
  const allGroups: DuplicateGroup[] = [];

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
      const members = [orig, ...dups];
      const { reasons } = explainGroup(members);
      allGroups.push({
        matchType: "linked",
        matchValue: (orig.fullName ?? [orig.firstName, orig.lastName].filter(Boolean).join(" ")) || `Contact #${origId}`,
        reasons: reasons.length > 0 ? reasons : ["Auto-linked as a duplicate at scan time"],
        score: 100,
        contacts: members.map((m) => formatContact(m)),
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

  const sources: { matchType: string; map: Map<string, ContactRow[]> }[] = [
    { matchType: "email", map: byKey((c) => normEmail(c.email)) },
    { matchType: "phone", map: byKey((c) => normPhone(c.mobile) ?? normPhone(c.officePhone)) },
    { matchType: "linkedin", map: byKey((c) => normUrl(c.linkedin)) },
    { matchType: "website", map: byKey((c) => normUrl(c.website)) },
    { matchType: "name", map: byKey(normName) },
  ];

  const seen = new Set<string>();
  const idKeyOf = (members: ContactRow[]) => members.map((m) => m.id).sort((a, b) => a - b).join(",");
  for (const { matchType, map } of sources) {
    for (const [key, members] of map) {
      if (members.length < 2) continue;
      const idKey = idKeyOf(members);
      if (seen.has(idKey)) continue;
      seen.add(idKey);
      const { reasons, score } = explainGroup(members);
      allGroups.push({ matchType, matchValue: key, reasons, score, contacts: members.map((m) => formatContact(m)) });
    }
  }

  // ── 3. Fuzzy name-similarity within the SAME company (typos, ordering, initials).
  // Union-find over unlinked contacts bucketed by normalized company.
  const byCompany = new Map<string, ContactRow[]>();
  for (const c of rows) {
    const comp = normCompany(c);
    const nm = normPersonName(c);
    if (!comp || !nm) continue;
    (byCompany.get(comp) ?? byCompany.set(comp, []).get(comp)!).push(c);
  }
  for (const [, bucket] of byCompany) {
    if (bucket.length < 2) continue;
    const parent = bucket.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = normPersonName(bucket[i])!, b = normPersonName(bucket[j])!;
        if (a !== b && nameSimilarity(a, b) >= NAME_SIM_THRESHOLD) union(i, j);
      }
    }
    const clusters = new Map<number, ContactRow[]>();
    for (let i = 0; i < bucket.length; i++) (clusters.get(find(i)) ?? clusters.set(find(i), []).get(find(i))!).push(bucket[i]);
    for (const [, members] of clusters) {
      if (members.length < 2) continue;
      const idKey = idKeyOf(members);
      if (seen.has(idKey)) continue;
      seen.add(idKey);
      const names = members.map((m) => normPersonName(m)!);
      const best = Math.max(...names.slice(1).map((n) => nameSimilarity(names[0], n)));
      allGroups.push({
        matchType: "name-similarity",
        matchValue: normCompany(members[0])!,
        reasons: [`Similar names at the same company (${Math.round(best * 100)}% match)`],
        score: Math.round(60 + best * 20),
        contacts: members.map((m) => formatContact(m)),
      });
    }
  }

  allGroups.sort((a, b) => b.score - a.score);
  return { groups: allGroups };
}

const MERGE_BACKFILL_FIELDS = [
  "firstName", "lastName", "fullName", "arabicName", "jobTitle", "contactCompany",
  "email", "mobile", "officePhone", "website", "country", "address", "city", "postalCode", "linkedin",
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

const MERGE_OVERRIDABLE_FIELDS = new Set<string>(MERGE_BACKFILL_FIELDS);

export async function mergeContacts(
  user: AuthUser,
  body: { primaryId?: number; duplicateIds?: number[]; fieldValues?: Record<string, unknown> },
) {
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
  // Explicit per-field winning values override the backfill heuristic (the user
  // resolved a conflict in the merge UI). Only allow the known backfill fields.
  for (const [field, value] of Object.entries(body.fieldValues ?? {})) {
    if (MERGE_OVERRIDABLE_FIELDS.has(field)) updates[field] = value;
  }
  const tagSet = new Set<string>(parseTags(primary.tags));
  for (const d of dups) for (const t of parseTags(d.tags)) tagSet.add(t);
  updates.tags = JSON.stringify([...tagSet]);
  updates.updatedAt = new Date();

  // Formal merge-history: capture WHO, the surviving/merged ids, the applied
  // field choices, and a pre-merge snapshot (primary + dups + per-dup child ids +
  // dup custom-field values) so undo can fully reverse the merge. Written INSIDE
  // the merge transaction (see mergeTransaction), which supplies the child refs.
  const merged = await contactsRepo.mergeTransaction(
    primaryId,
    dupIds,
    updates as Partial<ContactRow>,
    ({ childRefs, customFieldValues }) => ({
      companyId: primary.companyId,
      entityType: "contact",
      primaryId,
      mergedIds: JSON.stringify(dupIds),
      fieldChoices: JSON.stringify(updates),
      snapshot: JSON.stringify({ primary, duplicates: dups, childRefs, customFieldValues }),
      performedById: user.id,
    }),
  );

  const { eventName, assignedToName, organizationName } = await namesFor(merged);
  return formatContact(merged, eventName, assignedToName, organizationName);
}

// Undo a previously-recorded contact merge: re-create the merged-away duplicates,
// re-point every child row back, restore the primary's pre-merge field values, and
// re-insert the dups' custom-field values — all transactionally. Idempotency-
// guarded: a history row can only be undone once.
const CONTACT_DATE_FIELDS = ["enrichedAt", "hotNotifiedAt", "createdAt", "updatedAt", "deletedAt"] as const;

function reviveDates<T extends Record<string, unknown>>(row: T, fields: readonly string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") out[f] = new Date(v);
  }
  return out as T;
}

export async function undoMerge(user: AuthUser, historyId: number) {
  if (!Number.isInteger(historyId)) throw new AppError(400, "A valid merge-history id is required");
  const history = await mergeHistoryRepo.findById(user, historyId);
  if (!history) throw new AppError(404, "Merge-history record not found");
  if (history.undoneAt) throw new AppError(400, "This merge has already been undone");

  let snapshot: {
    primary?: Record<string, unknown>;
    duplicates?: Array<Record<string, unknown>>;
    childRefs?: Record<string, Record<string, number[]>>;
    customFieldValues?: Array<Record<string, unknown>>;
  };
  try {
    snapshot = history.snapshot ? JSON.parse(history.snapshot) : {};
  } catch {
    throw new AppError(400, "This merge cannot be undone (snapshot is unreadable)");
  }
  if (!snapshot.primary || !Array.isArray(snapshot.duplicates) || snapshot.duplicates.length === 0) {
    throw new AppError(400, "This merge cannot be undone (snapshot predates undo support)");
  }

  // Restore the primary's pre-merge values for exactly the fields the merge changed
  // (the fieldChoices keys), plus a fresh updatedAt.
  let fieldChoices: Record<string, unknown> = {};
  try {
    fieldChoices = history.fieldChoices ? JSON.parse(history.fieldChoices) : {};
  } catch {
    throw new AppError(400, "This merge cannot be undone (field choices are unreadable)");
  }
  const primaryRestore: Record<string, unknown> = {};
  for (const key of Object.keys(fieldChoices)) {
    if (key === "updatedAt") continue;
    primaryRestore[key] = snapshot.primary[key] ?? null;
  }
  primaryRestore.updatedAt = new Date();

  const duplicates = snapshot.duplicates.map((d) => reviveDates(d, CONTACT_DATE_FIELDS)) as Array<
    Parameters<typeof contactsRepo.undoMergeTransaction>[0]["duplicates"][number]
  >;
  const customFieldValues = (snapshot.customFieldValues ?? []).map((v) => {
    const revived = reviveDates(v, ["createdAt", "updatedAt"]);
    delete (revived as Record<string, unknown>).id; // let the id re-generate; unique(def,entity) still holds
    return revived;
  }) as Array<Parameters<typeof contactsRepo.undoMergeTransaction>[0]["customFieldValues"][number]>;

  await contactsRepo.undoMergeTransaction({
    historyId,
    primaryId: history.primaryId,
    primaryRestore,
    duplicates,
    childRefs: snapshot.childRefs ?? {},
    customFieldValues,
    undoneById: user.id,
  });

  return { success: true, restoredIds: duplicates.map((d) => d.id) };
}

export interface MergeHistoryParams {
  page?: string;
  limit?: string;
}

// Formal contact merge-history audit trail (tenant-scoped, newest first).
export async function mergeHistory(user: AuthUser, params: MergeHistoryParams) {
  const { page: pageNum, limit: limitNum, offset } = parseListQuery(params, { defaultPageSize: 50, maxPageSize: 200 });
  const { rows, total } = await mergeHistoryRepo.list(user, { entityType: "contact", limit: limitNum, offset });
  const performerIds = [...new Set(rows.map((r) => r.performedById).filter((v): v is number => v != null))];
  const users = await mergeHistoryRepo.usersByIds(performerIds);
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const parseIds = (raw: string): number[] => { try { return JSON.parse(raw); } catch { return []; } };
  const parseObj = (raw: string | null): Record<string, unknown> | null => { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };
  const entries = rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    entityType: r.entityType,
    primaryId: r.primaryId,
    mergedIds: parseIds(r.mergedIds),
    fieldChoices: parseObj(r.fieldChoices),
    performedById: r.performedById ?? null,
    performedByName: r.performedById != null ? (nameById.get(r.performedById) ?? null) : null,
    undoneAt: r.undoneAt ? r.undoneAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
  return { entries, total, page: pageNum, limit: limitNum };
}

// ── Custom-field values (delegates validation/persistence to custom_fields service) ──

export async function getContactCustomFields(user: AuthUser, id: number) {
  const c = await contactsRepo.findById(user, id);
  if (!c) throw new AppError(404, "Contact not found");
  return customFields.getValues(user, "contact", c.companyId, id);
}

export async function setContactCustomFields(user: AuthUser, id: number, body: { values?: Array<{ definitionId?: unknown; value?: unknown }> }) {
  const c = await contactsRepo.findById(user, id);
  if (!c) throw new AppError(404, "Contact not found");
  return customFields.setValues(user, "contact", c.companyId, id, body);
}

export async function getContact(user: AuthUser, id: number) {
  const c = await contactsRepo.findById(user, id);
  if (!c) throw new AppError(404, "Contact not found");
  const { eventName, assignedToName, organizationName } = await namesFor(c);
  return formatContact(c, eventName, assignedToName, organizationName);
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
  city?: string | null;
  postalCode?: string | null;
  linkedin?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: string;
  statusComment?: string | null;
  followUpDate?: string | null;
  followUpTime?: string | null;
  eventId?: number | null;
  assignedToId?: number | null;
  organizationId?: number | null;
  source?: string | null;
}

export async function updateContact(user: AuthUser, id: number, body: UpdateContactInput) {
  const existing = await contactsRepo.findById(user, id);
  if (!existing) throw new AppError(404, "Contact not found");
  const { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, city, postalCode, linkedin, notes, tags, status, statusComment, followUpDate, followUpTime, eventId, assignedToId, organizationId, source } = body;
  if (!(await refAccessible(user, "events", eventId))) throw new AppError(400, "Invalid eventId");
  if (!(await refAccessible(user, "users", assignedToId))) throw new AppError(400, "Invalid assignedToId");
  // Bind to the contact's OWN tenant (existing.companyId), not the caller's scope.
  if (organizationId != null && !(await refInCompany("organizations", existing.companyId, organizationId))) throw new AppError(400, "Invalid organizationId");
  const fullName = firstName !== undefined || lastName !== undefined ? [firstName, lastName].filter(Boolean).join(" ") || null : undefined;
  const updateData: Record<string, unknown> = { firstName, lastName, jobTitle, contactCompany, email, mobile, officePhone, website, country, address, city, postalCode, linkedin, notes, status, followUpDate, followUpTime, eventId, assignedToId, organizationId, source };
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
  const { eventName, assignedToName, organizationName } = await namesFor(c);
  return formatContact(c, eventName, assignedToName, organizationName);
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
    result = await aiEnrichContact(
      {
        firstName: c.firstName, lastName: c.lastName, jobTitle: c.jobTitle,
        contactCompany: c.contactCompany, email: c.email, website: c.website,
        linkedin: c.linkedin, country: c.country, notes: c.notes,
      },
      { companyId: c.companyId, userId: user.id },
    );
  } catch (aiErr) {
    if (aiErr instanceof AppError) throw aiErr;
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

  const { eventName, assignedToName, organizationName } = await namesFor(updated);
  return formatContact(updated, eventName, assignedToName, organizationName);
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
