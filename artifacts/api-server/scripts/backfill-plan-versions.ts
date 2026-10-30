// Batch 40 — version-1 backfill for the versioned Plan Builder (DRY-RUN FIRST).
//
//   pnpm --filter @workspace/api-server run backfill-plan-versions            # dry run (default): report only, rolled back
//   pnpm --filter @workspace/api-server run backfill-plan-versions --apply    # dry run, then apply in ONE verified transaction
//   pnpm --filter @workspace/api-server run backfill-plan-versions --snapshot # print the entitlement snapshot (BEFORE/AFTER evidence)
//   … --json                                                                 # machine-readable output
//
// What it does: creates version 1 of every published plan from the plan row's ACTUAL
// values and pins every NULL-reference subscription to it, verifying inside the
// transaction that no tenant's effective limits, overrides, status, access mode,
// billing source, trial / period dates or provider price changed; any difference
// rolls everything back. Idempotent: a second run reports "version_exists" /
// "alreadyPinned" and writes nothing.
//
// Production guard: refuses to run with NODE_ENV=production unless
// --confirm-production is passed — applying it to production requires the owner's
// separate authorization (schema applied + fresh verified backup first).
import { parseArgs } from "node:util";
import { runVersionBackfill, entitlementSnapshot } from "../src/lib/billing/version-backfill.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    snapshot: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "confirm-production": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

function out(v: unknown) {
  process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);
}

async function main(): Promise<number> {
  if (process.env.NODE_ENV === "production" && !values["confirm-production"]) {
    out("refusing to run against NODE_ENV=production without --confirm-production (owner authorization required)");
    return 2;
  }
  if (values.snapshot) {
    const rows = await entitlementSnapshot(new Date("2026-10-30T00:00:00Z"));
    out({ evaluationInstant: "2026-10-30T00:00:00.000Z", subscriptions: rows });
    return 0;
  }
  // Always a dry run first.
  const dry = await runVersionBackfill({ apply: false });
  out(values.json ? dry : summarize(dry));
  if (dry.verification.mismatches.length > 0) return 3;
  if (!values.apply) return 0;
  const applied = await runVersionBackfill({ apply: true });
  out(values.json ? applied : summarize(applied));
  return applied.applied ? 0 : 3;
}

function summarize(r: Awaited<ReturnType<typeof runVersionBackfill>>): string {
  const lines = [
    `mode=${r.mode} applied=${r.applied} rolledBack=${r.rolledBack}${r.reason ? ` reason="${r.reason}"` : ""}`,
    ...r.plans.map((p) => `plan ${p.planId}: ${p.action}${p.version != null ? ` (version ${p.version}, id ${p.versionId})` : ""}`),
    `subscriptions: total=${r.subscriptions.total} alreadyPinned=${r.subscriptions.alreadyPinned} pinned=${r.subscriptions.pinned.length} unpinnable=${r.subscriptions.unpinnable.length}`,
    ...r.subscriptions.unpinnable.map((u) => `  unpinnable company ${u.companyId} (plan ${u.planId}): ${u.reason}`),
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
