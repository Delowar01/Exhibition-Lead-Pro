// =============================================================================
// B25 Correction 2 — the migration command's driver opener and failure report,
// kept out of scripts/migrate-storage.ts so the read-only guarantees can be
// unit-tested without spawning the script.
//
//   --dry-run / --verify  open the filesystem target READ-ONLY: a missing
//                         OBJECT_STORAGE_FS_ROOT is reported as "absent" and
//                         never created; no directory, temp file, probe,
//                         inventory row or object is written by these modes.
//                         The only permitted output write is the explicitly
//                         requested local `--out` summary file.
//   --copy                the only mutating mode: initializes storage normally
//                         (creates the root when missing) and writes objects.
// =============================================================================
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import type { StorageDriver } from "./contract.js";
import { FsStorageDriver, validateFsRoot } from "./fs-driver.js";
import { sanitizeStorageError } from "./log-safety.js";
import type { MigrationMode } from "./migration.js";
import { getLegacyDriver, getPrimaryDriver, initStorage, loadEncryptionKey } from "./registry.js";

export type TargetRootState = "present" | "absent" | "n/a";

export interface MigrationDrivers {
  /** Legacy bucket driver (null when no bucket is configured). */
  source: StorageDriver | null;
  target: StorageDriver;
  targetRoot: TargetRootState;
  readOnly: boolean;
}

/** Open the migration source and target for `mode` (read-only target for dry-run / verify). */
export async function openMigrationDrivers(mode: MigrationMode): Promise<MigrationDrivers> {
  if (config.objectStorage.driver !== "fs") throw new Error(`the migration target must be the filesystem driver (OBJECT_STORAGE_DRIVER=fs); current driver: ${config.objectStorage.driver}`);
  const source = await getLegacyDriver();
  if (mode === "copy") {
    await initStorage();
    const target = await getPrimaryDriver();
    return { source, target, targetRoot: "present", readOnly: false };
  }
  const problem = validateFsRoot(config.objectStorage.fsRoot);
  if (problem) throw new Error(problem);
  const target = new FsStorageDriver({ root: config.objectStorage.fsRoot, key: loadEncryptionKey(), readOnly: true });
  await target.init();
  return { source, target, targetRoot: target.rootState(), readOnly: true };
}

/** Sanitized fatal report for the command (never a raw error, message, stack, key, path or bucket). */
export function reportMigrationFailure(err: unknown): void {
  logger.error({ error: sanitizeStorageError(err) }, "migrate-storage failed");
}
