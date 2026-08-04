import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { AiFeature, AiPart } from "./types.js";
import type { CallJsonMeta } from "../lib/ai.js";

// Batch 6 — duplicate-request protection + conservative safe result reuse at the
// Enterprise AI Layer seam.
//
// The idempotency key is a SHA-256 over canonical request metadata: tenant, user,
// feature, entity, prompt version, model, and a digest of the fully-built prompt
// parts (which already embed language, tone, instructions, and the CRM context, so a
// change to any of those — including the underlying entity's data — produces a new
// key). The RAW prompt/content is never stored; only the irreversible hash.
//
// Two layers:
//   1. In-flight sharing — concurrent identical requests await ONE provider call.
//   2. Completed-result reuse — for a short configurable TTL, an identical repeat
//      (double-click, network retry, browser refresh) reuses the finished result
//      without a new provider call or token usage.
//
// Assistant conversations are NEVER reused (every turn must hit the model), and an
// explicit Regenerate bypasses both layers via ctx.bypassDedup.

const NEVER_REUSE: ReadonlySet<AiFeature> = new Set<AiFeature>(["assistant_answer"]);

export function dedupEligible(feature: AiFeature): boolean {
  return !NEVER_REUSE.has(feature);
}

export function dedupKey(params: {
  companyId?: number | null;
  userId?: number | null;
  feature: AiFeature;
  entityType?: string | null;
  entityId?: number | null;
  model: string;
  promptVersion: number;
  parts: AiPart[];
}): string {
  const h = createHash("sha256");
  h.update(`c:${params.companyId ?? "none"}|u:${params.userId ?? "none"}|f:${params.feature}`);
  h.update(`|e:${params.entityType ?? ""}:${params.entityId ?? ""}|m:${params.model}|pv:${params.promptVersion}`);
  for (const part of params.parts) {
    if ("text" in part) h.update(`|t:${part.text}`);
    else h.update(`|i:${part.inlineData.mimeType}:${createHash("sha256").update(part.inlineData.data).digest("hex")}`);
  }
  return h.digest("hex");
}

interface CompletedEntry {
  meta: CallJsonMeta;
  expires: number;
}

const inFlight = new Map<string, Promise<CallJsonMeta>>();
const completed = new Map<string, CompletedEntry>();

export function getInFlight(key: string): Promise<CallJsonMeta> | undefined {
  return inFlight.get(key);
}

export function setInFlight(key: string, promise: Promise<CallJsonMeta>): void {
  inFlight.set(key, promise);
}

export function clearInFlight(key: string): void {
  inFlight.delete(key);
}

export function getCompleted(key: string): CallJsonMeta | undefined {
  const ttl = config.ai.dedup.resultTtlMs;
  if (ttl <= 0) return undefined;
  const entry = completed.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    completed.delete(key);
    return undefined;
  }
  return entry.meta;
}

// Only successful results are stored (errors and denials are never cached).
export function setCompleted(key: string, meta: CallJsonMeta): void {
  const ttl = config.ai.dedup.resultTtlMs;
  if (ttl <= 0) return;
  if (completed.size >= config.ai.dedup.maxEntries) {
    // Evict expired first, then oldest inserted (Map preserves insertion order).
    const now = Date.now();
    for (const [k, v] of completed) {
      if (v.expires <= now) completed.delete(k);
    }
    while (completed.size >= config.ai.dedup.maxEntries) {
      const oldest = completed.keys().next().value;
      if (oldest === undefined) break;
      completed.delete(oldest);
    }
  }
  completed.set(key, { meta, expires: Date.now() + ttl });
}

/** Test/ops helper: drops all reuse state. */
export function resetDedup(): void {
  inFlight.clear();
  completed.clear();
}
