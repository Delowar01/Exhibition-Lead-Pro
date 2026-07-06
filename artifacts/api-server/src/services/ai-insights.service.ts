import { db, contactsTable, leadsTable, organizationsTable, eventsTable } from "@workspace/db";
import type { AiInsight, Contact, Lead, Organization } from "@workspace/db";
import { and, eq, ne, isNull, sql } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { canAccessCompany } from "../middlewares/requireAuth.js";
import { PROMPTS } from "../ai/prompts.js";
import {
  analyzeLeadIntelligence,
  analyzeCompanyIntelligence,
  analyzeContactIntelligence,
  classifyEntity,
  analyzeOpportunity,
  logAiError,
  type IntelligenceMeta,
} from "../lib/ai.js";
import type { AiFeature } from "../ai/types.js";
import { resolveSettings } from "./ai.service.js";
import * as insightsRepo from "../repositories/ai_insights.repository.js";
import type { EntityType, InsightType, UpsertInsightInput } from "../repositories/ai_insights.repository.js";
import {
  contactRelationships,
  leadRelationships,
  organizationRelationships,
} from "./ai-relationships.service.js";

// Orchestration for the Stage 5A reviewable AI intelligence layer. For a single CRM
// entity it assembles a CRM-data-ONLY context (records already stored in the tenant),
// runs the applicable LLM intelligence features (gated + ledgered via lib/ai.ts) AND
// the deterministic engines (missing-info, duplicate detection), then UPSERTS each as a
// reviewable ai_insights row carrying confidence/reasoning/model/promptVersion/
// generatedAt/lastAnalysisAt. Nothing here writes back into CRM fields — insights are
// suggestions a user explicitly accepts (an audited action recorded on the row).

const ENTITY_TYPES: EntityType[] = ["lead", "contact", "organization"];

export function assertEntityType(value: string): EntityType {
  if (!ENTITY_TYPES.includes(value as EntityType)) {
    throw new AppError(400, `entityType must be one of: ${ENTITY_TYPES.join(", ")}`);
  }
  return value as EntityType;
}

function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function normPhone(v: string | null | undefined): string {
  return (v ?? "").replace(/[^0-9]/g, "");
}
function normEmail(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}
function pct(filled: number, total: number): number {
  return total === 0 ? 100 : Math.round((filled / total) * 100);
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

async function loadEntityCompanyId(user: AuthUser, entityType: EntityType, id: number): Promise<number> {
  if (entityType === "lead") return (await loadLead(user, id)).companyId;
  if (entityType === "contact") return (await loadContact(user, id)).companyId;
  return (await loadOrganization(user, id)).companyId;
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
    `Industry (existing): ${c.industry ?? "(none)"}`,
    `Status: ${c.status}`,
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
  const [{ leadCount, leadValue } = { leadCount: 0, leadValue: 0 }] = await db
    .select({ leadCount: sql<number>`count(*)`, leadValue: sql<number>`coalesce(sum(${leadsTable.value}),0)` })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, org.companyId), eq(leadsTable.organizationId, org.id), isNull(leadsTable.deletedAt)));
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
    `Associated leads: ${Number(leadCount)} (total value ${Number(leadValue)})`,
  ];
  return lines.join("\n");
}

// ── Deterministic engines ─────────────────────────────────────────────────────

interface FieldSpec { label: string; value: string | number | null | undefined; }

function missingInfoInsight(specs: FieldSpec[]): { data: Record<string, unknown>; confidence: number; reasoning: string } {
  const missing = specs.filter((s) => s.value == null || String(s.value).trim() === "").map((s) => s.label);
  const completeness = pct(specs.length - missing.length, specs.length);
  const reasoning = missing.length === 0
    ? "All key fields are present."
    : `Missing ${missing.length} of ${specs.length} key fields: ${missing.join(", ")}.`;
  return { data: { missingFields: missing, completeness, totalFields: specs.length }, confidence: 100, reasoning };
}

interface DuplicateMatch { id: number; label: string; reason: string; }

async function contactDuplicates(companyId: number, c: Contact): Promise<DuplicateMatch[]> {
  const rows = await db
    .select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName, fullName: contactsTable.fullName, email: contactsTable.email, mobile: contactsTable.mobile, contactCompany: contactsTable.contactCompany })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, companyId), ne(contactsTable.id, c.id), isNull(contactsTable.deletedAt)))
    .limit(500);
  const email = normEmail(c.email);
  const phone = normPhone(c.mobile);
  const name = normName([c.firstName, c.lastName].filter(Boolean).join(" ") || c.fullName);
  const company = normName(c.contactCompany);
  const out: DuplicateMatch[] = [];
  for (const r of rows) {
    const label = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.fullName || `#${r.id}`;
    if (email && normEmail(r.email) === email) out.push({ id: r.id, label, reason: "Same email address" });
    else if (phone && phone.length >= 7 && normPhone(r.mobile) === phone) out.push({ id: r.id, label, reason: "Same phone number" });
    else if (name && company && normName([r.firstName, r.lastName].filter(Boolean).join(" ") || r.fullName) === name && normName(r.contactCompany) === company) out.push({ id: r.id, label, reason: "Same name & company" });
  }
  return out.slice(0, 10);
}

async function organizationDuplicates(companyId: number, org: Organization): Promise<DuplicateMatch[]> {
  const rows = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name, normalizedName: organizationsTable.normalizedName })
    .from(organizationsTable)
    .where(and(eq(organizationsTable.companyId, companyId), ne(organizationsTable.id, org.id), isNull(organizationsTable.deletedAt)))
    .limit(500);
  const target = normName(org.name);
  return rows
    .filter((r) => normName(r.name) === target || r.normalizedName === org.normalizedName)
    .map((r) => ({ id: r.id, label: r.name, reason: "Same company name" }))
    .slice(0, 10);
}

async function leadDuplicates(companyId: number, lead: Lead): Promise<DuplicateMatch[]> {
  if (lead.contactId == null && lead.organizationId == null) return [];
  const rows = await db
    .select({ id: leadsTable.id, title: leadsTable.title, contactId: leadsTable.contactId, organizationId: leadsTable.organizationId })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, companyId), ne(leadsTable.id, lead.id), isNull(leadsTable.deletedAt)))
    .limit(500);
  const out: DuplicateMatch[] = [];
  for (const r of rows) {
    if (lead.contactId != null && r.contactId === lead.contactId) out.push({ id: r.id, label: r.title ?? `Lead #${r.id}`, reason: "Same associated contact" });
    else if (lead.organizationId != null && r.organizationId === lead.organizationId) out.push({ id: r.id, label: r.title ?? `Lead #${r.id}`, reason: "Same associated company" });
  }
  return out.slice(0, 10);
}

function duplicateInsight(matches: DuplicateMatch[]): { data: Record<string, unknown>; confidence: number; reasoning: string } {
  const hasStrong = matches.some((m) => m.reason.startsWith("Same email") || m.reason === "Same phone number" || m.reason === "Same company name");
  const confidence = matches.length === 0 ? 100 : hasStrong ? 90 : 65;
  const reasoning = matches.length === 0
    ? "No likely duplicates found in your CRM."
    : `Found ${matches.length} possible duplicate${matches.length > 1 ? "s" : ""} in your CRM.`;
  return { data: { matches, count: matches.length }, confidence, reasoning };
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function aiUpsert(
  companyId: number,
  entityType: EntityType,
  entityId: number,
  insightType: InsightType,
  feature: AiFeature,
  result: IntelligenceMeta,
  runtime: { provider?: string; model?: string },
): UpsertInsightInput {
  const prompt = PROMPTS[feature];
  const { confidence, reasoning, ...rest } = result as unknown as Record<string, unknown> & IntelligenceMeta;
  return {
    companyId,
    entityType,
    entityId,
    insightType,
    data: rest as Record<string, unknown>,
    confidence,
    reasoning: result.insufficientData && !reasoning ? "Not enough information" : reasoning,
    source: "ai",
    provider: runtime.provider,
    model: runtime.model,
    promptKey: prompt.key,
    promptVersion: prompt.version,
  };
}

function detUpsert(
  companyId: number,
  entityType: EntityType,
  entityId: number,
  insightType: InsightType,
  det: { data: Record<string, unknown>; confidence: number; reasoning: string },
): UpsertInsightInput {
  return {
    companyId,
    entityType,
    entityId,
    insightType,
    data: det.data,
    confidence: det.confidence,
    reasoning: det.reasoning,
    source: "deterministic",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AnalyzeResult {
  insights: AiInsight[];
  aiErrors: Array<{ feature: string; message: string }>;
}

export async function analyzeEntity(user: AuthUser, entityType: EntityType, id: number): Promise<AnalyzeResult> {
  const aiErrors: Array<{ feature: string; message: string }> = [];
  const ctxOf = (companyId: number) => ({ companyId, userId: user.id });

  // The tenant's effective provider/model at analysis time, stamped onto every AI-sourced
  // insight row so provenance reflects the ACTUAL runtime config (not a hardcoded value)
  // and stays consistent with what GET /ai/settings reports. Resolved once per entity;
  // resolveSettings shares lib/ai.ts's in-process cache, so this is not an extra DB read.
  // Guarded: a resolve failure must not break the deterministic engines — and any AI
  // feature would also fail (persisting no row) so provenance is only stamped on success.
  let runtime: { provider?: string; model?: string } = {};
  async function loadRuntime(companyId: number): Promise<void> {
    try {
      const s = await resolveSettings(companyId);
      runtime = { provider: s.provider, model: s.model };
    } catch {
      runtime = {};
    }
  }

  // Run an LLM generator, persist on success, collect (not throw) on failure so one
  // disabled/failing feature never blocks the rest or the deterministic insights.
  async function runAi<T extends IntelligenceMeta>(
    companyId: number, entityType: EntityType, entityId: number, insightType: InsightType, feature: AiFeature, fn: () => Promise<T>,
  ): Promise<void> {
    try {
      const result = await fn();
      await insightsRepo.upsertInsight(aiUpsert(companyId, entityType, entityId, insightType, feature, result, runtime));
    } catch (err) {
      logAiError(`ai-insights:${feature}`, err);
      aiErrors.push({ feature, message: err instanceof AppError ? err.message : "AI analysis unavailable" });
    }
  }

  if (entityType === "lead") {
    const lead = await loadLead(user, id);
    const cid = lead.companyId;
    await loadRuntime(cid);
    const context = await buildLeadContext(lead);
    await runAi(cid, "lead", id, "lead_intelligence", "lead_intelligence", () => analyzeLeadIntelligence(context, ctxOf(cid)));
    await runAi(cid, "lead", id, "opportunity_potential", "opportunity_potential", () => analyzeOpportunity(context, ctxOf(cid)));
    await runAi(cid, "lead", id, "smart_classification", "smart_classification", () => classifyEntity(context, ctxOf(cid)));
    await insightsRepo.upsertInsight(detUpsert(cid, "lead", id, "missing_info", missingInfoInsight([
      { label: "Title", value: lead.title }, { label: "Value", value: lead.value }, { label: "Source", value: lead.source },
      { label: "Closing date", value: lead.closingDate }, { label: "Contact", value: lead.contactId }, { label: "Owner", value: lead.assignedToId },
    ])));
    await insightsRepo.upsertInsight(detUpsert(cid, "lead", id, "duplicate_intelligence", duplicateInsight(await leadDuplicates(cid, lead))));
    await insightsRepo.upsertInsight(detUpsert(cid, "lead", id, "relationship_intelligence", await leadRelationships(cid, lead)));
  } else if (entityType === "contact") {
    const contact = await loadContact(user, id);
    const cid = contact.companyId;
    await loadRuntime(cid);
    const context = contactLines(contact).join("\n");
    await runAi(cid, "contact", id, "contact_intelligence", "contact_intelligence", () => analyzeContactIntelligence(context, ctxOf(cid)));
    await runAi(cid, "contact", id, "smart_classification", "smart_classification", () => classifyEntity(context, ctxOf(cid)));
    await insightsRepo.upsertInsight(detUpsert(cid, "contact", id, "missing_info", missingInfoInsight([
      { label: "Name", value: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.fullName },
      { label: "Job title", value: contact.jobTitle }, { label: "Email", value: contact.email }, { label: "Mobile", value: contact.mobile },
      { label: "Company", value: contact.contactCompany ?? contact.organizationId }, { label: "Website", value: contact.website }, { label: "Country", value: contact.country },
    ])));
    await insightsRepo.upsertInsight(detUpsert(cid, "contact", id, "duplicate_intelligence", duplicateInsight(await contactDuplicates(cid, contact))));
    await insightsRepo.upsertInsight(detUpsert(cid, "contact", id, "relationship_intelligence", await contactRelationships(cid, contact)));
  } else {
    const org = await loadOrganization(user, id);
    const cid = org.companyId;
    await loadRuntime(cid);
    const context = await buildOrganizationContext(org);
    await runAi(cid, "organization", id, "company_intelligence", "company_intelligence", () => analyzeCompanyIntelligence(context, ctxOf(cid)));
    await insightsRepo.upsertInsight(detUpsert(cid, "organization", id, "missing_info", missingInfoInsight([
      { label: "Industry", value: org.industry }, { label: "Website", value: org.website }, { label: "Phone", value: org.phone },
      { label: "Email", value: org.email }, { label: "Country", value: org.country }, { label: "Size", value: org.size },
    ])));
    await insightsRepo.upsertInsight(detUpsert(cid, "organization", id, "duplicate_intelligence", duplicateInsight(await organizationDuplicates(cid, org))));
    await insightsRepo.upsertInsight(detUpsert(cid, "organization", id, "relationship_intelligence", await organizationRelationships(cid, org)));
  }

  const insights = await insightsRepo.listByEntity(user, entityType, id);
  return { insights, aiErrors };
}

export async function getInsights(user: AuthUser, entityType: EntityType, id: number): Promise<AiInsight[]> {
  await loadEntityCompanyId(user, entityType, id); // tenant-scoped existence check (404 if not accessible)
  return insightsRepo.listByEntity(user, entityType, id);
}

export async function acceptInsight(user: AuthUser, id: number): Promise<AiInsight> {
  const existing = await insightsRepo.getById(user, id);
  if (!existing) throw new AppError(404, "Insight not found");
  const row = await insightsRepo.setStatus(user, id, "accepted", user.id);
  if (!row) throw new AppError(404, "Insight not found");
  return row;
}

export async function dismissInsight(user: AuthUser, id: number): Promise<AiInsight> {
  const existing = await insightsRepo.getById(user, id);
  if (!existing) throw new AppError(404, "Insight not found");
  const row = await insightsRepo.setStatus(user, id, "dismissed", null);
  if (!row) throw new AppError(404, "Insight not found");
  return row;
}

export async function getOverview(user: AuthUser) {
  const [counts, recent] = await Promise.all([
    insightsRepo.statusCounts(user),
    insightsRepo.recentForCompany(user, 20),
  ]);
  return { counts, recent };
}
