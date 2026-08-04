import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import { getQueue } from "../lib/jobs/queue.js";
import * as repo from "../repositories/ai.repository.js";
import type { RawAgg } from "../repositories/ai.repository.js";
import { AI_FEATURES, type AiFeature, type AiUsage } from "../ai/types.js";
import { availableProviders } from "../ai/providers/index.js";
import { geminiProvider } from "../ai/providers/gemini.js";
import { hasPricing, estimateCostMicroUsd, pricingVersion } from "../ai/pricing.js";
import {
  normalizeWorkflowRules,
  WORKFLOW_RULE_BOUNDS,
  type WorkflowRules,
} from "../lib/workflow-intelligence.js";

// Service layer for the AI Platform Foundation: resolves per-tenant settings (with a
// short in-process cache so the hot scan/score path stays fast), enforces the
// enabled/feature-flag/budget gates, records the append-only invocation ledger, and
// aggregates usage/cost for the tenant + platform dashboards.
//
// SAFETY: an ABSENT settings row === platform defaults (enabled, all features on,
// unlimited budgets). Existing tenants therefore keep working with zero behavior
// change — the gates only fire when an admin has explicitly disabled a feature or set
// a budget that has been exhausted.

export interface EffectiveAiSettings {
  companyId: number;
  provider: string;
  model: string;
  enabled: boolean;
  featureFlags: Record<string, boolean>; // raw stored flags; a missing key means "enabled"
  monthlyTokenBudget: number | null;
  monthlyCostBudgetMicroUsd: number | null;
  // Stage 5F: normalized, complete tenant workflow-intelligence thresholds. This is the
  // SINGLE source of truth for both the settings read path (GET /ai/settings) and the
  // workflow runtime (risk detection, health, bottlenecks, simulate, alerts) so the two
  // can never drift apart.
  workflowRules: WorkflowRules;
  hasCustomSettings: boolean;
  updatedAt: Date | null;
}

interface CacheEntry {
  value: EffectiveAiSettings;
  expires: number;
}
const settingsCache = new Map<number, CacheEntry>();

function defaults(companyId: number): EffectiveAiSettings {
  return {
    companyId,
    provider: config.ai.provider,
    model: config.ai.model,
    enabled: true,
    featureFlags: {},
    monthlyTokenBudget: null,
    monthlyCostBudgetMicroUsd: null,
    workflowRules: normalizeWorkflowRules(null),
    hasCustomSettings: false,
    updatedAt: null,
  };
}

export function invalidateSettingsCache(companyId: number): void {
  settingsCache.delete(companyId);
}

export async function resolveSettings(companyId: number): Promise<EffectiveAiSettings> {
  const now = Date.now();
  const cached = settingsCache.get(companyId);
  if (cached && cached.expires > now) return cached.value;

  const row = await repo.getSettingsByCompany(companyId);
  const value: EffectiveAiSettings = row
    ? {
        companyId,
        provider: row.provider,
        model: row.model,
        enabled: row.enabled,
        featureFlags: (row.featureFlags ?? {}) as Record<string, boolean>,
        monthlyTokenBudget: row.monthlyTokenBudget,
        monthlyCostBudgetMicroUsd: row.monthlyCostBudgetMicroUsd,
        workflowRules: normalizeWorkflowRules(row.workflowRules),
        hasCustomSettings: true,
        updatedAt: row.updatedAt,
      }
    : defaults(companyId);

  if (config.ai.settingsCacheTtlMs > 0) {
    settingsCache.set(companyId, { value, expires: now + config.ai.settingsCacheTtlMs });
  }
  return value;
}

export function isFeatureEnabled(s: EffectiveAiSettings, feature: AiFeature): boolean {
  return s.enabled && s.featureFlags[feature] !== false;
}

function humanFeature(feature: AiFeature): string {
  return feature.replace(/_/g, " ");
}

export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function nextMonthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

// Enforcement gate called before an AI provider call. No-op when there is no tenant
// context (system call) or when settings are at their defaults. Throws a clear
// AppError when an admin has disabled the feature (403). Budget enforcement moved to
// reserveBudgetIfConfigured (Batch 6) so it is atomic under concurrency.
export async function ensureAiAllowed(companyId: number | null | undefined, feature: AiFeature): Promise<void> {
  if (companyId == null) return;
  const s = await resolveSettings(companyId);
  if (!s.enabled) {
    throw new AppError(403, "AI features are disabled for your organization", { code: "AI_DISABLED" });
  }
  if (s.featureFlags[feature] === false) {
    throw new AppError(403, `AI ${humanFeature(feature)} is disabled for your organization`, {
      code: "AI_FEATURE_DISABLED",
    });
  }
}

// ---- Batch 6: atomic budget reservation -------------------------------------------

// Reserves a conservative token/cost slice against the tenant's month budget BEFORE
// the provider call (atomic: advisory-locked check + reservation insert in one
// transaction, so concurrent requests cannot collectively overspend). Returns true
// when a reservation was made (caller must release it after finalizing the ledger
// row); false when the tenant has no budgets configured (fast path — no extra I/O).
// Throws the budget-exhausted 429 (with safe metadata for the UI) on denial.
export async function reserveBudgetIfConfigured(
  companyId: number,
  requestId: string,
  model: string,
): Promise<boolean> {
  const s = await resolveSettings(companyId);
  if (s.monthlyTokenBudget == null && s.monthlyCostBudgetMicroUsd == null) return false;

  const reserveTokens = config.ai.budget.reserveTokens;
  // Cost reservation prices the reserved tokens half as input / half as output — a
  // deliberate middle estimate (actual usage replaces it at finalize).
  const reserveCost = estimateCostMicroUsd(model, reserveTokens / 2, reserveTokens / 2);
  const check = await repo.reserveBudget({
    companyId,
    requestId,
    reserveTokens,
    reserveCostMicroUsd: reserveCost,
    monthFrom: monthStart(),
    tokenBudget: s.monthlyTokenBudget,
    costBudgetMicroUsd: s.monthlyCostBudgetMicroUsd,
    ttlMs: config.ai.budget.reservationTtlMs,
  });
  if (check.ok) return true;

  const resetAt = nextMonthStart().toISOString();
  const details: Record<string, unknown> = {
    kind: check.exceeded,
    periodStart: monthStart().toISOString(),
    resetAt,
    usedTokens: check.usedTokens,
    usedCostUsd: microToUsd(check.usedCostMicroUsd),
    tokenBudget: s.monthlyTokenBudget,
    costBudgetUsd: s.monthlyCostBudgetMicroUsd == null ? null : microToUsd(s.monthlyCostBudgetMicroUsd),
  };
  const message =
    check.exceeded === "tokens"
      ? "Monthly AI token budget exhausted for your organization"
      : "Monthly AI cost budget exhausted for your organization";
  throw new AppError(429, message, { code: "AI_BUDGET_EXCEEDED", details });
}

export async function releaseBudgetReservation(requestId: string): Promise<void> {
  try {
    await repo.releaseReservation(requestId);
  } catch (err) {
    // Non-fatal: the reservation expires on its own TTL.
    logger.warn({ err, requestId }, "Failed to release AI budget reservation (will expire)");
  }
}

// ---- Batch 6: reliable, idempotent ledger writes ------------------------------------

export const AI_LEDGER_RETRY_JOB = "ai:ledger-retry";

// Operational counter for ledger-write failures (surfaced by the alert sweep so an
// operator is notified instead of usage silently under-counting).
let ledgerWriteFailures = 0;
export function ledgerWriteFailureCount(): number {
  return ledgerWriteFailures;
}
export function resetLedgerWriteFailureCount(): void {
  ledgerWriteFailures = 0;
}

export type InvocationStatus =
  | "success"
  | "error"
  | "timeout"
  | "cache_hit"
  | "dedup_reused"
  | "budget_denied"
  | "rate_limited";

export interface RecordInvocationParams {
  requestId: string;
  ctx?: { companyId?: number | null; userId?: number | null; entityType?: string | null; entityId?: number | null };
  feature: AiFeature;
  provider: string;
  model: string;
  promptKey?: string | null;
  promptVersion?: number | null;
  status: InvocationStatus;
  usage: AiUsage;
  costMicroUsd: number;
  latencyMs: number;
  attempts?: number;
  confidence?: number | null;
  errorMessage?: string | null;
  errorCategory?: string | null;
}

function toInsertValues(params: RecordInvocationParams, createdAt: Date) {
  return {
    requestId: params.requestId,
    companyId: params.ctx?.companyId ?? null,
    userId: params.ctx?.userId ?? null,
    entityType: params.ctx?.entityType ?? null,
    entityId: params.ctx?.entityId ?? null,
    feature: params.feature,
    provider: params.provider,
    model: params.model,
    promptKey: params.promptKey ?? null,
    promptVersion: params.promptVersion ?? null,
    status: params.status,
    attempts: params.attempts ?? 1,
    estimatedUsage: params.usage.missingMetadata === true,
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    totalTokens: params.usage.totalTokens,
    estimatedCostMicroUsd: params.costMicroUsd,
    pricingVersion: params.costMicroUsd > 0 || params.status === "success" ? pricingVersion() : null,
    confidence: params.confidence ?? null,
    latencyMs: params.latencyMs,
    errorMessage: params.errorMessage ?? null,
    errorCategory: params.errorCategory ?? null,
    createdAt,
  };
}

// Append one row to the ledger. NEVER throws (recording must not fail the AI result
// path) but is no longer fire-and-forget-and-lost: the write is awaited, idempotent
// by requestId, and on failure it is (a) logged, (b) counted for the operator alert,
// and (c) re-queued through the existing job queue, which retries with backoff and
// dead-letters visibly. A retried write can never duplicate a row (unique requestId
// + ON CONFLICT DO NOTHING).
// A foreign-key violation means the referenced row (company/user) was deleted
// after the AI call started — the ledger row can never be written, so retrying
// is pointless (it would dead-letter after burning every attempt).
function isForeignKeyViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    if ((e as { code?: unknown }).code === "23503") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// Returns true when the ledger row is DURABLE — written, queued for retry, or
// intentionally dropped (tenant deleted). Returns false only when both the write
// AND the retry enqueue failed; callers must then keep the budget reservation
// (it expires via TTL) so unrecorded usage cannot silently reopen budget headroom.
export async function recordInvocation(params: RecordInvocationParams): Promise<boolean> {
  const values = toInsertValues(params, new Date());
  try {
    await repo.insertInvocation(values);
    return true;
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      logger.warn(
        { feature: params.feature, requestId: params.requestId },
        "AI ledger row dropped: referenced company/user no longer exists",
      );
      return true;
    }
    ledgerWriteFailures += 1;
    logger.error({ err, feature: params.feature, requestId: params.requestId }, "Failed to record AI invocation; queueing retry");
    try {
      await getQueue().enqueue(AI_LEDGER_RETRY_JOB, { ...values, createdAt: values.createdAt.toISOString() });
      return true;
    } catch (enqueueErr) {
      logger.error({ err: enqueueErr, requestId: params.requestId }, "Failed to queue AI ledger retry");
      return false;
    }
  }
}

// Job handler body for AI_LEDGER_RETRY_JOB: throws on failure so the queue's
// backoff/dead-letter machinery applies; insert stays idempotent via requestId.
// FK violations are permanent (tenant deleted mid-write) — drop, don't retry.
export async function runLedgerRetryJob(payload: Record<string, unknown>): Promise<void> {
  try {
    await repo.insertInvocation({
      ...(payload as object),
      createdAt: new Date(String(payload.createdAt)),
    } as Parameters<typeof repo.insertInvocation>[0]);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      logger.warn({ requestId: payload.requestId }, "AI ledger retry dropped: referenced company/user no longer exists");
      return;
    }
    throw err;
  }
}

// ---- Presentation helpers -------------------------------------------------

export function microToUsd(micro: number): number {
  return Number((micro / 1_000_000).toFixed(6));
}

function effectiveFlags(s: EffectiveAiSettings): Record<AiFeature, boolean> {
  const out = {} as Record<AiFeature, boolean>;
  for (const f of AI_FEATURES) out[f] = s.featureFlags[f] !== false;
  return out;
}

function formatSettings(s: EffectiveAiSettings) {
  return {
    companyId: s.companyId,
    provider: s.provider,
    model: s.model,
    enabled: s.enabled,
    featureFlags: effectiveFlags(s),
    monthlyTokenBudget: s.monthlyTokenBudget,
    monthlyCostBudgetUsd: s.monthlyCostBudgetMicroUsd == null ? null : microToUsd(s.monthlyCostBudgetMicroUsd),
    workflowRules: s.workflowRules,
    hasCustomSettings: s.hasCustomSettings,
    availableProviders: availableProviders(),
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  };
}

function formatAgg(a: RawAgg) {
  return {
    requests: a.requests,
    success: a.success,
    errors: a.errors,
    failureRate: a.requests > 0 ? Number((a.errors / a.requests).toFixed(4)) : 0,
    cacheHits: a.cacheHits,
    dedupReused: a.dedupReused,
    budgetDenied: a.budgetDenied,
    rateLimited: a.rateLimited,
    estimatedRows: a.estimatedRows,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    totalTokens: a.totalTokens,
    costUsd: microToUsd(a.costMicroUsd),
    avgLatencyMs: a.avgLatencyMs,
  };
}

// ---- Public service API ---------------------------------------------------

function requireCompany(user: AuthUser): number {
  if (user.companyId == null) throw new AppError(400, "No company context");
  return user.companyId;
}

export async function getSettings(user: AuthUser) {
  const companyId = requireCompany(user);
  return formatSettings(await resolveSettings(companyId));
}

export async function updateSettings(user: AuthUser, body: Record<string, unknown>) {
  const companyId = requireCompany(user);
  const current = await resolveSettings(companyId);
  const values: Partial<import("@workspace/db").AiSettings> = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new AppError(400, "enabled must be a boolean");
    values.enabled = body.enabled;
  }
  if (body.provider !== undefined) {
    if (typeof body.provider !== "string" || !availableProviders().includes(body.provider)) {
      throw new AppError(400, `provider must be one of: ${availableProviders().join(", ")}`);
    }
    values.provider = body.provider;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim() === "") throw new AppError(400, "model must be a non-empty string");
    values.model = body.model.trim();
  }
  if (body.featureFlags !== undefined) {
    if (typeof body.featureFlags !== "object" || body.featureFlags === null || Array.isArray(body.featureFlags)) {
      throw new AppError(400, "featureFlags must be an object");
    }
    const incoming = body.featureFlags as Record<string, unknown>;
    const merged: Record<string, boolean> = { ...current.featureFlags };
    for (const [k, v] of Object.entries(incoming)) {
      if (!AI_FEATURES.includes(k as AiFeature)) throw new AppError(400, `Unknown AI feature: ${k}`);
      if (typeof v !== "boolean") throw new AppError(400, `featureFlags.${k} must be a boolean`);
      merged[k] = v;
    }
    values.featureFlags = merged;
  }
  if (body.monthlyTokenBudget !== undefined) {
    values.monthlyTokenBudget = normalizeBudgetInt(body.monthlyTokenBudget, "monthlyTokenBudget");
  }
  if (body.monthlyCostBudgetUsd !== undefined) {
    const usd = normalizeBudgetNumber(body.monthlyCostBudgetUsd, "monthlyCostBudgetUsd");
    values.monthlyCostBudgetMicroUsd = usd == null ? null : Math.round(usd * 1_000_000);
  }
  if (body.workflowRules !== undefined) {
    if (body.workflowRules === null) {
      values.workflowRules = null; // reset to platform defaults
    } else {
      if (typeof body.workflowRules !== "object" || Array.isArray(body.workflowRules)) {
        throw new AppError(400, "workflowRules must be an object or null");
      }
      const incoming = body.workflowRules as Record<string, unknown>;
      // Merge over the currently-effective rules so a partial PATCH only changes the
      // provided fields. Strict validation (unknown key / non-integer / out of bounds
      // => 400) — silent normalization is reserved for stored data, not client input.
      const merged: Record<string, number> = { ...current.workflowRules };
      for (const [k, v] of Object.entries(incoming)) {
        const bounds = WORKFLOW_RULE_BOUNDS[k as keyof WorkflowRules];
        if (!bounds) throw new AppError(400, `Unknown workflow rule: ${k}`);
        if (typeof v !== "number" || !Number.isInteger(v) || v < bounds.min || v > bounds.max) {
          throw new AppError(400, `workflowRules.${k} must be an integer between ${bounds.min} and ${bounds.max}`);
        }
        merged[k] = v;
      }
      values.workflowRules = merged;
    }
  }

  if (Object.keys(values).length === 0) throw new AppError(400, "No valid fields to update");

  await repo.upsertSettings(companyId, values);
  invalidateSettingsCache(companyId);
  return formatSettings(await resolveSettings(companyId));
}

function normalizeBudgetInt(raw: unknown, field: string): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new AppError(400, `${field} must be a non-negative integer or null`);
  }
  return raw;
}

function normalizeBudgetNumber(raw: unknown, field: string): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new AppError(400, `${field} must be a non-negative number or null`);
  }
  return raw;
}

// Parses ?from & ?to ISO dates; defaults to the start of the current month → now.
function parseRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const now = new Date();
  const to = parseDate(query.to) ?? now;
  const from = parseDate(query.from) ?? monthStart(now);
  if (from > to) throw new AppError(400, "from must be before to");
  return { from, to };
}

function parseDate(raw: unknown): Date | null {
  if (raw == null || raw === "") return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new AppError(400, "Invalid date");
  return d;
}

// Month budget snapshot for the tenant usage view: limits, month-to-date usage, the
// dominant percentage used, and when the (calendar-month) window resets.
async function budgetSnapshot(companyId: number) {
  const s = await resolveSettings(companyId);
  const used = await repo.monthUsage(companyId, monthStart());
  const pcts: number[] = [];
  if (s.monthlyTokenBudget != null && s.monthlyTokenBudget > 0) {
    pcts.push((used.totalTokens / s.monthlyTokenBudget) * 100);
  }
  if (s.monthlyCostBudgetMicroUsd != null && s.monthlyCostBudgetMicroUsd > 0) {
    pcts.push((used.costMicroUsd / s.monthlyCostBudgetMicroUsd) * 100);
  }
  return {
    tokenBudget: s.monthlyTokenBudget,
    costBudgetUsd: s.monthlyCostBudgetMicroUsd == null ? null : microToUsd(s.monthlyCostBudgetMicroUsd),
    usedTokens: used.totalTokens,
    usedCostUsd: microToUsd(used.costMicroUsd),
    pctUsed: pcts.length === 0 ? null : Number(Math.max(...pcts).toFixed(1)),
    periodStart: monthStart().toISOString(),
    resetAt: nextMonthStart().toISOString(),
  };
}

export async function getUsage(user: AuthUser, query: Record<string, unknown>) {
  const companyId = requireCompany(user);
  const { from, to } = parseRange(query);
  const [totals, byFeature, byDay, recent, budget] = await Promise.all([
    repo.usageTotals(user, from, to, false),
    repo.usageByFeature(user, from, to, false),
    repo.usageByDay(user, from, to, false),
    repo.recentInvocations(user, from, to, false, 25),
    budgetSnapshot(companyId),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: formatAgg(totals),
    byFeature: byFeature.map((f) => ({ feature: f.feature, ...formatAgg(f) })),
    byDay: byDay.map((d) => ({ day: d.day, ...formatAgg(d) })),
    budget,
    recent: recent.map(formatRecent),
  };
}

function parsePlatformFilters(query: Record<string, unknown>): repo.UsageFilters {
  const filters: repo.UsageFilters = {};
  if (query.companyId != null && query.companyId !== "") {
    const cid = parseInt(String(query.companyId));
    if (Number.isNaN(cid) || cid < 1) throw new AppError(400, "Invalid companyId filter");
    filters.companyId = cid;
  }
  if (typeof query.feature === "string" && query.feature !== "") {
    if (!(AI_FEATURES as readonly string[]).includes(query.feature)) {
      throw new AppError(400, "Unknown feature filter");
    }
    filters.feature = query.feature;
  }
  if (typeof query.model === "string" && query.model !== "") {
    filters.model = query.model.slice(0, 100);
  }
  return filters;
}

// Tenants at/near their month budget (>= the approaching-alert percentage).
async function tenantsNearLimit() {
  const budgets = await repo.tenantsWithBudgets();
  if (budgets.length === 0) return [];
  const usage = await repo.monthUsageByCompany(budgets.map((b) => b.companyId), monthStart());
  const out: Array<{
    companyId: number;
    companyName: string | null;
    pctUsed: number;
    usedTokens: number;
    usedCostUsd: number;
    tokenBudget: number | null;
    costBudgetUsd: number | null;
  }> = [];
  for (const b of budgets) {
    const u = usage.get(b.companyId) ?? { totalTokens: 0, costMicroUsd: 0 };
    const pcts: number[] = [];
    if (b.tokenBudget != null && b.tokenBudget > 0) pcts.push((u.totalTokens / b.tokenBudget) * 100);
    if (b.costBudgetMicroUsd != null && b.costBudgetMicroUsd > 0) pcts.push((u.costMicroUsd / b.costBudgetMicroUsd) * 100);
    if (pcts.length === 0) continue;
    const pct = Math.max(...pcts);
    if (pct < config.ai.alerts.approachingBudgetPct) continue;
    out.push({
      companyId: b.companyId,
      companyName: b.companyName,
      pctUsed: Number(pct.toFixed(1)),
      usedTokens: u.totalTokens,
      usedCostUsd: microToUsd(u.costMicroUsd),
      tokenBudget: b.tokenBudget,
      costBudgetUsd: b.costBudgetMicroUsd == null ? null : microToUsd(b.costBudgetMicroUsd),
    });
  }
  return out.sort((a, b) => b.pctUsed - a.pctUsed).slice(0, 50);
}

export async function getPlatformUsage(query: Record<string, unknown>) {
  const { from, to } = parseRange(query);
  const filters = parsePlatformFilters(query);
  const pageRaw = query.page == null || query.page === "" ? 1 : parseInt(String(query.page));
  const sizeRaw = query.pageSize == null || query.pageSize === "" ? 25 : parseInt(String(query.pageSize));
  if (Number.isNaN(pageRaw) || pageRaw < 1) throw new AppError(400, "Invalid page");
  if (Number.isNaN(sizeRaw) || sizeRaw < 1 || sizeRaw > 100) throw new AppError(400, "Invalid pageSize (1-100)");

  const [totals, byFeature, byDay, byCompany, failures, nearLimit] = await Promise.all([
    repo.usageTotals(undefined, from, to, true, filters),
    repo.usageByFeature(undefined, from, to, true, filters),
    repo.usageByDay(undefined, from, to, true, filters),
    repo.usageByCompany(from, to, filters, sizeRaw, (pageRaw - 1) * sizeRaw),
    repo.failureCategories(undefined, from, to, true, filters),
    tenantsNearLimit(),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    filters: {
      companyId: filters.companyId ?? null,
      feature: filters.feature ?? null,
      model: filters.model ?? null,
    },
    totals: formatAgg(totals),
    byFeature: byFeature.map((f) => ({ feature: f.feature, ...formatAgg(f) })),
    byDay: byDay.map((d) => ({ day: d.day, ...formatAgg(d) })),
    byCompany: {
      items: byCompany.items.map((c) => ({ companyId: c.companyId, companyName: c.companyName, ...formatAgg(c) })),
      total: byCompany.total,
      page: pageRaw,
      pageSize: sizeRaw,
    },
    failureCategories: failures,
    tenantsNearLimit: nearLimit,
  };
}

export async function getHealth(user: AuthUser) {
  const companyId = requireCompany(user);
  const settings = await resolveSettings(companyId);
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const last24h = await repo.usageTotals(user, from, to, false);
  const configured = settings.provider === "gemini" ? geminiProvider.isConfigured() : false;
  return {
    provider: settings.provider,
    model: settings.model,
    configured,
    status: configured ? "ok" : "unconfigured",
    pricingAvailable: hasPricing(settings.model),
    last24h: {
      requests: last24h.requests,
      errors: last24h.errors,
      failureRate: last24h.requests > 0 ? Number((last24h.errors / last24h.requests).toFixed(4)) : 0,
      avgLatencyMs: last24h.avgLatencyMs,
    },
    checkedAt: to.toISOString(),
  };
}

function formatRecent(r: repo.RecentInvocation) {
  return {
    id: r.id,
    feature: r.feature,
    status: r.status,
    model: r.model,
    totalTokens: r.totalTokens,
    costUsd: microToUsd(r.estimatedCostMicroUsd),
    latencyMs: r.latencyMs,
    confidence: r.confidence,
    userId: r.userId,
    createdAt: r.createdAt.toISOString(),
  };
}
