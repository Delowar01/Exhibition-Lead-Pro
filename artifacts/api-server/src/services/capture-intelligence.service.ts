// Stage 5E — Intelligent Capture analysis (READ-ONLY).
//
// Given the fields on a card being captured (NOT yet saved), this produces a review-time
// intelligence bundle: deterministic validation + normalization suggestions, recognition
// of existing contacts/organizations in the tenant, duplicate warnings, and smart
// gap-fill suggestions (deterministic first; optional AI industry classification that
// SOFT-DEGRADES to unavailable). It NEVER writes, links, merges, or auto-applies anything
// — every output is a suggestion the user must accept. Tenant-scoped throughout.

import type { AuthUser } from "../middlewares/requireAuth.js";
import { analyzeCaptureFields, websiteFromEmail, countryFromDialCode, type CaptureFields, type CaptureValidationResult } from "../lib/capture-validation.js";
import { matchExistingContacts, nameSimilarity, type ContactMatch } from "./contacts.service.js";
import * as orgRepo from "../repositories/organizations.repository.js";
import * as eventsRepo from "../repositories/events.repository.js";
import * as scansRepo from "../repositories/scans.repository.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import { normalizeName } from "./organizations.service.js";
import { enrichContact, logAiError } from "../lib/ai.js";
import { resolveSettings } from "./ai.service.js";
import { PROMPTS } from "../ai/prompts.js";

export interface OrganizationMatch {
  organizationId: number;
  name: string;
  industry: string | null;
  website: string | null;
  country: string | null;
  contactCount: number;
  leadCount: number;
  matchType: "exact" | "partial";
  // Stage 5E relationship intelligence — live tenant CRM data, deterministic.
  /** Distinct events (exhibitions) where contacts of this org were captured. */
  eventCount: number;
  /** Up to 3 most recent of those event names. */
  recentEvents: string[];
  /** Human-readable one-line relationship summary derived from the counts above. */
  relationshipSummary: string;
}

// Stage 5E similar-record warning (advisory only — never blocks or merges).
export interface SimilarWarning {
  kind: "similar_company" | "similar_email" | "similar_phone" | "duplicate_card";
  message: string;
  /** 0-100 deterministic similarity confidence. */
  confidence: number;
  /** The matched CRM contact (for contact-level warnings), when applicable. */
  contactId?: number | null;
  /** The matched prior scan (for duplicate_card), when applicable. */
  scanId?: number | null;
}

export interface SmartSuggestion {
  field: string;
  suggested: string;
  reason: string;
  source: "deterministic" | "ai";
  // Provenance for AI-sourced suggestions (null for deterministic ones).
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
}

export interface CaptureAnalysis {
  validation: CaptureValidationResult;
  contactMatches: ContactMatch[];
  organizationMatches: OrganizationMatch[];
  duplicateWarning: {
    isLikelyDuplicate: boolean;
    topMatchConfidence: number;
    message: string | null;
  };
  suggestions: SmartSuggestion[];
  // Stage 5E: advisory similar-record warnings (similar company/email/phone in the CRM,
  // or the same card apparently scanned before). Never blocks, never auto-merges.
  similarWarnings: SimilarWarning[];
  // Stage 5E honesty surface: gap fields we looked at but could NOT ground a suggestion
  // for — the UI shows "Not enough information" instead of a fabricated value.
  insufficient: string[];
  // True when an AI-backed suggestion was attempted but the provider was
  // unavailable/failed — the deterministic results are still valid.
  aiDegraded: boolean;
}

// Match existing CRM organizations by name: exact normalized-name match first, then
// partial (ilike) matches. Enriched with live contact/lead counts. Tenant-scoped.
async function matchOrganizations(user: AuthUser, company: string | null | undefined): Promise<OrganizationMatch[]> {
  const name = (company ?? "").trim();
  if (!user.companyId || name.length < 2) return [];

  const normalized = normalizeName(name);
  const exact = await orgRepo.findByNormalizedName(user.companyId, normalized);

  const { rows } = await orgRepo.list(user, { search: name, limit: 5, offset: 0 });
  const seen = new Set<number>();
  const out: OrganizationMatch[] = [];

  const pushRow = async (o: orgRepo.OrganizationRow, matchType: "exact" | "partial") => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    const { contactCount, leadCount } = await orgRepo.counts(o.id);
    // Relationship intelligence: distinct events where this org's contacts were captured
    // (transitive via contacts.eventId — tenant-scoped), newest first for display.
    const evIds = await orgRepo.eventIds(user, o.id);
    let recentEvents: string[] = [];
    if (evIds.length > 0) {
      const evs = await eventsRepo.listByIds(user, evIds);
      recentEvents = evs
        .slice()
        .sort((a, b) => new Date(b.startDate ?? b.createdAt).getTime() - new Date(a.startDate ?? a.createdAt).getTime())
        .slice(0, 3)
        .map((e) => e.name);
    }
    const parts: string[] = [];
    parts.push(contactCount === 1 ? "1 contact" : `${contactCount} contacts`);
    if (leadCount > 0) parts.push(leadCount === 1 ? "1 lead" : `${leadCount} leads`);
    if (evIds.length > 0) parts.push(evIds.length === 1 ? "met at 1 event" : `met at ${evIds.length} events`);
    const relationshipSummary = `Known company in your CRM: ${parts.join(", ")}${recentEvents.length > 0 ? ` (latest: ${recentEvents[0]})` : ""}.`;
    out.push({
      organizationId: o.id,
      name: o.name,
      industry: o.industry,
      website: o.website,
      country: o.country,
      contactCount,
      leadCount,
      matchType,
      eventCount: evIds.length,
      recentEvents,
      relationshipSummary,
    });
  };

  if (exact) await pushRow(exact, "exact");
  for (const o of rows) await pushRow(o, o.normalizedName === normalized ? "exact" : "partial");
  return out.slice(0, 5);
}

// Deterministic gap-fill suggestions: only propose a value for a field that is EMPTY,
// derived from another present field. Never overwrites an existing value; never guesses.
function deterministicSuggestions(fields: CaptureFields): SmartSuggestion[] {
  const out: SmartSuggestion[] = [];
  const has = (v: string | null | undefined) => v != null && String(v).trim().length > 0;

  if (!has(fields.website)) {
    const w = websiteFromEmail(fields.email);
    if (w) out.push({ field: "website", suggested: w, reason: "Derived from the email domain", source: "deterministic" });
  }
  if (!has(fields.country)) {
    const c = countryFromDialCode(fields.mobile) ?? countryFromDialCode(fields.officePhone);
    if (c) out.push({ field: "country", suggested: c, reason: "Derived from the phone dial code", source: "deterministic" });
  }
  return out;
}

// Optional AI industry classification for the organization — SOFT-DEGRADES: on any
// provider failure/unavailability it returns null and marks the analysis degraded, never
// throwing. Only suggested when we have enough grounding (a company name) and industry
// is not already present. Carries full provenance.
async function aiIndustrySuggestion(
  user: AuthUser,
  fields: CaptureFields,
): Promise<{ suggestion: SmartSuggestion | null; degraded: boolean }> {
  const company = (fields.company ?? "").trim();
  const has = (v: string | null | undefined) => v != null && String(v).trim().length > 0;
  // Only attempt when grounded by a company name and no explicit industry provided.
  if (company.length < 2 || has((fields as { industry?: string | null }).industry)) {
    return { suggestion: null, degraded: false };
  }
  try {
    const result = await enrichContact(
      {
        firstName: fields.firstName ?? null,
        lastName: fields.lastName ?? null,
        jobTitle: fields.jobTitle ?? null,
        contactCompany: fields.company ?? null,
        email: fields.email ?? null,
        website: fields.website ?? null,
        linkedin: fields.linkedin ?? null,
        country: fields.country ?? null,
      },
      { companyId: user.companyId ?? undefined, userId: user.id },
    );
    if (!result.industry) return { suggestion: null, degraded: false };
    // Stamp the REAL runtime provider/model (the effective tenant ai_settings, i.e. what
    // GET /ai/settings reports) rather than a hardcoded placeholder, so provenance is honest.
    let provider: string | null = null;
    let model: string | null = null;
    if (user.companyId != null) {
      try {
        const settings = await resolveSettings(user.companyId);
        provider = settings.provider;
        model = settings.model;
      } catch {
        /* provenance best-effort; suggestion still valid */
      }
    }
    return {
      suggestion: {
        field: "industry",
        suggested: result.industry,
        reason: "AI industry classification (review before saving)",
        source: "ai",
        provider,
        model,
        promptKey: PROMPTS.contact_enrichment.key,
        promptVersion: PROMPTS.contact_enrichment.version,
      },
      degraded: false,
    };
  } catch (err) {
    logAiError("capture-industry", err);
    return { suggestion: null, degraded: true };
  }
}

// ── Stage 5E similar-record detection (deterministic, tenant-scoped, advisory) ──

const normE = (v: string | null | undefined) => {
  const t = (v ?? "").trim().toLowerCase();
  return t.includes("@") ? t : null;
};
const normP = (v: string | null | undefined) => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d : null;
};

// Similar (not identical) emails/phones/companies among existing tenant contacts,
// plus "this card was already scanned" detection against recent completed scans.
async function detectSimilarWarnings(
  user: AuthUser,
  fields: CaptureFields,
  contactMatches: ContactMatch[],
): Promise<SimilarWarning[]> {
  if (!user.companyId) return [];
  const out: SimilarWarning[] = [];
  const exactIds = new Set(contactMatches.map((m) => m.contactId));

  const email = normE(fields.email);
  const phones = [normP(fields.mobile), normP(fields.officePhone)].filter((p): p is string => p != null);
  const company = (fields.company ?? "").trim().toLowerCase().replace(/\s+/g, " ");

  const [candidates, recentScans] = await Promise.all([
    contactsRepo.originalCandidates(user.companyId, -1),
    email || phones.length > 0 ? scansRepo.recentCompleted(user, 200) : Promise.resolve([]),
  ]);

  let companyHit: SimilarWarning | null = null;
  let emailHit: SimilarWarning | null = null;
  let phoneHit: SimilarWarning | null = null;

  for (const c of candidates) {
    // Similar company name (fuzzy, not exact — exact is already an organization match).
    if (!companyHit && company.length >= 3 && c.contactCompany) {
      const cc = c.contactCompany.trim().toLowerCase().replace(/\s+/g, " ");
      if (cc !== company) {
        const sim = nameSimilarity(company, cc);
        if (sim >= 0.85) {
          companyHit = {
            kind: "similar_company",
            message: `Company name is very similar to "${c.contactCompany}" already in your CRM — check for a spelling variant before creating a new company.`,
            confidence: Math.round(sim * 100),
            contactId: c.id,
          };
        }
      }
    }
    // Similar email: same mailbox (local part) at a different domain, or a near-identical address.
    if (!emailHit && email && c.email) {
      const ce = c.email.trim().toLowerCase();
      if (ce !== email && !exactIds.has(c.id)) {
        const [lp, dom] = email.split("@");
        const [clp, cdom] = ce.split("@");
        const sameMailbox = lp.length >= 3 && lp === clp && dom !== cdom;
        const near = nameSimilarity(email, ce) >= 0.9;
        if (sameMailbox || near) {
          emailHit = {
            kind: "similar_email",
            message: `Email is similar to ${ce}${c.fullName ? ` (${c.fullName})` : ""} in your CRM — verify it isn't the same person.`,
            confidence: sameMailbox ? 80 : Math.round(nameSimilarity(email, ce) * 100),
            contactId: c.id,
          };
        }
      }
    }
    // Similar phone: same last-7 digits but not the same full number.
    if (!phoneHit && phones.length > 0 && !exactIds.has(c.id)) {
      for (const cp of [normP(c.mobile), normP(c.officePhone)]) {
        if (!cp) continue;
        for (const p of phones) {
          if (p !== cp && p.slice(-7) === cp.slice(-7)) {
            phoneHit = {
              kind: "similar_phone",
              message: `Phone number is similar to one on ${c.fullName ?? "an existing contact"} in your CRM — verify it isn't the same person.`,
              confidence: 75,
              contactId: c.id,
            };
          }
        }
      }
    }
    if (companyHit && emailHit && phoneHit) break;
  }
  for (const w of [companyHit, emailHit, phoneHit]) if (w) out.push(w);

  // Duplicate business card: a prior completed scan already extracted the same
  // email or phone. Advisory only — the user decides what to do.
  if (email || phones.length > 0) {
    for (const s of recentScans) {
      if (!s.extractedData) continue;
      try {
        const d = JSON.parse(s.extractedData) as Record<string, unknown>;
        const se = normE(typeof d.email === "string" ? d.email : null);
        const sm = normP(typeof d.mobile === "string" ? d.mobile : null);
        if ((email && se && se === email) || (phones.length > 0 && sm && phones.some((p) => p.slice(-7) === sm.slice(-7)))) {
          out.push({
            kind: "duplicate_card",
            message: `This card appears to have been scanned before (scan #${s.id}). Review before saving to avoid a duplicate.`,
            confidence: email && se === email ? 95 : 85,
            scanId: s.id,
          });
          break;
        }
      } catch {
        /* unparseable legacy row — skip */
      }
    }
  }
  return out;
}

// Gap fields we actively try to fill: when neither a value nor a grounded suggestion
// exists, report the field as "insufficient" so the UI says "Not enough information"
// instead of showing nothing (or worse, a guess).
function insufficientFields(fields: CaptureFields, suggestions: SmartSuggestion[]): string[] {
  const has = (v: string | null | undefined) => v != null && String(v).trim().length > 0;
  const suggested = new Set(suggestions.map((s) => s.field));
  const out: string[] = [];
  for (const f of ["website", "country", "industry"] as const) {
    const val = f === "industry" ? (fields as { industry?: string | null }).industry : fields[f];
    if (!has(val) && !suggested.has(f)) out.push(f);
  }
  return out;
}

export interface AnalyzeCaptureOptions {
  /** When false, skips the best-effort AI industry classification (pure deterministic). */
  includeAi?: boolean;
}

export async function analyzeCapture(
  user: AuthUser,
  fields: CaptureFields,
  opts: AnalyzeCaptureOptions = {},
): Promise<CaptureAnalysis> {
  const validation = analyzeCaptureFields(fields);

  const [contactMatches, organizationMatches] = await Promise.all([
    matchExistingContacts(user, {
      email: fields.email,
      mobile: fields.mobile,
      officePhone: fields.officePhone,
      firstName: fields.firstName,
      lastName: fields.lastName,
      contactCompany: fields.company,
      website: fields.website,
      linkedin: fields.linkedin,
    }),
    matchOrganizations(user, fields.company),
  ]);

  const suggestions = deterministicSuggestions(fields);
  let aiDegraded = false;
  if (opts.includeAi !== false) {
    const ai = await aiIndustrySuggestion(user, fields);
    if (ai.suggestion) suggestions.push(ai.suggestion);
    aiDegraded = ai.degraded;
  }

  const similarWarnings = await detectSimilarWarnings(user, fields, contactMatches);
  const insufficient = insufficientFields(fields, suggestions);

  const top = contactMatches[0];
  const topMatchConfidence = top ? top.confidence : 0;
  const isLikelyDuplicate = topMatchConfidence >= 85;

  return {
    validation,
    contactMatches,
    organizationMatches,
    duplicateWarning: {
      isLikelyDuplicate,
      topMatchConfidence,
      message: isLikelyDuplicate && top
        ? `This looks like an existing contact${top.fullName ? ` (${top.fullName})` : ""}. Review before saving to avoid a duplicate.`
        : null,
    },
    suggestions,
    similarWarnings,
    insufficient,
    aiDegraded,
  };
}
