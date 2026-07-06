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
import { matchExistingContacts, type ContactMatch } from "./contacts.service.js";
import * as orgRepo from "../repositories/organizations.repository.js";
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
    out.push({
      organizationId: o.id,
      name: o.name,
      industry: o.industry,
      website: o.website,
      country: o.country,
      contactCount,
      leadCount,
      matchType,
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
    aiDegraded,
  };
}
