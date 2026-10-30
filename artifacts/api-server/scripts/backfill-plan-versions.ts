// Batch 40 — version-1 backfill for the versioned Plan Builder (DRY-RUN FIRST).
// Batch 41 — safety hardening (see src/lib/billing/version-backfill.ts and
// src/lib/db-target.ts).
//
//   pnpm --filter @workspace/api-server run backfill-plan-versions            # dry run (default): report only, rolled back
//   pnpm --filter @workspace/api-server run backfill-plan-versions --apply    # dry run, then apply in ONE verified transaction
//   pnpm --filter @workspace/api-server run backfill-plan-versions --snapshot # print the entitlement snapshot (BEFORE/AFTER evidence)
//   … --json                                                                 # machine-readable output
//   … --expect-host <host>                                                   # REQUIRED for any non-loopback database host
//   … --confirm-production                                                   # REQUIRED to --apply to a non-loopback host or under NODE_ENV=production
//
// What it does: creates version 1 of every published plan from the plan row's ACTUAL
// values and pins every NULL-reference subscription to it, verifying inside the
// transaction that no tenant's effective limits, overrides, status, access mode,
// billing source, trial / period dates, provider price, feature entitlements or
// trial policy changed; any difference rolls everything back. Idempotent: a second
// run reports "version_exists" / "alreadyPinned" and writes nothing.
//
// Verdicts: APPLIED | DRY_RUN_OK | INCOMPLETE (an unpinnable subscription) |
// INTEGRITY_ERROR (a snapshot could not resolve) | VERIFICATION_FAILED. Only
// APPLIED / DRY_RUN_OK are complete; --apply runs only after a complete dry run.
//
// Database target guard (Batch 41): the configured DATABASE_URL host is classified
// BEFORE any connection. NODE_ENV is never taken as proof of a non-production
// database: a non-loopback host always requires an explicit, matching
// --expect-host, and --apply to it additionally requires --confirm-production
// (owner authorization). Production execution is not authorized by this script.
import { parseArgs } from "node:util";
import { guardDatabaseTarget } from "../src/lib/db-target.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    snapshot: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "confirm-production": { type: "boolean", default: false },
    "expect-host": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

function out(v: unknown) {
  process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);
}

async function main(): Promise<number> {
  // Operator script: the raw environment is classified here, before the database
  // module (which opens the pool from DATABASE_URL) is even imported.
  const guard = guardDatabaseTarget({
    url: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    expectHost: values["expect-host"],
    confirmProduction: values["confirm-production"],
    apply: values.apply,
  });
  if (!guard.ok) {
    out(`refusing to run: ${guard.code} — ${guard.message}`);
    return 2;
  }
  out(`database target: ${guard.target.display} (${guard.target.class})`);
  const { runVersionBackfill, entitlementSnapshot } = await import("../src/lib/billing/version-backfill.js");
  // The ACTUAL evaluation instant of this run (never a hard-coded date).
  const evaluationInstant = new Date();
  if (values.snapshot) {
    const rows = await entitlementSnapshot(evaluationInstant);
    out({ evaluationInstant: evaluationInstant.toISOString(), subscriptions: rows });
    return 0;
  }
  // Always a dry run first.
  const dry = await runVersionBackfill({ apply: false, now: evaluationInstant });
  out(values.json ? dry : summarize(dry));
  if (!dry.complete) return 3;
  if (!values.apply) return 0;
  const applied = await runVersionBackfill({ apply: true, now: evaluationInstant });
  out(values.json ? applied : summarize(applied));
  return applied.applied && applied.complete ? 0 : 3;
}

function summarize(r: Awaited<ReturnType<typeof import("../src/lib/billing/version-backfill.js")["runVersionBackfill"]>>): string {
  const lines = [
    `mode=${r.mode} verdict=${r.verdict} complete=${r.complete} applied=${r.applied} rolledBack=${r.rolledBack} evaluationInstant=${r.evaluationInstant}${r.reason ? ` reason="${r.reason}"` : ""}`,
    ...r.plans.map((p) => `plan ${p.planId}: ${p.action}${p.version != null ? ` (version ${p.version}, id ${p.versionId})` : ""}`),
    `subscriptions: total=${r.subscriptions.total} alreadyPinned=${r.subscriptions.alreadyPinned} pinned=${r.subscriptions.pinned.length} unpinnable=${r.subscriptions.unpinnable.length}`,
    ...r.subscriptions.unpinnable.map((u) => `  unpinnable company ${u.companyId} (plan ${u.planId}): ${u.reason}`),
    `integrity errors: ${r.integrityErrors.length}`,
    ...r.integrityErrors.slice(0, 20).map((e) => `  integrity ${e.phase} company ${e.companyId}: ${e.code}`),
    `verification: compared=${r.verification.compared} mismatches=${r.verification.mismatches.length}`,
    ...r.verification.mismatches.slice(0, 20).map((m) => `  mismatch company ${m.companyId} field ${m.field}: ${JSON.stringify(m.before)} → ${JSON.stringify(m.after)}`),
  ];
  return lines.join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
