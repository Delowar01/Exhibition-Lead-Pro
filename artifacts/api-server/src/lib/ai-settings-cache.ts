// Batch 41 — the in-process cache of effective tenant AI settings, extracted
// from services/ai.service.ts so the subscription lifecycle service can
// invalidate a tenant's entry when its plan / plan version changes WITHOUT
// importing the AI service (no import cycle). The cache semantics are unchanged.
import type { EffectiveAiSettings } from "../services/ai.service.js";

interface CacheEntry {
  value: EffectiveAiSettings;
  expires: number;
}

const settingsCache = new Map<number, CacheEntry>();

export function getCachedAiSettings(companyId: number, now: number): EffectiveAiSettings | undefined {
  const cached = settingsCache.get(companyId);
  if (cached && cached.expires > now) return cached.value;
  return undefined;
}

export function setCachedAiSettings(companyId: number, value: EffectiveAiSettings, expires: number): void {
  settingsCache.set(companyId, { value, expires });
}

export function invalidateAiSettingsCache(companyId: number): void {
  settingsCache.delete(companyId);
}
