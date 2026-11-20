import { AppError } from "../middlewares/errorHandler.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import type { AuditActor } from "../lib/billing/audit.js";
import * as repo from "../repositories/platform-settings.repository.js";
import { createNotification } from "./notifications.service.js";
import { getProvider, providerFor, stubRegistered } from "../ai/providers/index.js";
import { SIMULATED_MODELS, isSimulatedModel } from "../ai/providers/stub.js";
import { ceilingCostMicroUsd, hasPricing, pricingVersion } from "../ai/pricing.js";
import {
  POLICY_PROVIDERS,
  PROVIDER_LABEL,
  availabilityImpact,
  defaultPolicy,
  otherProvider,
  parseStoredPolicy,
  resolveChain,
  validatePolicy,
  type PlatformAiPolicy,
  type PolicyCatalog,
  type PolicyProvider,
  type ResolvedChain,
} from "../ai/policy.js";

// Platform Owner → Settings → AI Providers.
//
// The policy (which providers are enabled, the primary, automatic fallback, the model of
// each, monthly spending limits, tenant pins) is ONE JSON document in platform_settings
// under the key "ai_providers". It is the only place those decisions live: no environment
// variable and no tenant setting can enable a provider the Platform Owner disabled.
//
// What is NOT in the policy, and never will be: credentials. A provider's key is read
// from the server environment by its adapter; this service only reports whether a key is
// present and whether the provider has accepted or rejected it — never the key, a part
// of it, or its length.
//
// Before the reviewed schema change is applied the table does not exist. The service
// then serves the DEFAULT policy (read-only) and refuses changes with a clear error, so
// the application can be deployed first and the table added later.

export const AI_PROVIDERS_SETTING_KEY = "ai_providers";
export const AI_PROVIDERS_AUDIT_ACTION = "platform.ai_providers.update";

export const AI_POLICY_CONFIRMATION_REQUIRED = "AI_POLICY_CONFIRMATION_REQUIRED";
export const AI_POLICY_VERSION_CONFLICT = "AI_POLICY_VERSION_CONFLICT";
export const AI_POLICY_INVALID = "AI_POLICY_INVALID";
export const AI_POLICY_STORAGE_UNAVAILABLE = "AI_POLICY_STORAGE_UNAVAILABLE";
export const AI_PLATFORM_LIMIT_REACHED = "AI_PLATFORM_LIMIT_REACHED";
export const AI_MODEL_UNPRICED = "AI_MODEL_UNPRICED";

const ENV_VAR: Record<PolicyProvider, string> = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

// Outside production a provider may be given a stub model, which the deterministic
// engine serves under that provider's name — never selectable in production.
export const catalog: PolicyCatalog = {
  modelsFor: (p) => (config.ai.enableStubProvider ? [...config.ai.models[p], ...SIMULATED_MODELS] : config.ai.models[p]),
  defaultPrimary: config.ai.defaultPrimaryProvider,
};

// ── Policy state (cached) ────────────────────────────────────────────────────────────────

export interface PolicyState {
  policy: PlatformAiPolicy;
  /** 0 = nothing has been saved: the defaults are in effect. */
  version: number;
  persisted: boolean;
  /** "unavailable" = the platform_settings table does not exist in this database yet. */
  storage: "ok" | "unavailable";
  updatedAt: Date | null;
  updatedBy: number | null;
}

let cached: { state: PolicyState; at: number } | null = null;

// While the settings table does not exist, each re-read is a failing query: look again
// once a minute instead of at every cache expiry. (A save always re-reads.)
const STORAGE_MISSING_RECHECK_MS = 60_000;
const ttlOf = (state: PolicyState) => (state.storage === "unavailable" ? Math.max(config.ai.policyCacheTtlMs, STORAGE_MISSING_RECHECK_MS) : config.ai.policyCacheTtlMs);

export function invalidatePolicyCache(): void {
  cached = null;
}

export async function getPolicyState(opts: { fresh?: boolean } = {}): Promise<PolicyState> {
  const now = Date.now();
  if (!opts.fresh && cached && now - cached.at < ttlOf(cached.state)) return cached.state;
  let state: PolicyState;
  try {
    const { available, row } = await repo.readSetting(AI_PROVIDERS_SETTING_KEY);
    state = row
      ? { policy: parseStoredPolicy(row.value, catalog), version: row.version, persisted: true, storage: "ok", updatedAt: row.updatedAt, updatedBy: row.updatedBy }
      : { policy: defaultPolicy(catalog), version: 0, persisted: false, storage: available ? "ok" : "unavailable", updatedAt: null, updatedBy: null };
  } catch (err) {
    // The policy could not be read. The last policy known to this process keeps
    // applying; with none, the request fails — a provider the owner disabled must
    // never come back because of a database hiccup.
    if (cached) {
      logger.warn({ err }, "AI provider policy could not be re-read; the last known policy stays in effect");
      cached = { state: cached.state, at: now };
      return cached.state;
    }
    logger.error({ err }, "AI provider policy could not be read and none is cached");
    throw new AppError(503, "AI is temporarily unavailable. Please try again shortly.", { code: "AI_POLICY_UNREADABLE" });
  }
  cached = { state, at: now };
  return state;
}

// ── Readiness (never a paid call, never the key) ─────────────────────────────────────────

export function providerConfigured(p: PolicyProvider): boolean {
  try {
    return getProvider(p).isConfigured();
  } catch {
    return false;
  }
}

function usable(p: PolicyProvider, model: string): boolean {
  try {
    return providerFor(p, model).isConfigured();
  } catch {
    return false;
  }
}

// What the provider last said about the configured key, in THIS process: a successful
// call verifies it, a 401/403 rejects it, a billing error or an account spend cap means
// the provider has stopped the account. Nothing is claimed that was not observed.
const credentialEvidence = new Map<PolicyProvider, { verifiedAt: Date | null; rejectedAt: Date | null; stoppedAt: Date | null }>();

function evidenceOf(p: PolicyProvider) {
  let e = credentialEvidence.get(p);
  if (!e) {
    e = { verifiedAt: null, rejectedAt: null, stoppedAt: null };
    credentialEvidence.set(p, e);
  }
  return e;
}

export type ProviderOutcome = "success" | "auth_rejected" | "account_stopped";

/** Called by the execution seam after a real (not simulated) provider call. */
export function noteProviderOutcome(provider: string, model: string, outcome: ProviderOutcome): void {
  if ((provider !== "anthropic" && provider !== "gemini") || isSimulatedModel(model)) return;
  const e = evidenceOf(provider);
  if (outcome === "success") {
    e.verifiedAt = new Date();
    e.rejectedAt = null;
    e.stoppedAt = null;
    return;
  }
  if (outcome === "auth_rejected") e.rejectedAt = new Date();
  else e.stoppedAt = new Date();
  // The Platform Owner must not have to open the settings page to learn of it.
  void notifyProviderProblem(provider, outcome === "auth_rejected" ? "key_rejected" : "account_stopped").catch((err) =>
    logger.warn({ err, provider }, "AI provider problem alert failed"),
  );
}

type CredentialState = "missing" | "present_unverified" | "verified" | "rejected" | "account_stopped";

function credentialsOf(p: PolicyProvider): { configured: boolean; state: CredentialState; checkedAt: string | null; envVar: string } {
  const configured = providerConfigured(p);
  if (!configured) return { configured, state: "missing", checkedAt: null, envVar: ENV_VAR[p] };
  const e = evidenceOf(p);
  // The most recent problem wins; a later success clears both.
  if (e.rejectedAt && (!e.stoppedAt || e.rejectedAt >= e.stoppedAt)) return { configured, state: "rejected", checkedAt: e.rejectedAt.toISOString(), envVar: ENV_VAR[p] };
  if (e.stoppedAt) return { configured, state: "account_stopped", checkedAt: e.stoppedAt.toISOString(), envVar: ENV_VAR[p] };
  if (e.verifiedAt) return { configured, state: "verified", checkedAt: e.verifiedAt.toISOString(), envVar: ENV_VAR[p] };
  return { configured, state: "present_unverified", checkedAt: null, envVar: ENV_VAR[p] };
}

// A rejected key or a stopped provider account, told to every active platform owner
// through the existing notification system — once per provider and kind per day.
async function notifyProviderProblem(provider: PolicyProvider, subkind: "key_rejected" | "account_stopped"): Promise<void> {
  if (await repo.platformAlertSent("ai_provider_problem", subkind, provider, localDayStart())) return;
  const label = PROVIDER_LABEL[provider];
  const title = subkind === "key_rejected" ? `${label} rejected the AI provider key` : `${label} account stopped by the provider`;
  const body =
    subkind === "key_rejected"
      ? `${label} answered that the key configured on the server is not valid or not permitted. Requests are served by the other provider where automatic fallback allows it. Replace ${ENV_VAR[provider]} on the server.`
      : `${label} reported a billing problem or that its account spend limit is reached. Requests routed to ${label} fail until this is resolved in the provider's console; they are not moved to the other provider.`;
  for (const userId of await repo.activePlatformOwnerIds()) {
    await createNotification({ userId, companyId: null, category: "ai", title, body, link: "/platform/settings", metadata: { kind: "ai_provider_problem", subkind, provider } });
  }
}

// ── Resolution for a request ─────────────────────────────────────────────────────────────

const LEGACY_DEFAULT: PolicyProvider = config.ai.provider === "anthropic" ? "anthropic" : "gemini";

export async function resolveChainFor(input: { companyId?: number | null; tenant?: { provider: string; model: string } | null }): Promise<ResolvedChain> {
  const { policy } = await getPolicyState();
  return resolveChain(policy, {
    tenant: input.tenant ?? null,
    companyId: input.companyId ?? null,
    stubAvailable: stubRegistered(),
    usable,
    legacyDefault: LEGACY_DEFAULT,
  });
}

// ── Platform spending limits (per provider, per calendar month) ──────────────────────────

export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
export function nextMonthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}
const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;

const spendCache = new Map<string, { month: string; microUsd: number; at: number }>();
/** Cost held for calls that are running now, per provider, by attempt id. */
const inFlight = new Map<string, Map<string, number>>();

async function monthSpend(provider: string): Promise<number> {
  const now = new Date();
  const hit = spendCache.get(provider);
  if (hit && hit.month === monthKey(now) && now.getTime() - hit.at < config.ai.platformSpendCacheTtlMs) return hit.microUsd;
  const microUsd = await repo.monthSpendOfProvider(provider, monthStart(now));
  spendCache.set(provider, { month: monthKey(now), microUsd, at: now.getTime() });
  return microUsd;
}

export function resetPlatformSpendCache(): void {
  spendCache.clear();
}

// Admission against a provider's monthly limit, before the provider is called. The rule
// is the one tenant budgets use: refuse once what is already spent, plus what calls in
// flight are holding, has reached the limit. The caller's own hold is registered FIRST
// and synchronously, so two requests admitted at the same moment each see the other.
//
// A refusal is final for the request: it is an AppError, which the fallback rule never
// retries on the other provider — a spending limit is not something to route around.
export async function admitPlatformSpend(provider: string, model: string, attemptId: string): Promise<boolean> {
  if (provider !== "anthropic" && provider !== "gemini") return false;
  const { policy } = await getPolicyState();
  const limit = policy.providers[provider].monthlyLimitMicroUsd;
  if (limit === null) return false;

  const holds = inFlight.get(provider) ?? new Map<string, number>();
  inFlight.set(provider, holds);
  const reserve = ceilingCostMicroUsd(model, config.ai.budget.reserveTokens / 2, config.ai.budget.reserveTokens / 2);
  holds.set(attemptId, reserve);
  try {
    const spent = await monthSpend(provider);
    let held = 0;
    for (const [id, v] of holds) if (id !== attemptId) held += v;
    if (spent + held >= limit) {
      holds.delete(attemptId);
      void checkSpendThresholds(provider).catch((err) => logger.warn({ err, provider }, "AI platform spend alert check failed"));
      throw new AppError(503, "AI is not available right now: the platform's monthly AI spending limit has been reached.", {
        code: AI_PLATFORM_LIMIT_REACHED,
        details: { resetAt: nextMonthStart().toISOString() },
      });
    }
    return true;
  } catch (err) {
    holds.delete(attemptId);
    throw err;
  }
}

/** Releases the hold of a finished call and adds what it really cost to the month total. */
export function settlePlatformSpend(provider: string, attemptId: string, costMicroUsd: number): void {
  inFlight.get(provider)?.delete(attemptId);
  const hit = spendCache.get(provider);
  if (hit && costMicroUsd > 0) hit.microUsd += costMicroUsd;
  if (provider === "anthropic" || provider === "gemini") {
    void checkSpendThresholds(provider).catch((err) => logger.warn({ err, provider }, "AI platform spend alert check failed"));
  }
}

function localDayStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// "Approaching" at the configured share of the limit and "reached" at the limit — each
// at most once per provider per day, to every active platform owner, through the
// existing notification system (category "ai").
async function checkSpendThresholds(provider: PolicyProvider): Promise<void> {
  const { policy } = await getPolicyState();
  const limit = policy.providers[provider].monthlyLimitMicroUsd;
  if (limit === null || limit <= 0) return;
  const spent = await monthSpend(provider);
  const pct = (spent / limit) * 100;
  const subkind = pct >= 100 ? "reached" : pct >= policy.alertThresholdPct ? "approaching" : null;
  if (!subkind) return;
  if (await repo.platformAlertSent("ai_platform_spend", subkind, provider, localDayStart())) return;
  const usd = (n: number) => `$${(n / 1_000_000).toFixed(2)}`;
  const label = PROVIDER_LABEL[provider];
  const title = subkind === "reached" ? `${label} monthly AI spending limit reached` : `${label} AI spending is at ${Math.floor(pct)}% of its monthly limit`;
  const body =
    subkind === "reached"
      ? `${label} has used ${usd(spent)} of its ${usd(limit)} monthly limit. Requests routed to ${label} are refused until the month ends or the limit is raised; they are not moved to the other provider.`
      : `${label} has used ${usd(spent)} of its ${usd(limit)} monthly limit.`;
  for (const userId of await repo.activePlatformOwnerIds()) {
    await createNotification({
      userId,
      companyId: null,
      category: "ai",
      title,
      body,
      link: "/platform/settings",
      metadata: { kind: "ai_platform_spend", subkind, provider, pct: Math.floor(pct) },
    });
  }
}

// A model without a configured price costs 0 in the ledger, so a cost budget or a
// spending limit could never stop it. Such a model is refused wherever a cost is
// enforced. (The policy only accepts priced models; this is the last line of defence
// for a price removed by configuration after the policy was saved.)
export async function assertPricedWhereCostIsEnforced(provider: string, model: string, tenantCostBudgetMicroUsd: number | null): Promise<void> {
  if (provider === "stub" || hasPricing(model)) return;
  let platformLimit: number | null = null;
  if (provider === "anthropic" || provider === "gemini") {
    platformLimit = (await getPolicyState()).policy.providers[provider].monthlyLimitMicroUsd;
  }
  if (tenantCostBudgetMicroUsd === null && platformLimit === null) return;
  logger.error({ provider, model }, "AI request refused: the model has no configured price while a cost budget or spending limit is enforced");
  throw new AppError(503, "AI is not available right now. Please contact your administrator.", { code: AI_MODEL_UNPRICED });
}

// ── Status for the settings page ─────────────────────────────────────────────────────────

function modelInfo(p: PolicyProvider) {
  return catalog.modelsFor(p).map((id) => {
    const price = config.ai.pricing[id];
    return {
      id,
      simulated: isSimulatedModel(id),
      priced: Boolean(price),
      // micro-USD per 1,000 tokens is, digit for digit, milli-USD per million tokens.
      inputMicroUsdPerMTok: price ? price.inputPer1kMicroUsd * 1000 : null,
      outputMicroUsdPerMTok: price ? price.outputPer1kMicroUsd * 1000 : null,
      longContext: price?.longContext
        ? {
            aboveInputTokens: price.longContext.aboveInputTokens,
            inputMicroUsdPerMTok: price.longContext.inputPer1kMicroUsd * 1000,
            outputMicroUsdPerMTok: price.longContext.outputPer1kMicroUsd * 1000,
          }
        : null,
    };
  });
}

function summarise(policy: PlatformAiPolicy) {
  return {
    primary: policy.primary,
    fallbackEnabled: policy.fallbackEnabled,
    alertThresholdPct: policy.alertThresholdPct,
    providers: Object.fromEntries(POLICY_PROVIDERS.map((p) => [p, { ...policy.providers[p] }])),
    tenantOverrides: policy.tenantOverrides.map((o) => ({ ...o })),
  };
}

function changedFields(before: PlatformAiPolicy, after: PlatformAiPolicy): string[] {
  const out: string[] = [];
  if (before.primary !== after.primary) out.push("primary");
  if (before.fallbackEnabled !== after.fallbackEnabled) out.push("fallbackEnabled");
  if (before.alertThresholdPct !== after.alertThresholdPct) out.push("alertThresholdPct");
  for (const p of POLICY_PROVIDERS) {
    for (const k of ["enabled", "model", "monthlyLimitMicroUsd"] as const) {
      if (before.providers[p][k] !== after.providers[p][k]) out.push(`providers.${p}.${k}`);
    }
  }
  if (JSON.stringify(before.tenantOverrides) !== JSON.stringify(after.tenantOverrides)) out.push("tenantOverrides");
  return out;
}

export async function getStatus() {
  const state = await getPolicyState({ fresh: true });
  const { policy } = state;
  const from = monthStart();
  const usage = await repo.monthUsageByProvider(from);
  const names = await repo.companyNames(policy.tenantOverrides.map((o) => o.companyId));
  const editor = state.updatedBy != null ? (await repo.userNames([state.updatedBy])).get(state.updatedBy) ?? null : null;
  const chain = resolveChain(policy, { stubAvailable: stubRegistered(), usable, legacyDefault: LEGACY_DEFAULT });

  const providers = POLICY_PROVIDERS.map((p) => {
    const rows = usage.filter((u) => u.provider === p);
    const sum = (k: "providerCalls" | "succeeded" | "failed" | "servedAsFallback" | "inputTokens" | "outputTokens" | "costMicroUsd") => rows.reduce((n, r) => n + r[k], 0);
    const costMicroUsd = sum("costMicroUsd");
    const limit = policy.providers[p].monthlyLimitMicroUsd;
    const usedPct = limit !== null && limit > 0 ? Math.min(999, Math.floor((costMicroUsd / limit) * 100)) : limit === 0 ? 100 : null;
    const limitState = limit === null ? "none" : costMicroUsd >= limit ? "reached" : usedPct !== null && usedPct >= policy.alertThresholdPct ? "approaching" : "ok";
    return {
      provider: p,
      label: PROVIDER_LABEL[p],
      enabled: policy.providers[p].enabled,
      model: policy.providers[p].model,
      credentials: credentialsOf(p),
      models: modelInfo(p),
      month: {
        providerCalls: sum("providerCalls"),
        succeeded: sum("succeeded"),
        failed: sum("failed"),
        servedAsFallback: sum("servedAsFallback"),
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        costMicroUsd,
        byModel: rows
          .filter((r) => r.providerCalls > 0 || r.costMicroUsd > 0)
          .map((r) => ({ model: r.model, providerCalls: r.providerCalls, succeeded: r.succeeded, failed: r.failed, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costMicroUsd: r.costMicroUsd, priced: hasPricing(r.model) })),
      },
      limit: { monthlyLimitMicroUsd: limit, usedPct, state: limitState },
    };
  });

  const notes: string[] = [];
  for (const s of chain.skipped) {
    notes.push(s.why === "disabled" ? `${PROVIDER_LABEL[s.provider]} is disabled.` : `${PROVIDER_LABEL[s.provider]} has no credentials on the server (${ENV_VAR[s.provider]} is not set), so it serves no request.`);
  }
  if (chain.candidates.length === 1 && policy.fallbackEnabled) notes.push("Automatic fallback is on, but there is no second provider that could take over.");
  if (chain.candidates[0] && chain.candidates[0].provider !== policy.primary) {
    notes.push(`${PROVIDER_LABEL[policy.primary]} is the primary, but ${PROVIDER_LABEL[chain.candidates[0].provider as PolicyProvider]} serves requests for now.`);
  }

  return {
    policy: {
      primary: policy.primary,
      fallbackEnabled: policy.fallbackEnabled,
      alertThresholdPct: policy.alertThresholdPct,
      providers: {
        anthropic: { ...policy.providers.anthropic },
        gemini: { ...policy.providers.gemini },
      },
      tenantOverrides: policy.tenantOverrides.map((o) => ({ companyId: o.companyId, companyName: names.get(o.companyId) ?? null, provider: o.provider, model: o.model })),
    },
    version: state.version,
    persisted: state.persisted,
    storage: state.storage,
    updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null,
    updatedByName: editor,
    simulationAvailable: config.ai.enableStubProvider,
    providers,
    effective: {
      provider: chain.candidates[0]?.provider ?? null,
      model: chain.candidates[0]?.model ?? null,
      fallbackProvider: chain.candidates[1]?.provider ?? null,
      fallbackModel: chain.candidates[1]?.model ?? null,
      unavailable: chain.unavailable,
      notes,
    },
    period: { from: from.toISOString(), resetAt: nextMonthStart().toISOString() },
    pricingVersion: pricingVersion(),
  };
}

// ── Update ───────────────────────────────────────────────────────────────────────────────

export async function updatePolicy(actor: AuditActor, body: { policy: unknown; expectedVersion: number; confirm?: boolean }) {
  const state = await getPolicyState({ fresh: true });
  if (state.storage === "unavailable") {
    throw new AppError(503, "AI provider settings cannot be saved yet: the platform settings storage has not been added to this database. The default policy stays in effect.", { code: AI_POLICY_STORAGE_UNAVAILABLE });
  }

  const checked = validatePolicy(body.policy, catalog);
  if (!checked.ok) {
    throw new AppError(400, checked.issues[0]?.message ?? "The AI provider policy is not valid.", { code: AI_POLICY_INVALID, details: { issues: checked.issues } });
  }
  const next = checked.value;

  // A NEW pin must name an existing company: a pin for an unknown company would
  // silently do nothing. A company that was pinned earlier and has been deleted since is
  // dropped from the policy here — it must not block every later save (the page always
  // sends the complete policy, stale pin included).
  const names = await repo.companyNames(next.tenantOverrides.map((o) => o.companyId));
  const pinnedBefore = new Set(state.policy.tenantOverrides.map((o) => o.companyId));
  const missing = next.tenantOverrides.findIndex((o) => !names.has(o.companyId) && !pinnedBefore.has(o.companyId));
  const droppedOverrides = next.tenantOverrides.filter((o) => !names.has(o.companyId) && pinnedBefore.has(o.companyId)).map((o) => o.companyId);
  if (droppedOverrides.length > 0) next.tenantOverrides = next.tenantOverrides.filter((o) => names.has(o.companyId));
  if (missing !== -1) {
    throw new AppError(400, `Company ${next.tenantOverrides[missing].companyId} does not exist.`, {
      code: AI_POLICY_INVALID,
      details: { issues: [{ field: `tenantOverrides.${missing}.companyId`, code: "POLICY_OVERRIDE_COMPANY_UNKNOWN", message: `Company ${next.tenantOverrides[missing].companyId} does not exist.` }] },
    });
  }

  if (body.expectedVersion !== state.version) {
    throw new AppError(409, "These settings were changed by someone else. Reload them and apply your change again.", { code: AI_POLICY_VERSION_CONFLICT, details: { currentVersion: state.version } });
  }

  const fields = changedFields(state.policy, next);
  if (fields.length === 0 && state.persisted) return getStatus();

  // A change that reduces what AI can do must be confirmed — on the server, so no
  // client can skip the question.
  const impact = availabilityImpact(state.policy, next, usable);
  // A provider at or above its limit refuses every request routed to it. Say so
  // whenever the change sets that limit or sends requests its way: a new or lower
  // limit, a provider switched back on, a new primary, a newly pinned company.
  for (const p of POLICY_PROVIDERS) {
    const limit = next.providers[p].monthlyLimitMicroUsd;
    if (limit === null || !next.providers[p].enabled) continue;
    const before = state.policy;
    const pinnedToIt = new Set(before.tenantOverrides.filter((o) => o.provider === p).map((o) => o.companyId));
    const routesMore =
      limit !== before.providers[p].monthlyLimitMicroUsd ||
      !before.providers[p].enabled ||
      (next.primary === p && before.primary !== p) ||
      next.tenantOverrides.some((o) => o.provider === p && !pinnedToIt.has(o.companyId));
    if (!routesMore) continue;
    const spent = await repo.monthSpendOfProvider(p, monthStart());
    if (spent >= limit) {
      impact.warnings.push(
        `${PROVIDER_LABEL[p]} has already spent $${(spent / 1_000_000).toFixed(2)} this month, which is at or above its limit of $${(limit / 1_000_000).toFixed(2)}: requests routed to ${PROVIDER_LABEL[p]} will be refused immediately, and are not moved to the other provider.`,
      );
    }
  }
  if (impact.warnings.length > 0 && body.confirm !== true) {
    throw new AppError(409, "This change affects AI availability and must be confirmed.", { code: AI_POLICY_CONFIRMATION_REQUIRED, details: { warnings: impact.warnings, disablesAllAi: impact.disablesAllAi } });
  }

  const result = await repo.writeSetting({
    key: AI_PROVIDERS_SETTING_KEY,
    value: summarise(next) as unknown as Record<string, unknown>,
    expectedVersion: state.version,
    actor,
    audit: {
      action: AI_PROVIDERS_AUDIT_ACTION,
      metadata: { changed: fields, before: summarise(state.policy), after: summarise(next), confirmed: body.confirm === true, warnings: impact.warnings, ...(droppedOverrides.length > 0 ? { droppedOverrides } : {}) },
    },
  });
  if (result.status === "unavailable") {
    throw new AppError(503, "AI provider settings cannot be saved yet: the platform settings storage has not been added to this database.", { code: AI_POLICY_STORAGE_UNAVAILABLE });
  }
  if (result.status === "conflict") {
    invalidatePolicyCache();
    throw new AppError(409, "These settings were changed by someone else. Reload them and apply your change again.", { code: AI_POLICY_VERSION_CONFLICT, details: { currentVersion: result.currentVersion } });
  }

  // Takes effect at once in this process; other processes follow within the cache TTL.
  // The month totals are re-read too, so a new limit is judged against current spend.
  invalidatePolicyCache();
  resetPlatformSpendCache();
  logger.info({ actorUserId: actor.userId, changed: fields, version: result.row.version }, "AI provider policy updated");
  return getStatus();
}

export { otherProvider };
