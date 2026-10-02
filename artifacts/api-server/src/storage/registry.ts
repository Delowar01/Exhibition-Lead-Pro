// =============================================================================
// Batch 25 — driver registry. Resolves the PRIMARY driver from config once,
// plus the optional legacy (GCS) driver used for fallback reads / migration and
// the optional strict mirror. Startup validation (initStorage) refuses an
// unusable filesystem root or a missing encryption key in production; the key
// itself is never logged.
// =============================================================================
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { StorageConfigError, StorageError, type StorageDriver } from "./contract.js";
import { sanitizeStorageError } from "./log-safety.js";

export { StorageConfigError };
import { parseEncryptionKey } from "./envelope.js";
import { FsStorageDriver, validateFsRoot } from "./fs-driver.js";
import { GcsStorageDriver } from "./gcs-driver.js";
import { MemoryStorageDriver } from "./memory-driver.js";

export type StorageMode = "fs" | "gcs" | "memory" | "none";

let primary: StorageDriver | null | undefined;
let legacy: StorageDriver | null | undefined;
let encryptionKey: Buffer | null = null;
let ephemeralKeyWarned = false;

/** The configured at-rest key (or the explicit test-only ephemeral key). Never logged. */
export function loadEncryptionKey(): Buffer {
  return loadKey();
}

function loadKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const raw = config.objectStorage.encryptionKey;
  if (raw && raw.trim()) {
    encryptionKey = parseEncryptionKey(raw);
    return encryptionKey;
  }
  if (config.objectStorage.testEphemeralKey && !config.isProduction) {
    encryptionKey = randomBytes(32);
    if (!ephemeralKeyWarned) {
      ephemeralKeyWarned = true;
      logger.warn("Object storage: OBJECT_STORAGE_TEST_EPHEMERAL_KEY is set — objects written now cannot be read after a restart (test configuration only)");
    }
    return encryptionKey;
  }
  throw new StorageConfigError("OBJECT_STORAGE_ENCRYPTION_KEY is required for the filesystem object-storage driver");
}

async function gcsClient() {
  // Lazy import keeps the Google SDK out of the startup path when the driver is fs/memory.
  const mod = await import("../lib/objectStorage.js");
  return mod.objectStorageClient;
}

export function storageMode(): StorageMode {
  return config.objectStorage.driver;
}

export function storageConfigured(): boolean {
  return config.objectStorage.driver !== "none";
}

/** Primary driver (throws STORAGE_UNAVAILABLE when storage is not configured). */
export async function getPrimaryDriver(): Promise<StorageDriver> {
  if (primary) return primary;
  if (primary === null) throw new StorageError("STORAGE_UNAVAILABLE", "object storage is not configured");
  switch (config.objectStorage.driver) {
    case "fs": {
      const problem = validateFsRoot(config.objectStorage.fsRoot);
      if (problem) throw new StorageConfigError(problem);
      const driver = new FsStorageDriver({ root: config.objectStorage.fsRoot, key: loadKey() });
      await driver.init();
      primary = driver;
      break;
    }
    case "gcs":
      primary = new GcsStorageDriver(await gcsClient(), config.objectStorage.bucketId);
      break;
    case "memory":
      if (config.isProduction) throw new StorageConfigError("memory object-storage driver is forbidden in production");
      primary = new MemoryStorageDriver();
      break;
    default:
      primary = null;
      throw new StorageError("STORAGE_UNAVAILABLE", "object storage is not configured");
  }
  return primary;
}

/** The legacy GCS driver when a bucket is configured (fallback reads, mirror, migration); null otherwise. */
export async function getLegacyDriver(): Promise<StorageDriver | null> {
  if (legacy !== undefined) return legacy;
  if (!config.objectStorage.bucketId) {
    legacy = null;
    return legacy;
  }
  if (config.objectStorage.driver === "gcs") {
    legacy = await getPrimaryDriver();
    return legacy;
  }
  legacy = new GcsStorageDriver(await gcsClient(), config.objectStorage.bucketId);
  return legacy;
}

/** Strict mirror target (fs primary + GCS copy) when enabled and a bucket exists. */
export async function getMirrorDriver(): Promise<StorageDriver | null> {
  if (!config.objectStorage.mirror) return null;
  // Mirroring only makes sense from a non-GCS primary (fs on the VPS; memory in tests).
  if (config.objectStorage.driver === "gcs" || config.objectStorage.driver === "none") return null;
  return getLegacyDriver();
}

export function legacyFallbackEnabled(): boolean {
  return config.objectStorage.legacyFallback && !!config.objectStorage.bucketId;
}

export interface StorageTiming {
  uploadLeaseMs: number;
  putTimeoutMs: number;
  uploadHardLifetimeMs: number;
}

/**
 * B25 Correction 4 — the timing relationships a bounded upload depends on
 * (checked at startup; the messages are fixed and never carry a configured
 * value or a path):
 *   • put time bound < hard upload lifetime — otherwise no put can ever start
 *     (a put may start only when it can finish before the deadline);
 *   • put time bound ≤ upload lease — otherwise a put that uses its full bound
 *     always outlives the lease it needs to stage (a lost lease is never
 *     reclaimed), i.e. a slow-but-legitimate upload can never be published;
 *   • upload lease ≤ hard upload lifetime — a lease may never promise a writer
 *     more time than the intent can exist at all.
 * With the strict mirror on, one intent performs two puts; the lease should be
 * planned for both (documented, not enforced: the bound is a ceiling).
 */
export function validateStorageTiming(t: StorageTiming): void {
  if (!(t.putTimeoutMs < t.uploadHardLifetimeMs)) throw new StorageConfigError("OBJECT_STORAGE_PUT_TIMEOUT_MS must be smaller than OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS (no bounded upload could ever start)");
  if (!(t.putTimeoutMs <= t.uploadLeaseMs)) throw new StorageConfigError("OBJECT_STORAGE_PUT_TIMEOUT_MS must not exceed OBJECT_STORAGE_UPLOAD_LEASE_MS (a put using its full bound could never be staged)");
  if (!(t.uploadLeaseMs <= t.uploadHardLifetimeMs)) throw new StorageConfigError("OBJECT_STORAGE_UPLOAD_LEASE_MS must not exceed OBJECT_STORAGE_UPLOAD_HARD_LIFETIME_MS (a lease may not outlive the upload intent)");
}

/**
 * Startup validation (index.ts). Fails fast on a misconfigured fs driver so a
 * production node never boots with an unusable or plaintext object store, and
 * (B25 Correction 4) on timing relationships that make a bounded upload
 * impossible. A "none" configuration is allowed (storage optional) and only
 * logged.
 */
export async function initStorage(): Promise<void> {
  validateStorageTiming(config.objectStorage);
  const mode = config.objectStorage.driver;
  if (mode === "none") {
    logger.warn({ reason: config.objectStorage.driverReason }, "Object storage: NOT configured — uploads answer 503, readiness reports not_configured");
    return;
  }
  if (mode === "fs" || mode === "gcs" || mode === "memory") {
    await getPrimaryDriver();
  }
  logger.info(
    {
      driver: mode,
      legacyFallback: legacyFallbackEnabled(),
      mirror: config.objectStorage.mirror && mode !== "gcs" && !!config.objectStorage.bucketId,
      legacyDelete: config.objectStorage.legacyDelete,
      encryption: mode === "fs" ? (config.objectStorage.encryptionKey ? "configured" : "ephemeral-test-key") : "n/a",
    },
    "Object storage initialized",
  );
}

/**
 * B25 Correction 3 — the ONLY way a startup initialization failure is logged:
 * a sanitized error summary, plus the fixed configuration reason when the
 * failure is a StorageConfigError (those messages never carry a path or key).
 */
export function reportStorageInitFailure(err: unknown): void {
  const reason = err instanceof StorageConfigError ? err.message : undefined;
  logger.error({ error: sanitizeStorageError(err), ...(reason ? { reason } : {}) }, "Object storage initialization failed — refusing to start");
}

/** Test support (non-production): swap drivers / reset the registry. */
export function __resetStorageRegistryForTests(): void {
  if (config.isProduction) return;
  primary = undefined;
  legacy = undefined;
  encryptionKey = null;
}

export function __setDriversForTests(drivers: { primary?: StorageDriver | null; legacy?: StorageDriver | null }): void {
  if (config.isProduction) return;
  if (drivers.primary !== undefined) primary = drivers.primary;
  if (drivers.legacy !== undefined) legacy = drivers.legacy;
}
