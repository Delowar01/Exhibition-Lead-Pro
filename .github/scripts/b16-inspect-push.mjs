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
// Known drizzle-kit quirk (reported separately, NOT accepted by default): the
// pre-existing FK `custom_field_values_definition_id_custom_field_definitions_id_fk`
// is 64 characters, PostgreSQL stores it truncated to 63, and drizzle-kit therefore
// wants to DROP + re-ADD the identical constraint on every push. That exact pair
// is tolerated only when the mode file explicitly carries `allow=cfv-fk-recreate`.
//
// Usage: node b16-inspect-push.mjs <push-verbose.log> [allow-list]
// =============================================================================
import fs from "node:fs";

const [, , file, allowArg = ""] = process.argv;
if (!file) {
  console.error("usage: b16-inspect-push.mjs <push-verbose.log> [allow-list]");
  process.exit(2);
}
const allow = new Set(allowArg.split(",").map((s) => s.trim()).filter(Boolean));

const raw = fs.readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
const lines = raw.split("\n");

const start = lines.findIndex((l) => /You are about to execute current statements/.test(l));
if (start < 0) {
  if (lines.some((l) => /No changes detected/.test(l))) {
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

// The one known, idempotent drizzle-kit artifact (identical constraint re-created
// under the same 63-char name). Tolerated ONLY with allow=cfv-fk-recreate, and only
// as the exact DROP + ADD pair.
const CFV_DROP = 'ALTER TABLE "custom_field_values" DROP CONSTRAINT "custom_field_values_definition_id_custom_field_definitions_id_f";';
const CFV_ADD =
  'ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_definition_id_custom_field_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;';

const seen = { tables: [], fks: [], indexes: [] };
const unrelated = [];
const tolerated = [];
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
    tolerated.push(s);
  } else {
    unrelated.push(s);
  }
}

const cfvPairComplete = tolerated.includes(CFV_DROP) && tolerated.includes(CFV_ADD) && tolerated.length === 2;
if (tolerated.length > 0 && !cfvPairComplete) unrelated.push(...tolerated);
const cfvAccepted = cfvPairComplete && allow.has("cfv-fk-recreate");

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
console.log(`known cfv FK pair : ${cfvPairComplete ? "present" : "absent"}${cfvPairComplete ? (cfvAccepted ? " (explicitly allowed by the mode file)" : " (NOT allowed — stop)") : ""}`);
console.log(`unrelated stmts   : ${unrelated.length}`);
for (const s of unrelated) console.log("  !! " + s.replace(/\n/g, "\n     "));

let ok = true;
if (missing.length || extra.length || columnProblems.length) ok = false;
if (unrelated.length) ok = false;
if (cfvPairComplete && !cfvAccepted) ok = false;

if (!ok) {
  console.log("RESULT: STOP — the push would not be limited to workflow_runs / workflow_action_runs and their declared indexes and constraints.");
  process.exit(1);
}
console.log(`RESULT: OK — additive only (2 tables, ${seen.fks.length} FK constraints, ${seen.indexes.length} indexes)${cfvAccepted ? "; plus the explicitly allowed custom_field_values FK re-create (no net change)" : ""}.`);
