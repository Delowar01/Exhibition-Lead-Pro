// =============================================================================
// Batch 16 hosted activation — schema-push INSPECTION gate (runs on the GitHub
// runner, never on the VPS). Parses the `drizzle-kit push --verbose` output that
// was produced against a scratch database restored from the hosted database's
// schema-only dump, and asserts the push would add ONLY:
//   • tables      workflow_runs, workflow_action_runs
//   • FK constraints of those two tables (5)
//   • indexes of those two tables (8, incl. the two unique indexes)
// Anything else — any DROP, any ALTER/CREATE touching another table, a missing
// expected object — fails the gate so nothing is applied to the hosted database.
//
// Batch 16 correction 2 renames the pre-existing custom_field_values.definition_id
// FK to the explicit `custom_field_values_definition_id_fk` (the auto-generated
// 64-character name was stored truncated to 63 by PostgreSQL, so drizzle-kit
// re-created it on every push). The FIRST push against the hosted schema must
// therefore ALSO contain exactly: DROP of the truncated constraint + ADD of the
// new name with the identical definition — both are REQUIRED in pass 1.
//
// Usage: node b16-inspect-push.mjs <push-verbose.log>               (pass 1)
//        node b16-inspect-push.mjs <push-verbose.log> --expect-none  (pass 2: zero statements)
// =============================================================================
import fs from "node:fs";

const [, , file, modeArg = ""] = process.argv;
if (!file) {
  console.error("usage: b16-inspect-push.mjs <push-verbose.log> [--expect-none]");
  process.exit(2);
}
const expectNone = modeArg === "--expect-none";

const raw = fs.readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
const lines = raw.split("\n");

const start = lines.findIndex((l) => /You are about to execute current statements/.test(l));
const noChanges = lines.some((l) => /No changes detected/.test(l));
if (expectNone) {
  if (start < 0 && noChanges) {
    console.log("RESULT: OK — drizzle-kit reported 'No changes detected': the schema is exactly what the accepted code declares (zero statements).");
    process.exit(0);
  }
  console.log("RESULT: STOP — a second push still wants to execute statements (expected none):");
  console.log(raw);
  process.exit(1);
}
if (start < 0) {
  if (noChanges) {
    console.log("drizzle-kit reported 'No changes detected' — the hosted schema already contains everything the accepted code declares.");
    console.log("STOP: nothing to add; verify the hosted schema state before proceeding.");
    process.exit(1);
  }
  console.log("Could not find the statement block in the drizzle-kit output:");
  console.log(raw);
  process.exit(1);
}

// Statements: from the marker to the "[✓] Changes applied" line; a statement ends
// with a line whose trimmed end is ";".
const stmts = [];
let cur = [];
for (const l of lines.slice(start + 1)) {
  if (/^\[✓\]|Changes applied|^\[i\]/.test(l)) break;
  if (l.trim() === "" && cur.length === 0) continue;
  cur.push(l);
  if (l.trimEnd().endsWith(";")) {
    stmts.push(cur.join("\n").trim());
    cur = [];
  }
}
if (cur.length) stmts.push(cur.join("\n").trim());

const T = "(workflow_runs|workflow_action_runs)";
const reTable = new RegExp(`^CREATE TABLE "${T}" \\(`);
const reFk = new RegExp(`^ALTER TABLE "${T}" ADD CONSTRAINT "(\\w+)" FOREIGN KEY`);
const reIndex = new RegExp(`^CREATE (UNIQUE )?INDEX "(\\w+)" ON "${T}" `);

const EXPECTED = {
  tables: ["workflow_runs", "workflow_action_runs"],
  fks: [
    "workflow_runs_company_id_companies_id_fk",
    "workflow_runs_workflow_definition_id_workflow_definitions_id_fk",
    "workflow_runs_actor_user_id_users_id_fk",
    "workflow_action_runs_run_id_workflow_runs_id_fk",
    "workflow_action_runs_company_id_companies_id_fk",
  ],
  indexes: [
    "workflow_runs_definition_event_ux",
    "workflow_runs_company_created_idx",
    "workflow_runs_company_status_idx",
    "workflow_runs_company_definition_idx",
    "workflow_runs_company_entity_idx",
    "workflow_runs_status_updated_idx",
    "workflow_action_runs_run_index_ux",
    "workflow_action_runs_company_idx",
  ],
  columns: {
    workflow_runs: [
      "id", "company_id", "workflow_definition_id", "definition_revision", "definition_snapshot", "trigger_type",
      "entity_type", "entity_id", "actor_user_id", "event_key", "status", "error", "enqueue_generation",
      "lock_expires_at", "queued_at", "started_at", "completed_at", "created_at", "updated_at",
    ],
    workflow_action_runs: [
      "id", "run_id", "company_id", "action_index", "action_type", "status", "attempts", "error", "result",
      "started_at", "completed_at", "created_at", "updated_at",
    ],
  },
};

// The REQUIRED rename pair (Batch 16 correction 2): drop the truncated 63-char
// name, add the explicit name with the identical definition. Exact text only.
const CFV_DROP = 'ALTER TABLE "custom_field_values" DROP CONSTRAINT "custom_field_values_definition_id_custom_field_definitions_id_f";';
const CFV_ADD =
  'ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;';

const seen = { tables: [], fks: [], indexes: [] };
const unrelated = [];
const rename = [];
const columnProblems = [];

for (const s of stmts) {
  let m;
  if ((m = s.match(reTable))) {
    seen.tables.push(m[1]);
    const cols = s
      .split("\n")
      .slice(1)
      .map((l) => l.match(/^\s*"(\w+)"/))
      .filter(Boolean)
      .map((x) => x[1]);
    const want = EXPECTED.columns[m[1]];
    if (JSON.stringify(cols) !== JSON.stringify(want)) columnProblems.push(`${m[1]}: got [${cols.join(",")}] expected [${want.join(",")}]`);
  } else if ((m = s.match(reFk))) {
    seen.fks.push(m[2]);
  } else if ((m = s.match(reIndex))) {
    seen.indexes.push(m[2]);
  } else if (s === CFV_DROP || s === CFV_ADD) {
    rename.push(s);
  } else {
    unrelated.push(s);
  }
}

// Both halves of the rename must be present exactly once, DROP before ADD.
const renameOk = rename.length === 2 && rename[0] === CFV_DROP && rename[1] === CFV_ADD;

const missing = [];
for (const k of ["tables", "fks", "indexes"]) {
  for (const name of EXPECTED[k]) if (!seen[k].includes(name)) missing.push(`${k}: ${name}`);
}
const extra = [];
for (const k of ["tables", "fks", "indexes"]) {
  for (const name of seen[k]) if (!EXPECTED[k].includes(name)) extra.push(`${k}: ${name}`);
}

console.log("================ drizzle-kit push --verbose (accepted B16 code vs hosted schema copy) ================");
console.log(`statements parsed: ${stmts.length}`);
for (const s of stmts) {
  console.log("----");
  console.log(s);
}
console.log("================ classification ================");
console.log(`CREATE TABLE      : ${seen.tables.length}  ${seen.tables.join(", ")}`);
console.log(`ADD CONSTRAINT FK : ${seen.fks.length}  ${seen.fks.join(", ")}`);
console.log(`CREATE INDEX      : ${seen.indexes.length}  ${seen.indexes.join(", ")}`);
console.log(`missing expected  : ${missing.length}${missing.length ? "  " + missing.join(" | ") : ""}`);
console.log(`unexpected names  : ${extra.length}${extra.length ? "  " + extra.join(" | ") : ""}`);
console.log(`column mismatches : ${columnProblems.length}${columnProblems.length ? "  " + columnProblems.join(" | ") : ""}`);
console.log(`cfv FK rename pair: ${renameOk ? "present (DROP truncated name → ADD custom_field_values_definition_id_fk, identical definition)" : `INCOMPLETE/UNEXPECTED (${rename.length} of 2 exact statements)`}`);
console.log(`unrelated stmts   : ${unrelated.length}`);
for (const s of unrelated) console.log("  !! " + s.replace(/\n/g, "\n     "));

let ok = true;
if (missing.length || extra.length || columnProblems.length) ok = false;
if (unrelated.length) ok = false;
if (!renameOk) ok = false;
if (stmts.length !== 17) ok = false;

if (!ok) {
  console.log(`RESULT: STOP — expected exactly 17 statements (15 approved B16 additions + the 2-statement FK rename); got ${stmts.length} with the problems listed above.`);
  process.exit(1);
}
console.log(`RESULT: OK — exactly the 15 approved additive B16 statements (2 tables, ${seen.fks.length} FK constraints, ${seen.indexes.length} indexes) + the approved custom_field_values FK rename (DROP truncated → ADD custom_field_values_definition_id_fk).`);
