// The Platform Owner's AI provider policy — which providers may serve requests, which
// one is preferred, whether the other may be tried when the first cannot serve, the model
// each uses and how much each may spend in a month — and the single rule that turns the
// policy into the provider(s) a request will use.
//
// Pure: no database, no SDK, no configuration read. The service layer
// (services/platform-ai.service.ts) stores the policy and supplies the facts this file
// needs (which models exist, which provider has credentials).

export const POLICY_PROVIDERS = ["anthropic", "gemini"] as const;
export type PolicyProvider = (typeof POLICY_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<PolicyProvider, string> = { anthropic: "Claude", gemini: "Gemini" };

export interface ProviderPolicy {
  /** A disabled provider never serves a request — not as primary, not as fallback, not by a tenant override. */
  enabled: boolean;
  model: string;
  /** Monthly spending limit in micro-USD; null = no limit. */
  monthlyLimitMicroUsd: number | null;
}

/** A tenant the Platform Owner has pinned to one provider (and optionally one of its models). */
export interface TenantOverride {
  companyId: number;
  provider: PolicyProvider;
  model: string | null;
}

export interface PlatformAiPolicy {
  providers: Record<PolicyProvider, ProviderPolicy>;
  primary: PolicyProvider;
  /** Try the other enabled provider once when the first cannot serve the request. */
  fallbackEnabled: boolean;
  /** Alert when a provider's month-to-date spend reaches this share (percent) of its limit. */
  alertThresholdPct: number;
  tenantOverrides: TenantOverride[];
}

export const MAX_TENANT_OVERRIDES = 200;
/** 2,147.48 USD-thousands would overflow nothing here; the cap keeps a typo from becoming a limit. */
export const MAX_MONTHLY_LIMIT_MICRO_USD = 1_000_000_000_000; // 1,000,000 USD

export function otherProvider(p: PolicyProvider): PolicyProvider {
  return p === "anthropic" ? "gemini" : "anthropic";
}

export function isPolicyProvider(v: unknown): v is PolicyProvider {
  return v === "anthropic" || v === "gemini";
}

export interface PolicyCatalog {
  /** Models selectable for a provider; the first is its default. */
  modelsFor(provider: PolicyProvider): readonly string[];
  defaultPrimary: PolicyProvider;
}

// The owner's stated preference, and what applies while nothing has been saved: both
// providers enabled, Claude preferred, automatic fallback on, no spending limits.
export function defaultPolicy(catalog: PolicyCatalog): PlatformAiPolicy {
  return {
    providers: {
      anthropic: { enabled: true, model: catalog.modelsFor("anthropic")[0] ?? "", monthlyLimitMicroUsd: null },
      gemini: { enabled: true, model: catalog.modelsFor("gemini")[0] ?? "", monthlyLimitMicroUsd: null },
    },
    primary: catalog.defaultPrimary,
    fallbackEnabled: true,
    alertThresholdPct: 80,
    tenantOverrides: [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}

// A STORED policy, read tolerantly: every field falls back to its default on its own, so
// a document written by an older or newer version can never take AI down or re-enable
// what it does not mention. A model that is no longer selectable falls back to the
// provider's default model. (Input from a client is validated strictly — validatePolicy.)
export function parseStoredPolicy(raw: unknown, catalog: PolicyCatalog): PlatformAiPolicy {
  const base = defaultPolicy(catalog);
  if (!isRecord(raw)) return base;
  const providers = isRecord(raw.providers) ? raw.providers : {};
  for (const p of POLICY_PROVIDERS) {
    const stored = isRecord(providers[p]) ? (providers[p] as Record<string, unknown>) : {};
    if (typeof stored.enabled === "boolean") base.providers[p].enabled = stored.enabled;
    if (typeof stored.model === "string" && catalog.modelsFor(p).includes(stored.model)) base.providers[p].model = stored.model;
    if (stored.monthlyLimitMicroUsd === null || intInRange(stored.monthlyLimitMicroUsd, 0, MAX_MONTHLY_LIMIT_MICRO_USD)) {
      base.providers[p].monthlyLimitMicroUsd = stored.monthlyLimitMicroUsd as number | null;
    }
  }
  if (isPolicyProvider(raw.primary)) base.primary = raw.primary;
  if (typeof raw.fallbackEnabled === "boolean") base.fallbackEnabled = raw.fallbackEnabled;
  if (intInRange(raw.alertThresholdPct, 1, 100)) base.alertThresholdPct = raw.alertThresholdPct;
  if (Array.isArray(raw.tenantOverrides)) {
    const seen = new Set<number>();
    for (const o of raw.tenantOverrides.slice(0, MAX_TENANT_OVERRIDES)) {
      if (!isRecord(o) || !intInRange(o.companyId, 1, 2_147_483_647) || !isPolicyProvider(o.provider) || seen.has(o.companyId)) continue;
      const model = typeof o.model === "string" && catalog.modelsFor(o.provider).includes(o.model) ? o.model : null;
      seen.add(o.companyId);
      base.tenantOverrides.push({ companyId: o.companyId, provider: o.provider, model });
    }
  }
  return base;
}

export interface PolicyIssue {
  field: string;
  code: string;
  message: string;
}

// A policy sent by a client: a COMPLETE document, validated strictly. Nothing is
// defaulted, coerced or dropped — an unknown key, a wrong type or a model that is not
// selectable is an error naming the field.
export function validatePolicy(input: unknown, catalog: PolicyCatalog): { ok: true; value: PlatformAiPolicy } | { ok: false; issues: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];
  const bad = (field: string, code: string, message: string) => issues.push({ field, code, message });
  if (!isRecord(input)) return { ok: false, issues: [{ field: "policy", code: "POLICY_INVALID", message: "The policy must be an object." }] };

  const allowed = new Set(["providers", "primary", "fallbackEnabled", "alertThresholdPct", "tenantOverrides"]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) bad(k, "POLICY_UNKNOWN_FIELD", `Unknown field: ${k}`);

  const value = defaultPolicy(catalog);
  const providers = input.providers;
  if (!isRecord(providers)) {
    bad("providers", "POLICY_PROVIDERS_INVALID", "providers must list both anthropic and gemini.");
  } else {
    for (const k of Object.keys(providers)) if (!isPolicyProvider(k)) bad(`providers.${k}`, "POLICY_PROVIDER_UNKNOWN", `Unknown provider: ${k}`);
    for (const p of POLICY_PROVIDERS) {
      const entry = providers[p];
      if (!isRecord(entry)) {
        bad(`providers.${p}`, "POLICY_PROVIDER_MISSING", `providers.${p} is required.`);
        continue;
      }
      for (const k of Object.keys(entry)) if (!["enabled", "model", "monthlyLimitMicroUsd"].includes(k)) bad(`providers.${p}.${k}`, "POLICY_UNKNOWN_FIELD", `Unknown field: providers.${p}.${k}`);
      if (typeof entry.enabled !== "boolean") bad(`providers.${p}.enabled`, "POLICY_ENABLED_INVALID", "enabled must be true or false.");
      else value.providers[p].enabled = entry.enabled;
      const models = catalog.modelsFor(p);
      if (typeof entry.model !== "string" || !models.includes(entry.model)) {
        bad(`providers.${p}.model`, "POLICY_MODEL_NOT_SUPPORTED", `The ${PROVIDER_LABEL[p]} model must be one of: ${models.join(", ")}`);
      } else value.providers[p].model = entry.model;
      if (entry.monthlyLimitMicroUsd === null) value.providers[p].monthlyLimitMicroUsd = null;
      else if (intInRange(entry.monthlyLimitMicroUsd, 0, MAX_MONTHLY_LIMIT_MICRO_USD)) value.providers[p].monthlyLimitMicroUsd = entry.monthlyLimitMicroUsd;
      else bad(`providers.${p}.monthlyLimitMicroUsd`, "POLICY_LIMIT_INVALID", `The monthly limit must be null (no limit) or a whole number of micro-dollars from 0 to ${MAX_MONTHLY_LIMIT_MICRO_USD}.`);
    }
  }

  if (!isPolicyProvider(input.primary)) bad("primary", "POLICY_PRIMARY_INVALID", "primary must be anthropic or gemini.");
  else value.primary = input.primary;
  if (typeof input.fallbackEnabled !== "boolean") bad("fallbackEnabled", "POLICY_FALLBACK_INVALID", "fallbackEnabled must be true or false.");
  else value.fallbackEnabled = input.fallbackEnabled;
  if (!intInRange(input.alertThresholdPct, 1, 100)) bad("alertThresholdPct", "POLICY_ALERT_INVALID", "alertThresholdPct must be a whole number from 1 to 100.");
  else value.alertThresholdPct = input.alertThresholdPct;

  if (!Array.isArray(input.tenantOverrides)) {
    bad("tenantOverrides", "POLICY_OVERRIDES_INVALID", "tenantOverrides must be a list (it may be empty).");
  } else if (input.tenantOverrides.length > MAX_TENANT_OVERRIDES) {
    bad("tenantOverrides", "POLICY_OVERRIDES_TOO_MANY", `At most ${MAX_TENANT_OVERRIDES} tenant overrides.`);
  } else {
    const seen = new Set<number>();
    for (const [i, o] of input.tenantOverrides.entries()) {
      const f = `tenantOverrides.${i}`;
      if (!isRecord(o)) {
        bad(f, "POLICY_OVERRIDE_INVALID", "A tenant override needs companyId, provider and model.");
        continue;
      }
      for (const k of Object.keys(o)) if (!["companyId", "provider", "model"].includes(k)) bad(`${f}.${k}`, "POLICY_UNKNOWN_FIELD", `Unknown field: ${f}.${k}`);
      if (!intInRange(o.companyId, 1, 2_147_483_647)) {
        bad(`${f}.companyId`, "POLICY_OVERRIDE_COMPANY_INVALID", "companyId must be a company id.");
        continue;
      }
      if (seen.has(o.companyId)) {
        bad(`${f}.companyId`, "POLICY_OVERRIDE_DUPLICATE", `Company ${o.companyId} is listed more than once.`);
        continue;
      }
      if (!isPolicyProvider(o.provider)) {
        bad(`${f}.provider`, "POLICY_PROVIDER_UNKNOWN", "provider must be anthropic or gemini.");
        continue;
      }
      if (o.model !== null && (typeof o.model !== "string" || !catalog.modelsFor(o.provider).includes(o.model))) {
        bad(`${f}.model`, "POLICY_MODEL_NOT_SUPPORTED", `model must be null (the provider's selected model) or one of: ${catalog.modelsFor(o.provider).join(", ")}`);
        continue;
      }
      seen.add(o.companyId);
      value.tenantOverrides.push({ companyId: o.companyId, provider: o.provider, model: (o.model as string | null) ?? null });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────

export interface ChainCandidate {
  /** "stub" only for a tenant on the non-production test provider. */
  provider: PolicyProvider | "stub";
  model: string;
  role: "primary" | "fallback";
}

export interface ResolvedChain {
  /** What will be tried, in order: one provider, or two when a fallback is allowed. Empty = nothing can serve. */
  candidates: ChainCandidate[];
  source: "tenant_stub" | "tenant_override" | "platform";
  /** Why nothing can serve, when `candidates` is empty. */
  unavailable: "none_enabled" | "none_configured" | null;
  /** The provider and model to REPORT (settings, health) — also when nothing can serve. */
  display: { provider: string; model: string };
  skipped: Array<{ provider: PolicyProvider; why: "disabled" | "not_configured" }>;
}

export interface ResolveInput {
  /** The tenant's stored provider and model (ai_settings), if the request has a tenant. */
  tenant?: { provider: string; model: string } | null;
  companyId?: number | null;
  /** True where the deterministic test provider is registered (never in production). */
  stubAvailable: boolean;
  /** Can this provider serve this model now (credentials present)? Must not call the provider. */
  usable(provider: PolicyProvider, model: string): boolean;
  /** The provider reported while nothing has credentials (the pre-policy default). */
  legacyDefault: PolicyProvider;
}

// The one rule.
//
//  1. A tenant on the test provider (non-production only) uses it, alone.
//  2. Otherwise the order of preference is the tenant's override provider (when the
//     Platform Owner has pinned the tenant AND that provider is enabled), or else the
//     platform primary — followed by the other provider.
//  3. A DISABLED provider is removed. Nothing brings it back: not the primary setting,
//     not a tenant override, not the tenant's own stored preference.
//  4. A provider WITHOUT CREDENTIALS is skipped. This is what keeps an environment
//     that only has a Gemini key on Gemini while Claude is the stated primary.
//  5. The first that remains serves the request. The second is kept as the one fallback
//     only when automatic fallback is on.
//
// A tenant's own stored provider (ai_settings.provider) never selects a real provider:
// choosing the vendor is the Platform Owner's decision.
export function resolveChain(policy: PlatformAiPolicy, input: ResolveInput): ResolvedChain {
  if (input.tenant && input.tenant.provider === "stub" && input.stubAvailable) {
    const c: ChainCandidate = { provider: "stub", model: input.tenant.model, role: "primary" };
    return { candidates: [c], source: "tenant_stub", unavailable: null, display: { provider: "stub", model: c.model }, skipped: [] };
  }

  const pinned = input.companyId != null ? policy.tenantOverrides.find((o) => o.companyId === input.companyId) : undefined;
  const override = pinned && policy.providers[pinned.provider].enabled ? pinned : undefined;
  const first = override ? override.provider : policy.primary;
  const order: PolicyProvider[] = [first, otherProvider(first)];
  const modelOf = (p: PolicyProvider) => (override && override.provider === p && override.model ? override.model : policy.providers[p].model);

  const skipped: ResolvedChain["skipped"] = [];
  const ready: Array<{ provider: PolicyProvider; model: string }> = [];
  const enabled: PolicyProvider[] = [];
  for (const p of order) {
    if (!policy.providers[p].enabled) {
      skipped.push({ provider: p, why: "disabled" });
      continue;
    }
    enabled.push(p);
    const model = modelOf(p);
    if (input.usable(p, model)) ready.push({ provider: p, model });
    else skipped.push({ provider: p, why: "not_configured" });
  }

  const source = override ? "tenant_override" : "platform";
  if (ready.length === 0) {
    // Nothing can serve. Report the provider the system reported before the policy
    // existed if it is enabled, else the first enabled one, else the primary.
    const shown = enabled.includes(input.legacyDefault) ? input.legacyDefault : enabled[0] ?? policy.primary;
    return {
      candidates: [],
      source,
      unavailable: enabled.length === 0 ? "none_enabled" : "none_configured",
      display: { provider: shown, model: modelOf(shown) },
      skipped,
    };
  }

  const candidates: ChainCandidate[] = [{ ...ready[0], role: "primary" }];
  if (policy.fallbackEnabled && ready[1]) candidates.push({ ...ready[1], role: "fallback" });
  return { candidates, source, unavailable: null, display: { provider: ready[0].provider, model: ready[0].model }, skipped };
}

// ── What a change does to availability (for the confirmation the UI must ask for) ────────

export interface AvailabilityImpact {
  /** Human sentences, most serious first. Empty = the change does not reduce availability. */
  warnings: string[];
  /** True when the change takes AI from working to not working at all. */
  disablesAllAi: boolean;
}

// `usable(provider, model)` is the same fact resolveChain uses: can this provider serve
// this model now (credentials present)?
export function availabilityImpact(
  before: PlatformAiPolicy,
  after: PlatformAiPolicy,
  usable: (p: PolicyProvider, model: string) => boolean,
): AvailabilityImpact {
  const warnings: string[] = [];
  const configured = (p: PolicyProvider) => usable(p, after.providers[p].model);
  const usableAfter = POLICY_PROVIDERS.filter((p) => after.providers[p].enabled && configured(p));
  const usableBefore = POLICY_PROVIDERS.filter((p) => before.providers[p].enabled && usable(p, before.providers[p].model));
  // Only a change that TAKES AI DOWN is announced as such; where nothing could serve
  // before either (no key configured yet), the specific warnings below still apply.
  const disablesAllAi = usableAfter.length === 0 && usableBefore.length > 0;
  if (disablesAllAi) {
    warnings.push(
      POLICY_PROVIDERS.every((p) => !after.providers[p].enabled)
        ? "Both providers will be disabled: every AI feature stops for every tenant. Manual, QR and NFC capture keep working."
        : "No enabled provider has credentials: every AI feature stops for every tenant until a key is configured. Manual, QR and NFC capture keep working.",
    );
  }
  for (const p of POLICY_PROVIDERS) {
    if (before.providers[p].enabled && !after.providers[p].enabled && !disablesAllAi) {
      warnings.push(`${PROVIDER_LABEL[p]} will be disabled: it will serve no request, as primary, as fallback or for a pinned tenant.`);
    }
  }
  if (!disablesAllAi && usableAfter.length < usableBefore.length && usableAfter.length === 1) {
    warnings.push(`Only ${PROVIDER_LABEL[usableAfter[0]]} will be able to serve requests: there is nothing to fall back to if it fails.`);
  }
  if (before.fallbackEnabled && !after.fallbackEnabled && !disablesAllAi) {
    warnings.push("Automatic fallback will be off: when the provider in use cannot serve a request, the request fails.");
  }
  if (before.primary !== after.primary && !disablesAllAi) {
    const p = after.primary;
    const o = otherProvider(p);
    const otherServes = after.providers[o].enabled && configured(o);
    if (!after.providers[p].enabled) {
      warnings.push(`${PROVIDER_LABEL[p]} is set as primary but is disabled${otherServes ? `: ${PROVIDER_LABEL[o]} will serve requests` : ""}.`);
    } else if (!configured(p)) {
      warnings.push(`${PROVIDER_LABEL[p]} is set as primary but has no credentials yet${otherServes ? `: ${PROVIDER_LABEL[o]} keeps serving requests until a key is configured` : ""}.`);
    } else {
      warnings.push(`New requests of every tenant without an override will go to ${PROVIDER_LABEL[p]}.`);
    }
  }
  for (const p of POLICY_PROVIDERS) {
    const b = before.providers[p].monthlyLimitMicroUsd;
    const a = after.providers[p].monthlyLimitMicroUsd;
    if (a !== null && (b === null || a < b)) {
      warnings.push(`${PROVIDER_LABEL[p]} gets a ${b === null ? "" : "lower "}monthly spending limit: once it is reached, requests routed to ${PROVIDER_LABEL[p]} are refused for the rest of the month and are not moved to the other provider.`);
    }
  }
  return { warnings, disablesAllAi };
}
