import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import * as repo from "../repositories/ai.repository.js";
import type { RawAgg } from "../repositories/ai.repository.js";
import { AI_FEATURES, type AiFeature, type AiUsage } from "../ai/types.js";
import { availableProviders } from "../ai/providers/index.js";
import { geminiProvider } from "../ai/providers/gemini.js";
import { hasPricing } from "../ai/pricing.js";
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

function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Enforcement gate called before an AI provider call. No-op when there is no tenant
// context (system call) or when settings are at their defaults. Throws a clear
// AppError when an admin has disabled the feature (403) or a set budget is
// exhausted (429).
export async function ensureAiAllowed(companyId: number | null | undefined, feature: AiFeature): Promise<void> {
  if (companyId == null) return;
  const s = await resolveSettings(companyId);
  if (!s.enabled) throw new AppError(403, "AI features are disabled for your organization");
  if (s.featureFlags[feature] === false) {
    throw new AppError(403, `AI ${humanFeature(feature)} is disabled for your organization`);
  }
  if (s.monthlyTokenBudget != null || s.monthlyCostBudgetMicroUsd != null) {
    const used = await repo.monthUsage(companyId, monthStart());
    if (s.monthlyTokenBudget != null && used.totalTokens >= s.monthlyTokenBudget) {
      throw new AppError(429, "Monthly AI token budget exhausted for your organization");
    }
    if (s.monthlyCostBudgetMicroUsd != null && used.costMicroUsd >= s.monthlyCostBudgetMicroUsd) {
      throw new AppError(429, "Monthly AI cost budget exhausted for your organization");
    }
  }
}

// Append one row to the ledger. NEVER throws — recording must not affect the AI
// result path. Fire-and-forget from callers.
export async function recordInvocation(params: {
  ctx?: { companyId?: number | null; userId?: number | null };
  feature: AiFeature;
  provider: string;
  model: string;
  promptKey: string;
  promptVersion: number;
  status: "success" | "error" | "timeout";
  usage: AiUsage;
  costMicroUsd: number;
  latencyMs: number;
  confidence?: number | null;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    await repo.insertInvocation({
      companyId: params.ctx?.companyId ?? null,
      userId: params.ctx?.userId ?? null,
      feature: params.feature,
      provider: params.provider,
      model: params.model,
      promptKey: params.promptKey,
      promptVersion: params.promptVersion,
      status: params.status,
      inputTokens: params.usage.inputTokens,
      outputTokens: params.usage.outputTokens,
      totalTokens: params.usage.totalTokens,
      estimatedCostMicroUsd: params.costMicroUsd,
      confidence: params.confidence ?? null,
      latencyMs: params.latencyMs,
      errorMessage: params.errorMessage ?? null,
    });
  } catch (err) {
    logger.error({ err, feature: params.feature }, "Failed to record AI invocation");
  }
}

// ---- Presentation helpers -------------------------------------------------

function microToUsd(micro: number): number {
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

export async function getUsage(user: AuthUser, query: Record<string, unknown>) {
  requireCompany(user);
  const { from, to } = parseRange(query);
  const [totals, byFeature, recent] = await Promise.all([
    repo.usageTotals(user, from, to, false),
    repo.usageByFeature(user, from, to, false),
    repo.recentInvocations(user, from, to, false, 25),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: formatAgg(totals),
    byFeature: byFeature.map((f) => ({ feature: f.feature, ...formatAgg(f) })),
    recent: recent.map(formatRecent),
  };
}

export async function getPlatformUsage(query: Record<string, unknown>) {
  const { from, to } = parseRange(query);
  const [totals, byFeature, byCompany] = await Promise.all([
    repo.usageTotals(undefined, from, to, true),
    repo.usageByFeature(undefined, from, to, true),
    repo.usageByCompany(from, to),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: formatAgg(totals),
    byFeature: byFeature.map((f) => ({ feature: f.feature, ...formatAgg(f) })),
    byCompany: byCompany.map((c) => ({
      companyId: c.companyId,
      companyName: c.companyName,
      ...formatAgg(c),
    })),
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
