import { logger } from "./logger.js";
import { config } from "../config.js";
import { getProvider } from "../ai/providers/index.js";
import { runAi, extractJson, isTimeoutError, redactError } from "../ai/runner.js";
import { estimateCostMicroUsd } from "../ai/pricing.js";
import {
  PROMPTS,
  buildExtractionPrompt,
  SCORING_PROMPT,
  ENRICHMENT_PROMPT,
  ASSIGNEE_PROMPT,
  LEAD_INTELLIGENCE_PROMPT,
  COMPANY_INTELLIGENCE_PROMPT,
  CONTACT_INTELLIGENCE_PROMPT,
  SMART_CLASSIFICATION_PROMPT,
  OPPORTUNITY_POTENTIAL_PROMPT,
  buildEmailPrompt,
  buildWhatsappPrompt,
  CALL_PREPARATION_PROMPT,
  MEETING_PREPARATION_PROMPT,
  buildProposalPrompt,
  buildFollowupPrompt,
  SALES_COACHING_PROMPT,
  CONVERSATION_SUMMARY_PROMPT,
  buildWorkflowNextActionPrompt,
  buildWorkflowRoutingPrompt,
  buildWorkflowProgressionPrompt,
  buildWorkflowReminderPrompt,
  buildWorkflowTaskPrompt,
  buildExecutiveSummaryPrompt,
  buildExecutiveForecastPrompt,
} from "../ai/prompts.js";
import type { AiFeature, AiPart, AiRequest } from "../ai/types.js";
import * as aiService from "../services/ai.service.js";

// Feature-level AI functions (OCR extraction, lead scoring, enrichment, assignee
// recommendation). Since Stage 5.0 these route through the provider-agnostic
// abstraction (src/ai/): a shared runner applies timeout + retry + JSON validation,
// and every call is recorded to the ai_invocations ledger with token usage, estimated
// cost, latency, status, and prompt version. An optional `ctx` (companyId + userId)
// wires each call to its tenant so usage is attributed AND the per-tenant enabled/
// feature-flag/budget gates are enforced (a no-op for tenants at default settings, so
// existing behavior is preserved exactly).

export type { AppLanguage } from "../ai/prompts.js";
import type { AppLanguage } from "../ai/prompts.js";

const EXTRACTION_TIMEOUT_MS = config.ai.extractionTimeoutMs;
const SCORING_TIMEOUT_MS = config.ai.scoringTimeoutMs;

// Tenant/user context threaded from the calling service so invocations are attributed
// and the per-tenant AI gates apply. Omit for system/back-compat calls (no enforcement,
// ledger row recorded with a null company).
export interface AiContext {
  companyId?: number | null;
  userId?: number | null;
}

export interface ExtractedCardOriginal {
  firstName: string | null;
  lastName: string | null;
  arabicName: string | null;
  jobTitle: string | null;
  company: string | null;
  email: string | null;
  mobile: string | null;
  website: string | null;
  linkedin: string | null;
  address: string | null;
}

export interface ExtractedCardData {
  firstName: string | null;
  lastName: string | null;
  arabicName: string | null;
  jobTitle: string | null;
  company: string | null;
  email: string | null;
  mobile: string | null;
  website: string | null;
  linkedin: string | null;
  address: string | null;
  /** Raw OCR values exactly as printed — never translated/overwritten. */
  original: ExtractedCardOriginal;
}

export interface CardExtractionResult {
  fields: ExtractedCardData;
  confidence: number;
  rawOcr: string;
  /** Per-field OCR confidence (0-100) for the display fields, when the model reports it. */
  fieldConfidences: Record<string, number>;
  /** How the data was extracted — always "ai_vision" from this Gemini path. */
  extractionMethod: string;
  /** Provenance: the model that produced the extraction (as reported by the provider). */
  model: string;
  /** Provenance: the extraction prompt version recorded on the scan. */
  promptVersion: number;
  /** OCR round-trip latency in ms. */
  processingTimeMs: number;
}

export interface LeadScoreResult {
  score: number;
  temperature: "hot" | "warm" | "cold";
  reasoning: string;
}

export interface LeadScoreInput {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  contactCompany?: string | null;
  email?: string | null;
  mobile?: string | null;
  website?: string | null;
  linkedin?: string | null;
  country?: string | null;
  notes?: string | null;
}

const EMPTY_ORIGINAL: ExtractedCardOriginal = {
  firstName: null,
  lastName: null,
  arabicName: null,
  jobTitle: null,
  company: null,
  email: null,
  mobile: null,
  website: null,
  linkedin: null,
  address: null,
};

const EMPTY_FIELDS: ExtractedCardData = {
  ...EMPTY_ORIGINAL,
  original: { ...EMPTY_ORIGINAL },
};

function parseImage(imageData: string): { data: string; mimeType: string } {
  const match = /^data:(.+?);base64,(.*)$/s.exec(imageData.trim());
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: "image/jpeg", data: imageData.trim() };
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 && t.toLowerCase() !== "null" ? t : null;
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readOriginal(value: unknown): ExtractedCardOriginal {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    firstName: str(o.firstName),
    lastName: str(o.lastName),
    arabicName: str(o.arabicName),
    jobTitle: str(o.jobTitle),
    company: str(o.company),
    email: str(o.email),
    mobile: str(o.mobile),
    website: str(o.website),
    linkedin: str(o.linkedin),
    address: str(o.address),
  };
}

// Central execution seam for all JSON-returning AI features: enforces the per-tenant
// gates (when ctx has a company), runs the provider call through the shared runner,
// parses JSON, and records the invocation to the ledger (fire-and-forget; never blocks
// or fails the result path). Enforcement errors are thrown BEFORE any provider call and
// are not recorded as failed invocations.
export interface CallJsonMeta {
  parsed: Record<string, unknown>;
  provider: string;
  model: string;
  latencyMs: number;
  promptVersion: number;
}

async function callJson(opts: {
  feature: AiFeature;
  parts: AiPart[];
  timeoutMs: number;
  ctx?: AiContext;
  confidenceOf?: (parsed: Record<string, unknown>) => number | null;
}): Promise<Record<string, unknown>> {
  return (await callJsonWithMeta(opts)).parsed;
}

// Same execution seam as callJson but also returns the runtime provenance (provider, the
// model the provider actually used, latency, prompt version) so metadata-carrying features
// (e.g. OCR capture) can persist honest provenance without a second resolve/DB read.
async function callJsonWithMeta(opts: {
  feature: AiFeature;
  parts: AiPart[];
  timeoutMs: number;
  ctx?: AiContext;
  confidenceOf?: (parsed: Record<string, unknown>) => number | null;
}): Promise<CallJsonMeta> {
  const prompt = PROMPTS[opts.feature];

  // Provider/model resolution: a tenant's effective ai_settings (validated on write to
  // an available provider + non-empty model) win when there is company context; system
  // calls with no tenant fall back to the platform default. This keeps runtime execution
  // consistent with what GET /ai/settings and GET /ai/health report. resolveSettings and
  // ensureAiAllowed share the same in-process cache, so this is not an extra DB read.
  let providerName: string = config.ai.provider;
  let model: string = config.ai.model;
  if (opts.ctx?.companyId != null) {
    await aiService.ensureAiAllowed(opts.ctx.companyId, opts.feature);
    const settings = await aiService.resolveSettings(opts.ctx.companyId);
    providerName = settings.provider;
    model = settings.model;
  }
  const provider = getProvider(providerName);

  const req: AiRequest = {
    model,
    parts: opts.parts,
    responseFormat: "json",
    maxOutputTokens: config.ai.maxOutputTokens,
    // gemini-2.5-flash runs "thinking" ON by default (5-15s latency); 0 disables it —
    // a pure speedup for OCR/structured extraction with no measurable quality loss.
    thinkingBudget: config.ai.thinkingBudget,
    timeoutMs: opts.timeoutMs,
  };

  const start = Date.now();
  try {
    const result = await runAi(provider, req, {
      retries: config.ai.maxRetries,
      backoffMs: config.ai.retryBackoffMs,
    });
    const latencyMs = Date.now() - start;
    const parsed = extractJson(result.text) as Record<string, unknown>;
    void aiService.recordInvocation({
      ctx: opts.ctx,
      feature: opts.feature,
      provider: provider.name,
      model: result.model,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      status: "success",
      usage: result.usage,
      costMicroUsd: estimateCostMicroUsd(result.model, result.usage.inputTokens, result.usage.outputTokens),
      latencyMs,
      confidence: opts.confidenceOf ? opts.confidenceOf(parsed) : null,
    });
    return { parsed, provider: provider.name, model: result.model, latencyMs, promptVersion: prompt.version };
  } catch (err) {
    const latencyMs = Date.now() - start;
    void aiService.recordInvocation({
      ctx: opts.ctx,
      feature: opts.feature,
      provider: provider.name,
      model,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      status: isTimeoutError(err) ? "timeout" : "error",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costMicroUsd: 0,
      latencyMs,
      errorMessage: redactError(err),
    });
    throw err;
  }
}

export async function extractCardData(
  imageData: string,
  appLanguage: AppLanguage = "en",
  ctx?: AiContext,
): Promise<CardExtractionResult> {
  const { data, mimeType } = parseImage(imageData);
  if (!data || data.length < 100 || !/^image\//.test(mimeType)) {
    throw new Error("imageData is not a valid image payload");
  }

  const meta = await callJsonWithMeta({
    feature: "card_extraction",
    parts: [{ text: buildExtractionPrompt(appLanguage) }, { inlineData: { mimeType, data } }],
    timeoutMs: EXTRACTION_TIMEOUT_MS,
    ctx,
    confidenceOf: (p) => clampScore(p.confidence),
  });
  const parsed = meta.parsed;

  const display = {
    firstName: str(parsed.firstName),
    lastName: str(parsed.lastName),
    arabicName: str(parsed.arabicName),
    jobTitle: str(parsed.jobTitle),
    company: str(parsed.company),
    email: str(parsed.email),
    mobile: str(parsed.mobile),
    website: str(parsed.website),
    linkedin: str(parsed.linkedin),
    address: str(parsed.address),
  };
  // Original = text exactly as printed on the card. For translatable text fields
  // (name, job title, company, address) we must NOT fall back to `display` when the
  // model omits the original — `display` may be a translation, and copying it would
  // silently store translated text as if it were the verbatim capture. Leave those
  // null instead. Contact identifiers (email/mobile/website/linkedin) and the
  // Arabic-script name are never translated, so falling back to display is lossless.
  const originalRaw = readOriginal(parsed.original);
  const original: ExtractedCardOriginal = {
    firstName: originalRaw.firstName,
    lastName: originalRaw.lastName,
    arabicName: originalRaw.arabicName ?? display.arabicName,
    jobTitle: originalRaw.jobTitle,
    company: originalRaw.company,
    email: originalRaw.email ?? display.email,
    mobile: originalRaw.mobile ?? display.mobile,
    website: originalRaw.website ?? display.website,
    linkedin: originalRaw.linkedin ?? display.linkedin,
    address: originalRaw.address,
  };

  // Per-field confidence: the model MAY report a "fieldConfidences" map (prompt v2).
  // We read only the display-field keys and clamp each to 0-100; a field the model does
  // not score is simply omitted (the UI treats a missing per-field score as "use the
  // overall confidence"). This never fabricates a score — absent input means absent output.
  const fieldConfidences: Record<string, number> = {};
  const rawFieldConf = (parsed.fieldConfidences && typeof parsed.fieldConfidences === "object")
    ? (parsed.fieldConfidences as Record<string, unknown>)
    : {};
  for (const key of Object.keys(display) as (keyof typeof display)[]) {
    const v = rawFieldConf[key];
    if (v != null && Number.isFinite(Number(v))) fieldConfidences[key] = clampScore(v);
  }

  return {
    fields: { ...display, original },
    confidence: clampScore(parsed.confidence),
    rawOcr: str(parsed.rawText) ?? "",
    fieldConfidences,
    extractionMethod: "ai_vision",
    model: meta.model,
    promptVersion: meta.promptVersion,
    processingTimeMs: meta.latencyMs,
  };
}

export async function scoreLead(
  input: LeadScoreInput,
  eventName?: string | null,
  ctx?: AiContext,
): Promise<LeadScoreResult> {
  const lines = [
    `Name: ${[input.firstName, input.lastName].filter(Boolean).join(" ") || "(unknown)"}`,
    `Job title: ${input.jobTitle ?? "(unknown)"}`,
    `Company: ${input.contactCompany ?? "(unknown)"}`,
    `Email: ${input.email ?? "(none)"}`,
    `Mobile: ${input.mobile ?? "(none)"}`,
    `Website: ${input.website ?? "(none)"}`,
    `LinkedIn: ${input.linkedin ?? "(none)"}`,
    `Country: ${input.country ?? "(unknown)"}`,
    `Captured at event: ${eventName ?? "(unspecified)"}`,
    `Notes: ${input.notes ?? "(none)"}`,
  ].join("\n");

  const parsed = await callJson({
    feature: "lead_scoring",
    parts: [{ text: `${SCORING_PROMPT}\n\nLead:\n${lines}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
    confidenceOf: (p) => clampScore(p.score),
  });

  const score = clampScore(parsed.score);
  let temperature = str(parsed.temperature)?.toLowerCase();
  if (temperature !== "hot" && temperature !== "warm" && temperature !== "cold") {
    temperature = score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";
  }

  return {
    score,
    temperature: temperature as LeadScoreResult["temperature"],
    reasoning: str(parsed.reasoning) ?? "",
  };
}

export interface EnrichmentInput {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  contactCompany?: string | null;
  email?: string | null;
  website?: string | null;
  linkedin?: string | null;
  country?: string | null;
  notes?: string | null;
}

export interface EnrichmentResult {
  industry: string | null;
  seniority: string | null;
  summary: string | null;
  talkingPoints: string[];
}

export async function enrichContact(input: EnrichmentInput, ctx?: AiContext): Promise<EnrichmentResult> {
  const lines = [
    `Name: ${[input.firstName, input.lastName].filter(Boolean).join(" ") || "(unknown)"}`,
    `Job title: ${input.jobTitle ?? "(unknown)"}`,
    `Company: ${input.contactCompany ?? "(unknown)"}`,
    `Email: ${input.email ?? "(none)"}`,
    `Website: ${input.website ?? "(none)"}`,
    `LinkedIn: ${input.linkedin ?? "(none)"}`,
    `Country: ${input.country ?? "(unknown)"}`,
    `Notes: ${input.notes ?? "(none)"}`,
  ].join("\n");

  const parsed = await callJson({
    feature: "contact_enrichment",
    parts: [{ text: `${ENRICHMENT_PROMPT}\n\nContact:\n${lines}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
  });

  const seniorityRaw = str(parsed.seniority);
  const allowedSeniority = ["C-Level", "VP", "Director", "Manager", "Individual Contributor"];
  const seniority = seniorityRaw && allowedSeniority.some((s) => s.toLowerCase() === seniorityRaw.toLowerCase())
    ? allowedSeniority.find((s) => s.toLowerCase() === seniorityRaw.toLowerCase())!
    : null;

  const talkingPoints = Array.isArray(parsed.talkingPoints)
    ? parsed.talkingPoints.map(str).filter((p): p is string => p !== null).slice(0, 4)
    : [];

  return {
    industry: str(parsed.industry),
    seniority,
    summary: str(parsed.summary),
    talkingPoints,
  };
}

export interface AssigneeCandidate {
  id: number;
  name: string;
  jobTitle?: string | null;
  openLeads: number;
}

export interface AssigneeRecommendationInput {
  contactName?: string | null;
  contactCompany?: string | null;
  jobTitle?: string | null;
  industry?: string | null;
  country?: string | null;
  value?: number | null;
  notes?: string | null;
}

export interface AssigneeRecommendation {
  userId: number;
  reasoning: string;
}

// AI-recommended lead owner. Given the lead and a list of candidate reps (with
// their current open-lead load), returns the chosen candidate id + reasoning.
// Callers must validate the returned userId against their candidate list and fall
// back to a deterministic rule (e.g. least-loaded) if the AI call fails.
export async function recommendAssignee(
  lead: AssigneeRecommendationInput,
  candidates: AssigneeCandidate[],
  ctx?: AiContext,
): Promise<AssigneeRecommendation> {
  const leadLines = [
    `Contact: ${lead.contactName ?? "(unknown)"}`,
    `Company: ${lead.contactCompany ?? "(unknown)"}`,
    `Job title: ${lead.jobTitle ?? "(unknown)"}`,
    `Industry: ${lead.industry ?? "(unknown)"}`,
    `Country: ${lead.country ?? "(unknown)"}`,
    `Deal value: ${lead.value != null ? lead.value : "(unknown)"}`,
    `Notes: ${lead.notes ?? "(none)"}`,
  ].join("\n");
  const candLines = candidates
    .map((c) => `- id ${c.id}: ${c.name}${c.jobTitle ? ` (${c.jobTitle})` : ""} — ${c.openLeads} open leads`)
    .join("\n");

  const parsed = await callJson({
    feature: "assignee_recommendation",
    parts: [{ text: `${ASSIGNEE_PROMPT}\n\nLead:\n${leadLines}\n\nCandidates:\n${candLines}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
  });

  const idNum = typeof parsed.userId === "number" ? parsed.userId : Number(parsed.userId);
  const userId = Number.isFinite(idNum) ? Math.round(idNum) : candidates[0].id;
  return { userId, reasoning: str(parsed.reasoning) ?? "" };
}

// ── Stage 5A — Enterprise AI Intelligence runners ─────────────────────────────
//
// Each runner takes a CRM-data-only `context` string (assembled by the caller from
// records ALREADY stored in the tenant) and routes through the same gated callJson
// seam as the foundation features — so per-tenant enable/feature-flag/budget gates and
// the ai_invocations ledger apply automatically. Every result carries confidence, an
// insufficientData flag, and grounded reasoning; the shared prompt instructs the model
// to return "Not enough information" (low confidence + insufficientData) rather than
// guess. Callers never auto-write these into CRM fields — they are reviewable
// suggestions persisted in ai_insights.

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function pick(value: unknown, allowed: string[], fallback: string): string {
  const s = str(value);
  if (!s) return fallback;
  return allowed.find((a) => a.toLowerCase() === s.toLowerCase()) ?? fallback;
}

function strArr(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.map(str).filter((x): x is string => x !== null).slice(0, max)
    : [];
}

export interface IntelligenceMeta {
  confidence: number;
  insufficientData: boolean;
  reasoning: string;
}

export interface LeadIntelligenceResult extends IntelligenceMeta {
  score: number;
  quality: "Excellent" | "Good" | "Average" | "Low" | "Spam";
  buyingPotential: "High" | "Medium" | "Low";
  followUpPriority: "Urgent" | "High" | "Normal" | "Low";
}

export interface CompanyIntelligenceResult extends IntelligenceMeta {
  summary: string | null;
  industry: string | null;
  sizeSignal: string | null;
  engagementLevel: "Hot" | "Active" | "Warm" | "Dormant";
  keyContacts: string[];
  suggestedActions: string[];
}

export interface ContactIntelligenceResult extends IntelligenceMeta {
  summary: string | null;
  seniority: string | null;
  decisionMakerLikelihood: "High" | "Medium" | "Low";
  talkingPoints: string[];
  suggestedActions: string[];
}

export interface SmartClassificationResult extends IntelligenceMeta {
  industry: string | null;
  segment: "Enterprise" | "Mid-Market" | "SMB" | "Startup" | "Unknown";
  businessType: "B2B" | "B2C" | "B2G" | "Unknown";
  productInterest: string[];
  exhibitionCategory: string | null;
}

export interface OpportunityPotentialResult extends IntelligenceMeta {
  conversionProbability: number;
  revenuePotential: "High" | "Medium" | "Low" | "Unknown";
  opportunityRating: "A" | "B" | "C" | "D";
  followUpUrgency: "Immediate" | "This week" | "This month" | "Low";
}

async function runIntelligence(
  feature: AiFeature,
  promptText: string,
  context: string,
  ctx?: AiContext,
): Promise<Record<string, unknown>> {
  return callJson({
    feature,
    parts: [{ text: `${promptText}\n\nCRM data:\n${context}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
    confidenceOf: (p) => clampScore(p.confidence),
  });
}

export async function analyzeLeadIntelligence(context: string, ctx?: AiContext): Promise<LeadIntelligenceResult> {
  const p = await runIntelligence("lead_intelligence", LEAD_INTELLIGENCE_PROMPT, context, ctx);
  return {
    score: clampScore(p.score),
    quality: pick(p.quality, ["Excellent", "Good", "Average", "Low", "Spam"], "Average") as LeadIntelligenceResult["quality"],
    buyingPotential: pick(p.buyingPotential, ["High", "Medium", "Low"], "Low") as LeadIntelligenceResult["buyingPotential"],
    followUpPriority: pick(p.followUpPriority, ["Urgent", "High", "Normal", "Low"], "Normal") as LeadIntelligenceResult["followUpPriority"],
    confidence: clampScore(p.confidence),
    insufficientData: bool(p.insufficientData),
    reasoning: str(p.reasoning) ?? "",
  };
}

export async function analyzeCompanyIntelligence(context: string, ctx?: AiContext): Promise<CompanyIntelligenceResult> {
  const p = await runIntelligence("company_intelligence", COMPANY_INTELLIGENCE_PROMPT, context, ctx);
  return {
    summary: str(p.summary),
    industry: str(p.industry),
    sizeSignal: str(p.sizeSignal),
    engagementLevel: pick(p.engagementLevel, ["Hot", "Active", "Warm", "Dormant"], "Dormant") as CompanyIntelligenceResult["engagementLevel"],
    keyContacts: strArr(p.keyContacts, 3),
    suggestedActions: strArr(p.suggestedActions, 4),
    confidence: clampScore(p.confidence),
    insufficientData: bool(p.insufficientData),
    reasoning: str(p.reasoning) ?? "",
  };
}

export async function analyzeContactIntelligence(context: string, ctx?: AiContext): Promise<ContactIntelligenceResult> {
  const p = await runIntelligence("contact_intelligence", CONTACT_INTELLIGENCE_PROMPT, context, ctx);
  const seniorityRaw = str(p.seniority);
  const allowedSeniority = ["C-Level", "VP", "Director", "Manager", "Individual Contributor"];
  const seniority = seniorityRaw && allowedSeniority.some((s) => s.toLowerCase() === seniorityRaw.toLowerCase())
    ? allowedSeniority.find((s) => s.toLowerCase() === seniorityRaw.toLowerCase())!
    : null;
  return {
    summary: str(p.summary),
    seniority,
    decisionMakerLikelihood: pick(p.decisionMakerLikelihood, ["High", "Medium", "Low"], "Low") as ContactIntelligenceResult["decisionMakerLikelihood"],
    talkingPoints: strArr(p.talkingPoints, 4),
    suggestedActions: strArr(p.suggestedActions, 3),
    confidence: clampScore(p.confidence),
    insufficientData: bool(p.insufficientData),
    reasoning: str(p.reasoning) ?? "",
  };
}

export async function classifyEntity(context: string, ctx?: AiContext): Promise<SmartClassificationResult> {
  const p = await runIntelligence("smart_classification", SMART_CLASSIFICATION_PROMPT, context, ctx);
  return {
    industry: str(p.industry),
    segment: pick(p.segment, ["Enterprise", "Mid-Market", "SMB", "Startup", "Unknown"], "Unknown") as SmartClassificationResult["segment"],
    businessType: pick(p.businessType, ["B2B", "B2C", "B2G", "Unknown"], "Unknown") as SmartClassificationResult["businessType"],
    productInterest: strArr(p.productInterest, 3),
    exhibitionCategory: str(p.exhibitionCategory),
    confidence: clampScore(p.confidence),
    insufficientData: bool(p.insufficientData),
    reasoning: str(p.reasoning) ?? "",
  };
}

export async function analyzeOpportunity(context: string, ctx?: AiContext): Promise<OpportunityPotentialResult> {
  const p = await runIntelligence("opportunity_potential", OPPORTUNITY_POTENTIAL_PROMPT, context, ctx);
  return {
    conversionProbability: clampScore(p.conversionProbability),
    revenuePotential: pick(p.revenuePotential, ["High", "Medium", "Low", "Unknown"], "Unknown") as OpportunityPotentialResult["revenuePotential"],
    opportunityRating: pick(p.opportunityRating, ["A", "B", "C", "D"], "D") as OpportunityPotentialResult["opportunityRating"],
    followUpUrgency: pick(p.followUpUrgency, ["Immediate", "This week", "This month", "Low"], "Low") as OpportunityPotentialResult["followUpUrgency"],
    confidence: clampScore(p.confidence),
    insufficientData: bool(p.insufficientData),
    reasoning: str(p.reasoning) ?? "",
  };
}

// ── Stage 5B — Enterprise AI Sales Copilot generators ─────────────────────────
//
// Each generator takes a CRM-data-ONLY `context` string (assembled by the caller from
// records ALREADY stored in the tenant) and routes through the same gated callJson seam
// as every other feature — so per-tenant enable/feature-flag/budget gates AND the
// ai_invocations ledger apply automatically. Every result carries confidence, an
// insufficientData flag, and grounded reasoning. Callers persist these as REVIEWABLE
// drafts in ai_copilot_outputs; nothing here is ever auto-sent or auto-written to CRM.

export interface CopilotMeta {
  confidence: number;
  insufficientData: boolean;
  reasoning: string;
}

async function runCopilot(feature: AiFeature, promptText: string, context: string, ctx?: AiContext): Promise<Record<string, unknown>> {
  return callJson({
    feature,
    parts: [{ text: `${promptText}\n\nCRM data:\n${context}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
    confidenceOf: (p) => clampScore(p.confidence),
  });
}

function meta(p: Record<string, unknown>): CopilotMeta {
  return {
    confidence: clampScore(p.confidence),
    insufficientData: bool(p.insufficientData),
    reasoning: str(p.reasoning) ?? "",
  };
}

export interface EmailDraftResult extends CopilotMeta {
  subject: string | null;
  body: string | null;
  tone: string | null;
}
export async function composeEmail(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<EmailDraftResult> {
  const p = await runCopilot("email_composer", buildEmailPrompt(appLanguage), context, ctx);
  return { subject: str(p.subject), body: str(p.body), tone: str(p.tone), ...meta(p) };
}

export interface WhatsappDraftResult extends CopilotMeta {
  message: string | null;
}
export async function composeWhatsapp(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<WhatsappDraftResult> {
  const p = await runCopilot("whatsapp_composer", buildWhatsappPrompt(appLanguage), context, ctx);
  return { message: str(p.message), ...meta(p) };
}

export interface CallObjection { objection: string; response: string; }
export interface CallPrepResult extends CopilotMeta {
  objective: string | null;
  talkingPoints: string[];
  questions: string[];
  anticipatedObjections: CallObjection[];
  nextStep: string | null;
}
function objectionArr(value: unknown, max: number): CallObjection[] {
  if (!Array.isArray(value)) return [];
  const out: CallObjection[] = [];
  for (const v of value) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const objection = str(o.objection);
    const response = str(o.response);
    if (objection) out.push({ objection, response: response ?? "" });
    if (out.length >= max) break;
  }
  return out;
}
export async function prepareCall(context: string, ctx?: AiContext): Promise<CallPrepResult> {
  const p = await runCopilot("call_preparation", CALL_PREPARATION_PROMPT, context, ctx);
  return {
    objective: str(p.objective),
    talkingPoints: strArr(p.talkingPoints, 5),
    questions: strArr(p.questions, 5),
    anticipatedObjections: objectionArr(p.anticipatedObjections, 3),
    nextStep: str(p.nextStep),
    ...meta(p),
  };
}

export interface MeetingPrepResult extends CopilotMeta {
  objectives: string[];
  agenda: string[];
  attendeeNotes: string | null;
  materials: string[];
  suggestedDurationMinutes: number | null;
  nextStep: string | null;
}
export async function prepareMeeting(context: string, ctx?: AiContext): Promise<MeetingPrepResult> {
  const p = await runCopilot("meeting_preparation", MEETING_PREPARATION_PROMPT, context, ctx);
  const durRaw = typeof p.suggestedDurationMinutes === "number" ? p.suggestedDurationMinutes : Number(p.suggestedDurationMinutes);
  return {
    objectives: strArr(p.objectives, 4),
    agenda: strArr(p.agenda, 6),
    attendeeNotes: str(p.attendeeNotes),
    materials: strArr(p.materials, 4),
    suggestedDurationMinutes: Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw) : null,
    nextStep: str(p.nextStep),
    ...meta(p),
  };
}

export interface ProposalSection { heading: string; content: string; }
export interface ProposalResult extends CopilotMeta {
  title: string | null;
  executiveSummary: string | null;
  sections: ProposalSection[];
  valueProps: string[];
  pricingNote: string | null;
}
function sectionArr(value: unknown, max: number): ProposalSection[] {
  if (!Array.isArray(value)) return [];
  const out: ProposalSection[] = [];
  for (const v of value) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const heading = str(o.heading);
    const content = str(o.content);
    if (heading || content) out.push({ heading: heading ?? "", content: content ?? "" });
    if (out.length >= max) break;
  }
  return out;
}
export async function draftProposal(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<ProposalResult> {
  const p = await runCopilot("proposal_assistant", buildProposalPrompt(appLanguage), context, ctx);
  return {
    title: str(p.title),
    executiveSummary: str(p.executiveSummary),
    sections: sectionArr(p.sections, 5),
    valueProps: strArr(p.valueProps, 4),
    pricingNote: str(p.pricingNote),
    ...meta(p),
  };
}

export interface FollowupPhrasingResult extends CopilotMeta {
  recommendedAction: string | null;
  draftMessage: string | null;
}
export async function phraseFollowup(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<FollowupPhrasingResult> {
  const p = await runCopilot("followup_suggestions", buildFollowupPrompt(appLanguage), context, ctx);
  return { recommendedAction: str(p.recommendedAction), draftMessage: str(p.draftMessage), ...meta(p) };
}

export interface CoachingResult extends CopilotMeta {
  summary: string | null;
  recommendations: string[];
}
export async function coachDeal(context: string, ctx?: AiContext): Promise<CoachingResult> {
  const p = await runCopilot("sales_coaching", SALES_COACHING_PROMPT, context, ctx);
  return { summary: str(p.summary), recommendations: strArr(p.recommendations, 4), ...meta(p) };
}

export interface ConversationSummaryResult extends CopilotMeta {
  summary: string | null;
  keyTakeaways: string[];
  sentiment: "Positive" | "Neutral" | "Negative" | "Unknown";
  nextSteps: string[];
}
export async function summarizeConversation(context: string, ctx?: AiContext): Promise<ConversationSummaryResult> {
  const p = await runCopilot("conversation_summary", CONVERSATION_SUMMARY_PROMPT, context, ctx);
  return {
    summary: str(p.summary),
    keyTakeaways: strArr(p.keyTakeaways, 4),
    sentiment: pick(p.sentiment, ["Positive", "Neutral", "Negative", "Unknown"], "Unknown") as ConversationSummaryResult["sentiment"],
    nextSteps: strArr(p.nextSteps, 3),
    ...meta(p),
  };
}

// ── Stage 5F — Enterprise AI Workflow Intelligence phrasing runners ───────────
//
// Each PHRASES an advisory workflow recommendation whose decision core has ALREADY been
// computed deterministically by the workflow service and rendered into `context` (which
// includes the "Computed signals" block). The LLM never changes the computed decision —
// it only produces grounded wording. Callers treat these as best-effort: on any failure
// the deterministic core survives (soft-degrade, HTTP 200), and only when the LLM
// succeeds does the recommendation's provenance flip to source="ai". Same gated callJson
// seam as every other feature (per-tenant enable/flag/budget gates + ai_invocations).

async function runWorkflow(feature: AiFeature, promptText: string, context: string, ctx?: AiContext): Promise<Record<string, unknown>> {
  return callJson({
    feature,
    parts: [{ text: `${promptText}\n\nCRM data:\n${context}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
    confidenceOf: (p) => clampScore(p.confidence),
  });
}

export interface WorkflowNextActionResult extends CopilotMeta {
  recommendedAction: string | null;
  rationale: string | null;
}
export async function phraseWorkflowNextAction(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<WorkflowNextActionResult> {
  const p = await runWorkflow("workflow_next_action", buildWorkflowNextActionPrompt(appLanguage), context, ctx);
  return { recommendedAction: str(p.recommendedAction), rationale: str(p.rationale), ...meta(p) };
}

export interface WorkflowRoutingResult extends CopilotMeta {
  recommendation: string | null;
}
export async function phraseWorkflowRouting(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<WorkflowRoutingResult> {
  const p = await runWorkflow("workflow_routing", buildWorkflowRoutingPrompt(appLanguage), context, ctx);
  return { recommendation: str(p.recommendation), ...meta(p) };
}

export interface WorkflowProgressionResult extends CopilotMeta {
  recommendation: string | null;
}
export async function phraseWorkflowProgression(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<WorkflowProgressionResult> {
  const p = await runWorkflow("workflow_progression", buildWorkflowProgressionPrompt(appLanguage), context, ctx);
  return { recommendation: str(p.recommendation), ...meta(p) };
}

export interface WorkflowReminderResult extends CopilotMeta {
  reminderText: string | null;
}
export async function phraseWorkflowReminder(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<WorkflowReminderResult> {
  const p = await runWorkflow("workflow_reminder", buildWorkflowReminderPrompt(appLanguage), context, ctx);
  return { reminderText: str(p.reminderText), ...meta(p) };
}

export interface WorkflowTaskResult extends CopilotMeta {
  taskTitle: string | null;
  taskDescription: string | null;
}
export async function phraseWorkflowTask(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<WorkflowTaskResult> {
  const p = await runWorkflow("workflow_task", buildWorkflowTaskPrompt(appLanguage), context, ctx);
  return { taskTitle: str(p.taskTitle), taskDescription: str(p.taskDescription), ...meta(p) };
}

// ── Stage 5C — Enterprise AI Executive Intelligence phrasing runners ──────────
//
// Each PHRASES an executive briefing whose numeric core (KPIs, health scores, trends,
// forecasts, alerts) has ALREADY been computed deterministically by the executive service
// and rendered into `context` under a "Computed signals" block. The LLM never invents or
// changes numbers. Callers treat these as best-effort: on any failure the deterministic
// core survives (soft-degrade, HTTP 200) and only a successful call flips provenance to
// source="ai". Same gated callJson seam (per-tenant enable/flag/budget + ai_invocations).

async function runExecutive(feature: AiFeature, promptText: string, context: string, ctx?: AiContext): Promise<Record<string, unknown>> {
  return callJson({
    feature,
    parts: [{ text: `${promptText}\n\nComputed signals:\n${context}` }],
    timeoutMs: SCORING_TIMEOUT_MS,
    ctx,
    confidenceOf: (p) => clampScore(p.confidence),
  });
}

export interface ExecutiveSummaryResult extends CopilotMeta {
  headline: string | null;
  narrative: string | null;
  highlights: string[];
  risks: string[];
  recommendations: string[];
}
export async function phraseExecutiveSummary(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<ExecutiveSummaryResult> {
  const p = await runExecutive("executive_summary", buildExecutiveSummaryPrompt(appLanguage), context, ctx);
  return {
    headline: str(p.headline),
    narrative: str(p.narrative),
    highlights: strArr(p.highlights, 4),
    risks: strArr(p.risks, 4),
    recommendations: strArr(p.recommendations, 4),
    ...meta(p),
  };
}

export interface ExecutiveForecastResult extends CopilotMeta {
  narrative: string | null;
  watchouts: string[];
}
export async function phraseExecutiveForecast(context: string, appLanguage: AppLanguage = "en", ctx?: AiContext): Promise<ExecutiveForecastResult> {
  const p = await runExecutive("executive_forecast", buildExecutiveForecastPrompt(appLanguage), context, ctx);
  return { narrative: str(p.narrative), watchouts: strArr(p.watchouts, 3), ...meta(p) };
}

export function logAiError(context: string, err: unknown): void {
  logger.error({ err, context }, "AI request failed");
}

// Retained for back-compat with any importer that referenced the empty-fields shape.
export { EMPTY_FIELDS };
