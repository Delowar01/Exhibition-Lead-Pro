// =============================================================================
// Batch 25 — legacy Google Cloud Storage → filesystem object migration command.
//
//   pnpm --filter @workspace/api-server run migrate-storage -- --dry-run
//   pnpm --filter @workspace/api-server run migrate-storage -- --copy [--concurrency 4] [--batch 200] [--recheck]
//   pnpm --filter @workspace/api-server run migrate-storage -- --verify
//   ... [--out <summary.json>]
//
// --dry-run / --verify never create OBJECT_STORAGE_FS_ROOT or any directory,
// temp file, probe, inventory row or object (B25 Correction 2); a missing root
// is reported as "targetRoot": "absent". The explicitly requested --out file
// is the only output write of those modes.
//
// --dry-run and --verify are READ-ONLY (B25 Correction 1): they discover and
// plan / check but never register an inventory row and never write an object;
// --copy is the only mutating mode. Resumable and idempotent: rerunning finds
// already-migrated objects and skips them; a conflicting local object is never
// overwritten; nothing is ever deleted from the bucket. Several feature rows
// pointing at ONE legacy object are reported as DUPLICATE_REFERENCE and mark
// the run incomplete (copy / cutover blocked until resolved). Exit codes: 0
// complete, 2 incomplete (missing sources, checksum mismatches, conflicts,
// duplicates, failures, unregistered / unmigrated rows in --verify), 1 usage /
// configuration error. The JSON summary is sanitized (ids, kinds, counts,
// error codes, 16-hex key hashes — no keys, paths, bucket names or contents).
//
// Required environment: DATABASE_URL, OBJECT_STORAGE_DRIVER=fs,
// OBJECT_STORAGE_FS_ROOT, OBJECT_STORAGE_ENCRYPTION_KEY (target) and, for
// --dry-run / --copy, the legacy bucket variables + Google credentials
// (source). Phase 1: this command is exercised locally with fake drivers in
// the unit suite only — NOT run against the hosted stack without approval.
// =============================================================================
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pool } from "@workspace/db";
import { config } from "../src/config.js";
import { logger } from "../src/lib/logger.js";
import { OBJECT_LIMITS } from "../src/services/storage.service.js";
import { runMigration, type MigrationMode } from "../src/storage/migration.js";
import { openMigrationDrivers, reportMigrationFailure } from "../src/storage/migration-cli.js";
import { dbInventoryAdapter, discoverLegacyReferences } from "../src/storage/migration-db.js";

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: migrate-storage --dry-run | --copy | --verify [--concurrency N] [--batch N] [--recheck] [--out file.json]");
  console.error("  --dry-run  read-only: discover, attribute, group duplicates and plan (no inventory or object writes)");
  console.error("  --copy     the only mutating mode: register, copy, verify, flip rows to the target driver");
  console.error("  --verify   read-only: prove migrated objects match the inventory; report unregistered / unmigrated rows");
  process.exit(1);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      copy: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      concurrency: { type: "string" },
      batch: { type: "string" },
      recheck: { type: "boolean", default: false },
      out: { type: "string" },
    },
    strict: true,
  });
  const modes = (["dry-run", "copy", "verify"] as const).filter((m) => values[m]);
  if (modes.length !== 1) usage("choose exactly one of --dry-run, --copy, --verify");
  const mode: MigrationMode = modes[0];
  const concurrency = values.concurrency ? Number(values.concurrency) : 4;
  const batch = values.batch ? Number(values.batch) : 200;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) usage("--concurrency must be 1..16");
  if (!Number.isInteger(batch) || batch < 1 || batch > 5000) usage("--batch must be 1..5000");

  if (config.objectStorage.driver !== "fs") usage(`the migration target must be the filesystem driver (OBJECT_STORAGE_DRIVER=fs); current driver: ${config.objectStorage.driver}`);
  if (config.objectStorage.legacyDelete) usage("OBJECT_STORAGE_LEGACY_DELETE must be off while migrating");

  // B25 Correction 2: --dry-run / --verify open the target READ-ONLY (a missing
  // root is reported, never created); only --copy initializes storage normally.
  const { source, target, targetRoot, readOnly } = await openMigrationDrivers(mode);
  if (mode !== "verify" && !source) usage("the legacy bucket is not configured (DEFAULT_OBJECT_STORAGE_BUCKET_ID); nothing to migrate from");
  if (readOnly && targetRoot === "absent") logger.warn({ mode }, "migrate-storage: the filesystem target root does not exist yet (read-only mode never creates it)");

  const summary = await runMigration({
    mode,
    source,
    target,
    inventory: dbInventoryAdapter(),
    discover: discoverLegacyReferences,
    limits: OBJECT_LIMITS,
    concurrency,
    batchSize: batch,
    recheckMigrated: values.recheck,
    log: (event, data) => {
      if (event === "migration.item") {
        if (data.status !== "already" && data.status !== "verified") logger.info(data, event);
      } else {
        logger.info(data, event);
      }
    },
  });

  const json = JSON.stringify({ ...summary, targetRoot, readOnly }, null, 2);
  // The explicitly requested local summary file is the ONLY output write a read-only mode performs.
  if (values.out) await writeFile(values.out, json, { mode: 0o600 });
  process.stdout.write(`${json}\n`);
  return summary.complete ? 0 : 2;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    reportMigrationFailure(err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
