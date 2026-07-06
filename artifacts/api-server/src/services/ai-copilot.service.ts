import { db, contactsTable, leadsTable, organizationsTable, eventsTable, scansTable } from "@workspace/db";
import type { AiCopilotOutput, Contact, Lead, Organization, Scan } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { canAccessCompany } from "../middlewares/requireAuth.js";
import { PROMPTS } from "../ai/prompts.js";
import type { AppLanguage } from "../ai/prompts.js";
import {
  composeEmail,
  composeWhatsapp,
  prepareCall,
  prepareMeeting,
  draftProposal,
  phraseFollowup,
  coachDeal,
  summarizeConversation,
  logAiError,
  type AiContext,
} from "../lib/ai.js";
import type { AiFeature } from "../ai/types.js";
import { resolveSettings } from "./ai.service.js";
import * as copilotRepo from "../repositories/ai_copilot_outputs.repository.js";
import type { EntityType, OutputType, UpsertCopilotOutputInput } from "../repositories/ai_copilot_outputs.repository.js";
import * as insightsRepo from "../repositories/ai_insights.repository.js";

// Orchestration for the Stage 5B AI Sales Copilot. For a single CRM entity + one
// requested output type it assembles a CRM-data-ONLY context (records already stored in
// the tenant), runs the applicable generator — an LLM generator (gated + ledgered via
// lib/ai.ts) for free-text drafts, and a DETERMINISTIC rule-based engine for follow-up
// timing and coaching signals — then UPSERTS a reviewable ai_copilot_outputs row carrying
// content + confidence/reasoning/source/model/promptVersion/generatedAt. Nothing here
// auto-sends a message or auto-writes CRM fields: outputs are drafts a user reviews,
// optionally edits, then explicitly "uses" (an audited action recorded on the row).

const ENTITY_TYPES: EntityType[] = ["lead", "contact", "organization", "business_card"];
const OUTPUT_TYPES: OutputType[] = ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"];

// Which output types make sense for which entity. Follow-up + coaching depend on
// lead/contact lifecycle fields (stage/status/follow-up date) so are restricted to those.
const APPLICABLE: Record<EntityType, OutputType[]> = {
  lead: ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"],
  contact: ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"],
  organization: ["email", "meeting_prep", "proposal", "summary"],
  business_card: ["email", "whatsapp", "summary"],
};

// Every LLM-backed output type maps to a versioned AI feature (for provenance). The two
// deterministic engines (followup/coaching) ALSO route their optional phrasing through an
// LLM feature, so all eight appear here.
const OUTPUT_FEATURE: Record<OutputType, AiFeature> = {
  email: "email_composer",
  whatsapp: "whatsapp_composer",
  call_prep: "call_preparation",
  meeting_prep: "meeting_preparation",
  proposal: "proposal_assistant",
  followup: "followup_suggestions",
  coaching: "sales_coaching",
  summary: "conversation_summary",
};

export function assertEntityType(value: string): EntityType {
  if (!ENTITY_TYPES.includes(value as EntityType)) {
    throw new AppError(400, `entityType must be one of: ${ENTITY_TYPES.join(", ")}`);
  }
  return value as EntityType;
}

export function assertOutputType(value: string): OutputType {
  if (!OUTPUT_TYPES.includes(value as OutputType)) {
    throw new AppError(400, `outputType must be one of: ${OUTPUT_TYPES.join(", ")}`);
  }
  return value as OutputType;
}

function assertApplicable(entityType: EntityType, outputType: OutputType): void {
  if (!APPLICABLE[entityType].includes(outputType)) {
    throw new AppError(400, `outputType "${outputType}" is not available for ${entityType}`);
  }
}

function normLang(value: unknown): AppLanguage {
  return value === "ar" ? "ar" : "en";
}

// ── Entity loaders (tenant-scoped, soft-delete aware) ─────────────────────────

async function loadLead(user: AuthUser, id: number): Promise<Lead> {
  const [row] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt))).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Lead not found");
  return row;
}
async function loadContact(user: AuthUser, id: number): Promise<Contact> {
  const [row] = await db.select().from(contactsTable).where(and(eq(contactsTable.id, id), isNull(contactsTable.deletedAt))).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Contact not found");
  return row;
}
async function loadOrganization(user: AuthUser, id: number): Promise<Organization> {
  const [row] = await db.select().from(organizationsTable).where(and(eq(organizationsTable.id, id), isNull(organizationsTable.deletedAt))).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Company not found");
  return row;
}
async function loadScan(user: AuthUser, id: number): Promise<Scan> {
  const [row] = await db.select().from(scansTable).where(eq(scansTable.id, id)).limit(1);
  if (!row || !canAccessCompany(user, row.companyId)) throw new AppError(404, "Business card not found");
  return row;
}

// ── Context assembly (CRM data only) ──────────────────────────────────────────

function contactLines(c: Contact): string[] {
  return [
    `Name: ${[c.firstName, c.lastName].filter(Boolean).join(" ") || c.fullName || "(unknown)"}`,
    `Job title: ${c.jobTitle ?? "(none)"}`,
    `Company: ${c.contactCompany ?? "(none)"}`,
    `Email: ${c.email ?? "(none)"}`,
    `Mobile: ${c.mobile ?? "(none)"}`,
    `Website: ${c.website ?? "(none)"}`,
    `LinkedIn: ${c.linkedin ?? "(none)"}`,
    `Country: ${c.country ?? "(none)"}`,
    `Industry: ${c.industry ?? "(none)"}`,
    `Status: ${c.status}`,
    `Follow-up date: ${c.followUpDate ?? "(none)"}`,
    `Notes: ${c.notes ?? "(none)"}`,
  ];
}

async function eventName(companyId: number, id: number | null): Promise<string | null> {
  if (id == null) return null;
  const [row] = await db.select({ name: eventsTable.name }).from(eventsTable).where(and(eq(eventsTable.companyId, companyId), eq(eventsTable.id, id))).limit(1);
  return row?.name ?? null;
}

async function buildLeadContext(lead: Lead): Promise<string> {
  let contact: Contact | undefined;
  if (lead.contactId != null) {
    [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.companyId, lead.companyId), eq(contactsTable.id, lead.contactId), isNull(contactsTable.deletedAt))).limit(1);
  }
  const evName = await eventName(lead.companyId, lead.eventId);
  const lines = [
    `Lead title: ${lead.title ?? "(none)"}`,
    `Stage: ${lead.stage}`,
    `Value: ${lead.value != null ? `${lead.value} ${lead.currency ?? "USD"}` : "(none)"}`,
    `Probability: ${lead.probability != null ? `${lead.probability}%` : "(none)"}`,
    `Priority: ${lead.priority ?? "(none)"}`,
    `Source: ${lead.source ?? "(none)"}`,
    `Company: ${lead.companyName ?? "(none)"}`,
    `Closing date: ${lead.closingDate ?? "(none)"}`,
    `Captured at event: ${evName ?? "(none)"}`,
    `Notes: ${lead.notes ?? "(none)"}`,
  ];
  if (contact) lines.push("", "Associated contact:", ...contactLines(contact).map((l) => `  ${l}`));
  return lines.join("\n");
}

async function buildOrganizationContext(org: Organization): Promise<string> {
  const contacts = await db
    .select({ firstName: contactsTable.firstName, lastName: contactsTable.lastName, fullName: contactsTable.fullName, jobTitle: contactsTable.jobTitle })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, org.companyId), eq(contactsTable.organizationId, org.id), isNull(contactsTable.deletedAt)))
    .limit(25);
  const lines = [
    `Company name: ${org.name}`,
    `Industry: ${org.industry ?? "(none)"}`,
    `Website: ${org.website ?? "(none)"}`,
    `Country: ${org.country ?? "(none)"}`,
    `Size: ${org.size ?? "(none)"}`,
    `Phone: ${org.phone ?? "(none)"}`,
    `Email: ${org.email ?? "(none)"}`,
    `Notes: ${org.notes ?? "(none)"}`,
    `Associated contacts (${contacts.length}):`,
    ...(contacts.length
      ? contacts.map((c) => `  - ${[c.firstName, c.lastName].filter(Boolean).join(" ") || c.fullName || "(unnamed)"}${c.jobTitle ? ` (${c.jobTitle})` : ""}`)
      : ["  (none)"]),
  ];
  return lines.join("\n");
}

interface ScanCardFields {
  firstName?: string | null; lastName?: string | null; fullName?: string | null;
  company?: string | null; email?: string | null; mobile?: string | null; jobTitle?: string | null;
}
function parseScanFields(raw: string | null): ScanCardFields {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      firstName: (v.firstName as string) ?? null,
      lastName: (v.lastName as string) ?? null,
      fullName: (v.fullName as string) ?? null,
      jobTitle: (v.jobTitle as string) ?? null,
      company: (v.company as string) ?? (v.contactCompany as string) ?? null,
      email: (v.email as string) ?? null,
      mobile: (v.mobile as string) ?? (v.phone as string) ?? null,
    };
  } catch {
    return {};
  }
}

function buildScanContext(scan: Scan): string {
  const f = parseScanFields(scan.extractedData);
  return [
    `Name: ${[f.firstName, f.lastName].filter(Boolean).join(" ") || f.fullName || "(unknown)"}`,
    `Job title: ${f.jobTitle ?? "(none)"}`,
    `Company: ${f.company ?? "(none)"}`,
    `Email: ${f.email ?? "(none)"}`,
    `Mobile: ${f.mobile ?? "(none)"}`,
  ].join("\n");
}

// ── Deterministic engines (rule-based, grounded only in CRM fields) ───────────

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface FollowupCore {
  suggestedDate: string;
  priority: "Urgent" | "High" | "Normal" | "Low";
  channel: "email" | "whatsapp" | "call";
  overdue: boolean;
  basis: string;
}

// Deterministic follow-up timing/channel/priority from real CRM fields only. Compares
// date-only strings (contacts.followUpDate is a plain YYYY-MM-DD) against today's local
// date string to avoid timezone drift (see replit.md date-only gotcha).
function leadFollowupCore(lead: Lead): FollowupCore {
  const today = todayStr();
  const stage = (lead.stage ?? "").toLowerCase();
  if (lead.closingDate && lead.closingDate < today && !["won", "lost", "closed"].some((s) => stage.includes(s))) {
    return { suggestedDate: today, priority: "Urgent", channel: "call", overdue: true, basis: `Closing date ${lead.closingDate} has passed and the lead is still in "${lead.stage}".` };
  }
  const priority: FollowupCore["priority"] = lead.priority?.toLowerCase() === "high" ? "High" : "Normal";
  return { suggestedDate: addDaysStr(3), priority, channel: "email", overdue: false, basis: `Lead is in "${lead.stage}"; suggest a follow-up in 3 days.` };
}

function contactFollowupCore(c: Contact): FollowupCore {
  const today = todayStr();
  const channel: FollowupCore["channel"] = c.mobile ? "whatsapp" : "email";
  if (c.followUpDate) {
    if (c.followUpDate < today) {
      return { suggestedDate: today, priority: "Urgent", channel, overdue: true, basis: `Follow-up was due ${c.followUpDate} and is overdue.` };
    }
    if (c.followUpDate === today) {
      return { suggestedDate: today, priority: "High", channel, overdue: false, basis: `Follow-up is scheduled for today (${c.followUpDate}).` };
    }
    return { suggestedDate: c.followUpDate, priority: "Normal", channel, overdue: false, basis: `Follow-up is scheduled for ${c.followUpDate}.` };
  }
  const status = (c.status ?? "").toLowerCase();
  if (status === "new") {
    return { suggestedDate: addDaysStr(1), priority: "High", channel, overdue: false, basis: `New contact with no follow-up set; reach out within a day.` };
  }
  return { suggestedDate: addDaysStr(3), priority: "Normal", channel, overdue: false, basis: `No follow-up date set; suggest reaching out in 3 days.` };
}

interface CoachingSignal { type: string; severity: "high" | "medium" | "low"; detail: string; }

function leadCoachingSignals(lead: Lead): CoachingSignal[] {
  const signals: CoachingSignal[] = [];
  const now = new Date();
  const stage = (lead.stage ?? "").toLowerCase();
  const staleDays = daysBetween(now, new Date(lead.updatedAt));
  if (staleDays >= 14 && !["won", "lost", "closed"].some((s) => stage.includes(s))) {
    signals.push({ type: "stalled", severity: staleDays >= 30 ? "high" : "medium", detail: `No update in ${staleDays} days.` });
  }
  if (lead.value == null) signals.push({ type: "missing_value", severity: "medium", detail: "Deal value is not set." });
  if (lead.contactId == null) signals.push({ type: "no_contact", severity: "high", detail: "No associated contact on the lead." });
  if (lead.closingDate && lead.closingDate < todayStr() && !["won", "lost", "closed"].some((s) => stage.includes(s))) {
    signals.push({ type: "overdue_close", severity: "high", detail: `Closing date ${lead.closingDate} has passed.` });
  }
  if (lead.assignedToId == null) signals.push({ type: "unassigned", severity: "medium", detail: "Lead has no owner assigned." });
  return signals;
}

function contactCoachingSignals(c: Contact): CoachingSignal[] {
  const signals: CoachingSignal[] = [];
  if (!c.email && !c.mobile) signals.push({ type: "unreachable", severity: "high", detail: "No email or mobile on file." });
  if (c.followUpDate && c.followUpDate < todayStr()) signals.push({ type: "overdue_followup", severity: "high", detail: `Follow-up was due ${c.followUpDate}.` });
  if (!c.followUpDate && (c.status ?? "").toLowerCase() !== "won") signals.push({ type: "no_followup", severity: "medium", detail: "No follow-up date scheduled." });
  if (!c.jobTitle) signals.push({ type: "missing_role", severity: "low", detail: "Job title/seniority unknown." });
  return signals;
}

// ── Persistence helper ────────────────────────────────────────────────────────

function buildUpsert(
  companyId: number,
  entityType: EntityType,
  entityId: number,
  outputType: OutputType,
  content: Record<string, unknown>,
  meta: { confidence: number | null; reasoning: string | null },
  source: "ai" | "deterministic",
  language: string,
  runtime: { provider?: string; model?: string },
): UpsertCopilotOutputInput {
  const feature = OUTPUT_FEATURE[outputType];
  const prompt = PROMPTS[feature];
  return {
    companyId,
    entityType,
    entityId,
    outputType,
    content,
    confidence: meta.confidence,
    reasoning: meta.reasoning,
    source,
    provider: source === "ai" ? runtime.provider ?? null : null,
    model: source === "ai" ? runtime.model ?? null : null,
    promptKey: source === "ai" ? prompt.key : null,
    promptVersion: source === "ai" ? prompt.version : null,
    language,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  language?: unknown;
  instructions?: unknown;
}

export function listAvailable(entityType: EntityType): OutputType[] {
  return APPLICABLE[entityType];
}

async function loadEntityContext(user: AuthUser, entityType: EntityType, id: number): Promise<{
  companyId: number;
  context: string;
  lead?: Lead;
  contact?: Contact;
}> {
  if (entityType === "lead") {
    const lead = await loadLead(user, id);
    return { companyId: lead.companyId, context: await buildLeadContext(lead), lead };
  }
  if (entityType === "contact") {
    const contact = await loadContact(user, id);
    return { companyId: contact.companyId, context: contactLines(contact).join("\n"), contact };
  }
  if (entityType === "business_card") {
    const scan = await loadScan(user, id);
    return { companyId: scan.companyId, context: buildScanContext(scan) };
  }
  const org = await loadOrganization(user, id);
  return { companyId: org.companyId, context: await buildOrganizationContext(org) };
}

// Generate (or re-generate) a single output. LLM failures SOFT-DEGRADE (a placeholder
// draft is stored, HTTP 200) instead of 500ing — the copilot never blocks a user because
// AI is unavailable. Deterministic outputs (followup/coaching) always produce a grounded
// result; their optional AI phrasing is best-effort on top of that.
export async function generateOutput(
  user: AuthUser,
  entityType: EntityType,
  id: number,
  outputType: OutputType,
  opts: GenerateOptions = {},
): Promise<AiCopilotOutput> {
  assertApplicable(entityType, outputType);
  const language = normLang(opts.language);
  const instructions = typeof opts.instructions === "string" ? opts.instructions.trim().slice(0, 1000) : "";
  const loaded = await loadEntityContext(user, entityType, id);
  const cid = loaded.companyId;
  const ctx: AiContext = { companyId: cid, userId: user.id };

  let runtime: { provider?: string; model?: string } = {};
  try {
    const s = await resolveSettings(cid);
    runtime = { provider: s.provider, model: s.model };
  } catch {
    runtime = {};
  }

  const contextText = instructions
    ? `${loaded.context}\n\nAdditional user instructions (do not override safety rules): ${instructions}`
    : loaded.context;

  // Deterministic output types: compute the grounded core first, then attempt AI phrasing.
  if (outputType === "followup") {
    const core = loaded.lead ? leadFollowupCore(loaded.lead) : contactFollowupCore(loaded.contact!);
    const facts = `Deterministic follow-up plan (do not change):\n- Suggested date: ${core.suggestedDate}\n- Priority: ${core.priority}\n- Channel: ${core.channel}\n- Overdue: ${core.overdue}\n- Basis: ${core.basis}`;
    let content: Record<string, unknown> = { ...core, recommendedAction: core.basis, draftMessage: null };
    let source: "ai" | "deterministic" = "deterministic";
    let meta = { confidence: 100 as number | null, reasoning: core.basis as string | null };
    try {
      const phrased = await phraseFollowup(`${contextText}\n\n${facts}`, language, ctx);
      content = { ...core, recommendedAction: phrased.recommendedAction ?? core.basis, draftMessage: phrased.draftMessage };
      source = "ai";
      meta = { confidence: phrased.confidence, reasoning: phrased.reasoning || core.basis };
    } catch (err) {
      logAiError("ai-copilot:followup-phrasing", err);
    }
    return copilotRepo.upsertOutput(buildUpsert(cid, entityType, id, outputType, content, meta, source, language, runtime));
  }

  if (outputType === "coaching") {
    const signals = loaded.lead ? leadCoachingSignals(loaded.lead) : contactCoachingSignals(loaded.contact!);
    const detReasoning = signals.length === 0 ? "No risk signals detected from the CRM data." : `${signals.length} signal(s) detected: ${signals.map((s) => s.type).join(", ")}.`;
    const facts = `Deterministic coaching signals (do not invent others):\n${signals.length ? signals.map((s) => `- [${s.severity}] ${s.type}: ${s.detail}`).join("\n") : "- none"}`;
    let content: Record<string, unknown> = { signals, summary: detReasoning, recommendations: signals.map((s) => s.detail) };
    let source: "ai" | "deterministic" = "deterministic";
    let meta = { confidence: 100 as number | null, reasoning: detReasoning as string | null };
    try {
      const coached = await coachDeal(`${contextText}\n\n${facts}`, ctx);
      content = { signals, summary: coached.summary ?? detReasoning, recommendations: coached.recommendations.length ? coached.recommendations : signals.map((s) => s.detail) };
      source = "ai";
      meta = { confidence: coached.confidence, reasoning: coached.reasoning || detReasoning };
    } catch (err) {
      logAiError("ai-copilot:coaching-phrasing", err);
    }
    return copilotRepo.upsertOutput(buildUpsert(cid, entityType, id, outputType, content, meta, source, language, runtime));
  }

  // LLM-only output types.
  try {
    let content: Record<string, unknown>;
    let meta: { confidence: number | null; reasoning: string | null };
    if (outputType === "email") {
      const r = await composeEmail(contextText, language, ctx);
      content = { subject: r.subject, body: r.body, tone: r.tone, insufficientData: r.insufficientData };
      meta = { confidence: r.confidence, reasoning: r.reasoning };
    } else if (outputType === "whatsapp") {
      const r = await composeWhatsapp(contextText, language, ctx);
      content = { message: r.message, insufficientData: r.insufficientData };
      meta = { confidence: r.confidence, reasoning: r.reasoning };
    } else if (outputType === "call_prep") {
      const r = await prepareCall(contextText, ctx);
      content = { objective: r.objective, talkingPoints: r.talkingPoints, questions: r.questions, anticipatedObjections: r.anticipatedObjections, nextStep: r.nextStep, insufficientData: r.insufficientData };
      meta = { confidence: r.confidence, reasoning: r.reasoning };
    } else if (outputType === "meeting_prep") {
      const r = await prepareMeeting(contextText, ctx);
      content = { objectives: r.objectives, agenda: r.agenda, attendeeNotes: r.attendeeNotes, materials: r.materials, suggestedDurationMinutes: r.suggestedDurationMinutes, nextStep: r.nextStep, insufficientData: r.insufficientData };
      meta = { confidence: r.confidence, reasoning: r.reasoning };
    } else if (outputType === "proposal") {
      const r = await draftProposal(contextText, language, ctx);
      content = { title: r.title, executiveSummary: r.executiveSummary, sections: r.sections, valueProps: r.valueProps, pricingNote: r.pricingNote, insufficientData: r.insufficientData };
      meta = { confidence: r.confidence, reasoning: r.reasoning };
    } else {
      const r = await summarizeConversation(contextText, ctx);
      content = { summary: r.summary, keyTakeaways: r.keyTakeaways, sentiment: r.sentiment, nextSteps: r.nextSteps, insufficientData: r.insufficientData };
      meta = { confidence: r.confidence, reasoning: r.reasoning };
    }
    return copilotRepo.upsertOutput(buildUpsert(cid, entityType, id, outputType, content, meta, "ai", language, runtime));
  } catch (err) {
    logAiError(`ai-copilot:${outputType}`, err);
    const message = err instanceof AppError ? err.message : "AI generation is currently unavailable. Please try again.";
    const content = { unavailable: true, note: message };
    return copilotRepo.upsertOutput(buildUpsert(cid, entityType, id, outputType, content, { confidence: 0, reasoning: message }, "ai", language, runtime));
  }
}

export async function getOutputs(user: AuthUser, entityType: EntityType, id: number): Promise<AiCopilotOutput[]> {
  await loadEntityContext(user, entityType, id); // tenant-scoped existence check (404)
  return copilotRepo.listByEntity(user, entityType, id);
}

export async function editOutput(user: AuthUser, id: number, editedContent: Record<string, unknown>): Promise<AiCopilotOutput> {
  const existing = await copilotRepo.getById(user, id);
  if (!existing) throw new AppError(404, "Output not found");
  const row = await copilotRepo.saveEdit(user, id, editedContent);
  if (!row) throw new AppError(404, "Output not found");
  return row;
}

export async function useOutput(user: AuthUser, id: number): Promise<AiCopilotOutput> {
  const existing = await copilotRepo.getById(user, id);
  if (!existing) throw new AppError(404, "Output not found");
  const row = await copilotRepo.setUsed(user, id, user.id);
  if (!row) throw new AppError(404, "Output not found");
  return row;
}

export async function dismissOutput(user: AuthUser, id: number): Promise<AiCopilotOutput> {
  const existing = await copilotRepo.getById(user, id);
  if (!existing) throw new AppError(404, "Output not found");
  const row = await copilotRepo.setDismissed(user, id);
  if (!row) throw new AppError(404, "Output not found");
  return row;
}

export async function getOverview(user: AuthUser) {
  const [counts, recent] = await Promise.all([
    copilotRepo.statusCounts(user),
    copilotRepo.recentForCompany(user, 20),
  ]);
  return { counts, recent };
}

// Aggregated Sales Copilot panel for one CRM entity: the available generators, the
// deterministic suggested next action + coaching risk signals (grounded in real fields),
// any existing Stage 5A AI insights (lead score / summary / company + relationship
// intelligence), and the stored copilot drafts. Tenant-scoped: nonexistent/cross-tenant
// entities 404 via loadEntityContext (no existence leak). No fabricated data.
export async function getPanel(user: AuthUser, entityType: EntityType, id: number) {
  const loaded = await loadEntityContext(user, entityType, id);
  const [outputs, insights] = await Promise.all([
    copilotRepo.listByEntity(user, entityType, id),
    insightsRepo.listByEntity(user, entityType, id).catch(() => []),
  ]);
  let suggestedAction: FollowupCore | null = null;
  let coachingSignals: CoachingSignal[] = [];
  if (loaded.lead) {
    suggestedAction = leadFollowupCore(loaded.lead);
    coachingSignals = leadCoachingSignals(loaded.lead);
  } else if (loaded.contact) {
    suggestedAction = contactFollowupCore(loaded.contact);
    coachingSignals = contactCoachingSignals(loaded.contact);
  }
  return {
    entityType,
    entityId: id,
    availableOutputTypes: APPLICABLE[entityType],
    suggestedAction,
    coachingSignals,
    insights,
    outputs,
  };
}

// Used by the batch worker: process one entity for one output type. Errors propagate to
// the job runner (which records them per-entity) — generateOutput already soft-degrades
// AI failures, so this throws only on genuine load/tenant errors.
export async function generateForBatch(user: AuthUser, entityType: EntityType, id: number, outputType: OutputType): Promise<void> {
  await generateOutput(user, entityType, id, outputType);
}
