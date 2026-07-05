import type { AiProvider, AiRequest, AiResult } from "./types.js";

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
export async function runAi(provider: AiProvider, req: AiRequest, opts: RunOptions = {}): Promise<AiResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  const backoff = Math.max(0, opts.backoffMs ?? 0);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await provider.generate(req);
    } catch (err) {
      lastErr = err;
      if (attempt <= retries) {
        if (backoff > 0) await sleep(backoff * attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

// Truncates + strips an error message for safe storage in the ledger (no secrets/
// stack traces / oversized payloads).
export function redactError(err: unknown, maxLen = 300): string {
  const msg = err instanceof Error ? err.message : String(err);
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}
