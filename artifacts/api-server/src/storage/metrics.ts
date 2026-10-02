// Batch 25 — in-process storage counters surfaced on GET /metrics (platform
// owner) and in structured logs. Counters only: never object contents, keys,
// paths, checksums or tenant data.
export interface StorageCounters {
  primaryFailures: number;
  legacyFallbackReads: number;
  mirrorFailures: number;
  migrationVerifyFailures: number;
  deleteFailures: number;
}

const counters: StorageCounters = {
  primaryFailures: 0,
  legacyFallbackReads: 0,
  mirrorFailures: 0,
  migrationVerifyFailures: 0,
  deleteFailures: 0,
};

export function bump(counter: keyof StorageCounters, by = 1): void {
  counters[counter] += by;
}

export function storageCounters(): StorageCounters {
  return { ...counters };
}

export function __resetStorageCountersForTests(): void {
  for (const k of Object.keys(counters) as Array<keyof StorageCounters>) counters[k] = 0;
}
