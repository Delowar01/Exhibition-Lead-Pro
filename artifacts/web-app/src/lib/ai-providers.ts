import { ApiError, type PlatformAiPolicy, type PlatformAiProviders, type PlatformAiProviderStatus } from "@workspace/api-client-react";
import { decimalToScaled, formatMicroUsd, scaledToDecimal } from "@/lib/money";

/**
 * Platform Owner → Settings → AI Providers: everything the page works out, kept apart from
 * the page so it can be tested on its own.
 *
 * The server owns the policy and every decision about it: which changes need a
 * confirmation, whether a model may be selected, whether a company exists. This file only
 * turns what the owner typed into the document the API takes (exactly — a spending limit is
 * converted on its digits, never through a floating-point number), and turns what the API
 * answers into words.
 */

export type ProviderName = "anthropic" | "gemini";
export const PROVIDERS: readonly ProviderName[] = ["anthropic", "gemini"];
export const PROVIDER_LABEL: Record<ProviderName, string> = { anthropic: "Claude", gemini: "Gemini" };
export const PROVIDER_VENDOR: Record<ProviderName, string> = { anthropic: "Anthropic", gemini: "Google" };

/** The server's ceiling for a monthly limit: 1,000,000 US dollars, in millionths of a dollar. */
export const MAX_LIMIT_MICRO_USD = 1_000_000_000_000;

export function otherProvider(p: ProviderName): ProviderName {
  return p === "anthropic" ? "gemini" : "anthropic";
}

export function providerLabel(p: string | null | undefined): string {
  return p === "anthropic" || p === "gemini" ? PROVIDER_LABEL[p] : p === "stub" ? "Test provider" : (p ?? "—");
}

// ── The form ──────────────────────────────────────────────────────────────────────────────

export interface ProviderDraft {
  enabled: boolean;
  model: string;
  /** US dollars as typed; empty = no limit. */
  limitText: string;
}

export interface OverrideDraft {
  companyId: number;
  companyName: string | null;
  provider: ProviderName;
  /** null = the provider's selected model. */
  model: string | null;
}

export interface PolicyDraft {
  primary: ProviderName;
  fallbackEnabled: boolean;
  /** Percent as typed. */
  alertText: string;
  providers: Record<ProviderName, ProviderDraft>;
  overrides: OverrideDraft[];
}

export function limitToText(microUsd: number | null): string {
  if (microUsd === null) return "";
  return scaledToDecimal(microUsd, 6) ?? "";
}

export function draftFromStatus(status: PlatformAiProviders): PolicyDraft {
  const p = status.policy;
  return {
    primary: p.primary,
    fallbackEnabled: p.fallbackEnabled,
    alertText: String(p.alertThresholdPct),
    providers: {
      anthropic: { enabled: p.providers.anthropic.enabled, model: p.providers.anthropic.model, limitText: limitToText(p.providers.anthropic.monthlyLimitMicroUsd) },
      gemini: { enabled: p.providers.gemini.enabled, model: p.providers.gemini.model, limitText: limitToText(p.providers.gemini.monthlyLimitMicroUsd) },
    },
    overrides: p.tenantOverrides.map((o) => ({ companyId: o.companyId, companyName: o.companyName, provider: o.provider, model: o.model })),
  };
}

export type LimitResult = { ok: true; value: number | null } | { ok: false; message: string };

/** A monthly limit in US dollars, exact to a millionth; empty = no limit. Nothing is rounded. */
export function parseLimit(text: string): LimitResult {
  if (text.trim() === "") return { ok: true, value: null };
  const r = decimalToScaled(text, 6, MAX_LIMIT_MICRO_USD);
  if (r.ok) return { ok: true, value: r.value };
  if (r.error === "TOO_LARGE") return { ok: false, message: "The limit cannot be more than $1,000,000." };
  if (r.error === "TOO_MANY_DECIMALS") return { ok: false, message: "Use at most six decimals." };
  return { ok: false, message: "Enter an amount in US dollars, such as 250 or 250.50 — or leave it empty for no limit." };
}

export type AlertResult = { ok: true; value: number } | { ok: false; message: string };

export function parseAlertThreshold(text: string): AlertResult {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return { ok: false, message: "Enter a whole number from 1 to 100." };
  const n = Number(t);
  if (n < 1 || n > 100) return { ok: false, message: "Enter a whole number from 1 to 100." };
  return { ok: true, value: n };
}

export interface DraftErrors {
  limit: Partial<Record<ProviderName, string>>;
  alert?: string;
}

export type DraftResult = { ok: true; policy: PlatformAiPolicy } | { ok: false; errors: DraftErrors };

/** The complete policy document the API takes, or what is wrong with what was typed. */
export function draftToPolicy(draft: PolicyDraft): DraftResult {
  const errors: DraftErrors = { limit: {} };
  const limits: Record<ProviderName, number | null> = { anthropic: null, gemini: null };
  for (const p of PROVIDERS) {
    const r = parseLimit(draft.providers[p].limitText);
    if (r.ok) limits[p] = r.value;
    else errors.limit[p] = r.message;
  }
  const alert = parseAlertThreshold(draft.alertText);
  if (!alert.ok) errors.alert = alert.message;
  if (!alert.ok || Object.keys(errors.limit).length > 0) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      primary: draft.primary,
      fallbackEnabled: draft.fallbackEnabled,
      alertThresholdPct: alert.value,
      providers: {
        anthropic: { enabled: draft.providers.anthropic.enabled, model: draft.providers.anthropic.model, monthlyLimitMicroUsd: limits.anthropic },
        gemini: { enabled: draft.providers.gemini.enabled, model: draft.providers.gemini.model, monthlyLimitMicroUsd: limits.gemini },
      },
      tenantOverrides: draft.overrides.map((o) => ({ companyId: o.companyId, provider: o.provider, model: o.model })),
    },
  };
}

function canonical(policy: PlatformAiPolicy): string {
  return JSON.stringify({
    primary: policy.primary,
    fallbackEnabled: policy.fallbackEnabled,
    alertThresholdPct: policy.alertThresholdPct,
    providers: PROVIDERS.map((p) => [policy.providers[p].enabled, policy.providers[p].model, policy.providers[p].monthlyLimitMicroUsd]),
    tenantOverrides: policy.tenantOverrides.map((o) => [o.companyId, o.provider, o.model]),
  });
}

/**
 * True when saving would change something. A form that cannot be converted (a mistyped
 * limit) counts as changed, so the page keeps offering to discard it.
 */
export function isDirty(draft: PolicyDraft, status: PlatformAiProviders): boolean {
  const next = draftToPolicy(draft);
  if (!next.ok) return true;
  return canonical(next.policy) !== canonical(status.policy);
}

// ── Reading the status ────────────────────────────────────────────────────────────────────

export type Tone = "success" | "warning" | "info" | "destructive" | "primary" | "neutral";

export function providerStatus(status: PlatformAiProviders, p: ProviderName): PlatformAiProviderStatus | undefined {
  return status.providers.find((x) => x.provider === p);
}

/** True when the provider's SAVED model is a test model (possible outside production only). */
export function usesTestModel(s: PlatformAiProviderStatus | undefined): boolean {
  return Boolean(s && s.models.find((m) => m.id === s.model)?.simulated);
}

/** How a provider's key stands — presence and what the provider said about it; never the key. */
export function credentialSummary(s: PlatformAiProviderStatus): { tone: Tone; label: string; detail: string } {
  const c = s.credentials;
  // A test model is answered by the built-in test engine: the key plays no part, and
  // saying "no key" next to "serving requests" would only confuse.
  if (usesTestModel(s) && c.state === "missing") {
    return { tone: "info", label: "Test model — no key used", detail: `The selected model is a test model: requests are answered by the built-in test engine and no provider is called. Test models do not exist in production; a real model needs ${c.envVar} on the server.` };
  }
  const when = c.checkedAt ? ` (${new Date(c.checkedAt).toLocaleString()})` : "";
  switch (c.state) {
    case "verified":
      return { tone: "success", label: "Key verified", detail: `${s.label} accepted the key on the most recent request${when}.` };
    case "rejected":
      return { tone: "destructive", label: "Key rejected", detail: `${s.label} rejected the key${when}. Replace ${c.envVar} on the server and restart the API.` };
    case "account_stopped":
      return {
        tone: "destructive",
        label: "Account stopped by provider",
        detail: `${s.label} reported a billing problem or that its account spend limit is reached${when}. Requests routed to ${s.label} fail until this is resolved in the provider's console; they are not moved to the other provider.`,
      };
    case "present_unverified":
      return { tone: "info", label: "Key present", detail: `A key is set on the server. It is checked by the first real request — no test call is made from this page.` };
    default:
      return { tone: "warning", label: "No key on the server", detail: `${s.label} serves no request until ${c.envVar} is set in the server environment and the API is restarted. Keys are never entered here.` };
  }
}

export function limitSummary(s: PlatformAiProviderStatus): { tone: Tone; label: string } | null {
  const l = s.limit;
  if (l.state === "none" || l.monthlyLimitMicroUsd === null) return null;
  const of = `${formatMicroUsd(s.month.costMicroUsd)} of ${formatMicroUsd(l.monthlyLimitMicroUsd)}`;
  if (l.state === "reached") return { tone: "destructive", label: `Limit reached — ${of}` };
  if (l.state === "approaching") return { tone: "warning", label: `${l.usedPct ?? 0}% used — ${of}` };
  return { tone: "success", label: `${l.usedPct ?? 0}% used — ${of}` };
}

type ModelInfo = PlatformAiProviderStatus["models"][number];

/** "$4.00 in · $20.00 out per 1M tokens", with the dearer tier where the model has one. */
export function modelPriceLabel(m: ModelInfo | undefined): string {
  if (!m) return "";
  if (m.simulated) return "Test model — no provider is called";
  if (!m.priced || m.inputMicroUsdPerMTok === null || m.outputMicroUsdPerMTok === null) return "No price configured";
  const base = `${formatMicroUsd(m.inputMicroUsdPerMTok)} in · ${formatMicroUsd(m.outputMicroUsdPerMTok)} out per 1M tokens`;
  if (!m.longContext) return base;
  const lc = m.longContext;
  return `${base}; ${formatMicroUsd(lc.inputMicroUsdPerMTok)} in · ${formatMicroUsd(lc.outputMicroUsdPerMTok)} out when a request's input exceeds ${lc.aboveInputTokens.toLocaleString("en-US")} tokens`;
}

/** What serves requests now, in one sentence. */
export function servingSummary(status: PlatformAiProviders): { tone: Tone; title: string; detail: string } {
  const e = status.effective;
  if (!e.provider) {
    return e.unavailable === "none_enabled"
      ? { tone: "destructive", title: "AI is off", detail: "Both providers are disabled, so every AI feature is unavailable. Manual, QR and NFC capture keep working." }
      : { tone: "warning", title: "AI is not available yet", detail: "No enabled provider has a key on the server, so every AI feature is unavailable. Manual, QR and NFC capture keep working." };
  }
  const first = `${providerLabel(e.provider)} (${e.model})`;
  return e.fallbackProvider
    ? { tone: "success", title: `${providerLabel(e.provider)} serves AI requests`, detail: `${first} serves requests; ${providerLabel(e.fallbackProvider)} (${e.fallbackModel}) is tried once when it cannot.` }
    : { tone: "success", title: `${providerLabel(e.provider)} serves AI requests`, detail: `${first} serves requests. No fallback is in place.` };
}

/** The role a provider has in the SAVED policy as it applies now. */
export function providerRole(status: PlatformAiProviders, p: ProviderName): { tone: Tone; label: string } {
  const s = providerStatus(status, p);
  if (s && !s.enabled) return { tone: "neutral", label: "Disabled" };
  if (status.effective.provider === p) return { tone: "primary", label: "Serving requests" };
  if (status.effective.fallbackProvider === p) return { tone: "info", label: "Fallback" };
  return { tone: "neutral", label: status.policy.primary === p ? "Primary — not serving" : "Standby" };
}

export function compactNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * A calendar date the server names (the start of the month, the day limits reset), shown as
 * that same date wherever the page is opened — not shifted to the day before for a viewer
 * west of the server.
 */
export function serverDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

// ── Reading a refused save ────────────────────────────────────────────────────────────────

export type SaveFailure =
  | { kind: "confirm"; warnings: string[]; disablesAllAi: boolean }
  | { kind: "conflict"; message: string }
  | { kind: "storage"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "other"; message: string };

export function describeSaveFailure(err: unknown): SaveFailure {
  if (err instanceof ApiError) {
    const body = (err.data && typeof err.data === "object" ? err.data : {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    const message = typeof body.error === "string" && body.error ? body.error : err.message;
    const context = (body.context && typeof body.context === "object" ? body.context : {}) as Record<string, unknown>;
    if (code === "AI_POLICY_CONFIRMATION_REQUIRED") {
      const warnings = Array.isArray(context.warnings) ? context.warnings.filter((w): w is string => typeof w === "string") : [];
      return { kind: "confirm", warnings: warnings.length > 0 ? warnings : [message], disablesAllAi: context.disablesAllAi === true };
    }
    if (code === "AI_POLICY_VERSION_CONFLICT") return { kind: "conflict", message };
    if (code === "AI_POLICY_STORAGE_UNAVAILABLE") return { kind: "storage", message };
    if (err.status === 400) return { kind: "invalid", message };
    return { kind: "other", message };
  }
  return { kind: "other", message: err instanceof Error && err.message ? err.message : "The settings could not be saved." };
}
