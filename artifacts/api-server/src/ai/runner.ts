import { AiProviderError, type AiProvider, type AiRequest, type AiResult } from "./types.js";

// Shared execution primitives for every AI call: timeout, retry-with-backoff, and
// tolerant JSON extraction. Kept provider-agnostic — the runner only talks to the
// AiProvider interface. Recording (ledger) and enforcement (settings/budget) live in
// ai.service; the runner is a pure orchestration seam.

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof AiProviderError) return err.kind === "timeout";
  return err instanceof Error && /timed out after \d+ms/.test(err.message);
}

// Best-effort JSON parse of a model response: tries the whole string, then the first
// {...} span. Throws a clear error when nothing parseable is present.
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("AI response was not valid JSON");
  }
}

export interface RunOptions {
  retries?: number; // additional attempts after the first (default 0 = single attempt)
  backoffMs?: number; // base backoff, multiplied by attempt number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Executes a provider call with the configured retry policy. Retries only when
// `retries > 0`; with the default (0) this is a single attempt whose failure
// propagates unchanged, preserving the original behavior + latency exactly.
// Batch 6: the result reports how many provider attempts were consumed so the
// invocation ledger can account retries; on final failure the error carries the
// attempt count via `attemptsOf`.
export async function runAi(
  provider: AiProvider,
  req: AiRequest,
  opts: RunOptions = {},
): Promise<AiResult & { attempts: number }> {
  const retries = Math.max(0, opts.retries ?? 0);
  const backoff = Math.max(0, opts.backoffMs ?? 0);
  let lastErr: unknown;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    attemptsUsed = attempt;
    try {
      const result = await provider.generate(req);
      return { ...result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      // A failure that repeating cannot change — a refusal, a rejected or unsupported
      // request, rejected credentials, a provider-side spend stop — is never re-sent
      // to the same provider: it would only be billed or refused again.
      if (attempt <= retries && isRetryable(err)) {
        if (backoff > 0) await sleep(backoff * attempt);
        continue;
      }
      break;
    }
  }
  if (lastErr instanceof Error) {
    (lastErr as Error & { aiAttempts?: number }).aiAttempts = attemptsUsed;
  }
  throw lastErr;
}

const NOT_RETRYABLE = new Set<AiProviderError["kind"]>(["refusal", "invalid_request", "unsupported_input", "auth", "quota"]);

/** Whether the SAME provider may be asked again (the runner's own retry policy). */
export function isRetryable(err: unknown): boolean {
  return !(err instanceof AiProviderError && NOT_RETRYABLE.has(err.kind));
}

/** Provider attempts consumed before a runAi failure (1 when unknown). */
export function attemptsOf(err: unknown): number {
  const n = (err as { aiAttempts?: unknown } | null)?.aiAttempts;
  return typeof n === "number" && n >= 1 ? n : 1;
}

// Safe, low-cardinality failure category for the ledger/analytics. NEVER includes
// message content beyond fixed classification — raw text stays in redacted
// errorMessage only.
const CATEGORY_OF_KIND: Record<AiProviderError["kind"], string> = {
  timeout: "timeout",
  network: "network",
  rate_limited: "provider_rate_limited",
  unavailable: "provider_unavailable",
  auth: "provider_auth",
  quota: "provider_quota",
  refusal: "provider_refusal",
  invalid_request: "provider_rejected",
  unsupported_input: "provider_unsupported_input",
  invalid_response: "invalid_response",
};

export function categorizeError(err: unknown): string {
  if (err instanceof AiProviderError) return CATEGORY_OF_KIND[err.kind];
  if (isTimeoutError(err)) return "timeout";
  const msg = err instanceof Error ? err.message : String(err);
  // An untyped provider error (the Gemini SDK): credentials rejected by the provider.
  if (/API key not valid|API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b/i.test(msg)) return "provider_auth";
  if (/\b429\b|rate limit|quota|resource.?exhausted/i.test(msg)) return "provider_rate_limited";
  if (/\b(500|502|503|504)\b|unavailable|overloaded/i.test(msg)) return "provider_unavailable";
  if (/not valid JSON|Unexpected token|JSON/i.test(msg)) return "invalid_response";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(msg)) return "network";
  return "other";
}

// Truncates + strips an error message for safe storage in the ledger (no secrets/
// stack traces / oversized payloads).
export function redactError(err: unknown, maxLen = 300): string {
  const msg = err instanceof Error ? err.message : String(err);
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

// Failure classes after which the OTHER enabled provider may be tried, once: the
// provider could not serve the request (outage, overload, rate limit, network, timeout),
// rejected the platform's credentials, or cannot take this input at all. Everything else
// is final — a policy rejection of this application (an AppError: tenant budget, plan
// allowance, platform spending limit, disabled feature, rate limit, permission), a
// provider's refusal of the content, a provider-side spending cap, a rejected request,
// or an unusable answer. Retrying those on another provider would bypass a decision
// rather than work around an outage.
const FALLBACK_ELIGIBLE = new Set(["timeout", "network", "provider_rate_limited", "provider_unavailable", "provider_auth", "provider_unsupported_input"]);

// Failure classes that mean "the provider did not serve — this is not about the request
// or the photo": the outage classes above, and the provider account being stopped
// (billing, spend cap). Used for what the USER is told; a stopped account is final (no
// fallback) and still must not be reported as an unreadable card.
const PROVIDER_DOWN = new Set(["timeout", "network", "provider_rate_limited", "provider_unavailable", "provider_auth", "provider_quota"]);

// AppError (and anything carrying an HTTP statusCode of this application) is a decision
// of this application, never a provider failure.
const isAppDecision = (err: unknown) => Boolean(err) && typeof err === "object" && typeof (err as { statusCode?: unknown }).statusCode === "number";

export function isFallbackEligible(err: unknown): boolean {
  if (isAppDecision(err)) return false;
  return FALLBACK_ELIGIBLE.has(categorizeError(err));
}

export function isProviderDown(err: unknown): boolean {
  if (isAppDecision(err)) return false;
  return PROVIDER_DOWN.has(categorizeError(err));
}

// The time the fallback attempt may take: the request's own timeout, shortened so that
// the two attempts together stay inside `budgetMs` (which is kept below the reverse
// proxy's read timeout — a primary that hangs until its timeout must still leave the
// fallback time to answer before the client's connection is cut). Never below `floorMs`.
export function fallbackTimeoutMs(timeoutMs: number, elapsedMs: number, budgetMs: number, floorMs = 5_000): number {
  const remaining = budgetMs - Math.max(0, elapsedMs);
  return Math.max(Math.min(floorMs, timeoutMs), Math.min(timeoutMs, remaining));
}
