// =============================================================================
// Batch 18 hosted activation — schema-push INSPECTION gate (runs on the GitHub
// runner, never on the VPS). Parses the `drizzle-kit push --verbose` output that
// was produced against a scratch database restored from the hosted database's
// schema-only dump, and asserts the push would execute ONLY these five additive,
// nullable, default-free column additions on `companies`:
//   ALTER TABLE "companies" ADD COLUMN "brand_primary_color" text;
//   ALTER TABLE "companies" ADD COLUMN "brand_sidebar_color" text;
//   ALTER TABLE "companies" ADD COLUMN "brand_default_theme" text;
//   ALTER TABLE "companies" ADD COLUMN "brand_logo_key" text;
//   ALTER TABLE "companies" ADD COLUMN "brand_logo_content_type" text;
// Anything else — a DROP, a rename, a type change, NOT NULL, a DEFAULT, a data
// update, an index/constraint change, another table, a missing or extra statement —
// fails the gate so nothing is applied to the hosted database.
//
// Usage: node b18-inspect-push.mjs <push-verbose.log>               (pass 1)
//        node b18-inspect-push.mjs <push-verbose.log> --expect-none  (pass 2 / post-apply)
// =============================================================================
import fs from "node:fs";

const [, , file, modeArg = ""] = process.argv;
if (!file) {
  console.error("usage: b18-inspect-push.mjs <push-verbose.log> [--expect-none]");
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

const EXPECTED = ["brand_primary_color", "brand_sidebar_color", "brand_default_theme", "brand_logo_key", "brand_logo_content_type"];
const reAdd = /^ALTER TABLE "companies" ADD COLUMN "(brand_[a-z_]+)" text;$/;
const seen = [];
const unrelated = [];
for (const s of stmts) {
  const m = s.match(reAdd);
  if (m && EXPECTED.includes(m[1])) seen.push(m[1]);
  else unrelated.push(s);
}
const missing = EXPECTED.filter((c) => !seen.includes(c));
const dupes = seen.filter((c, i) => seen.indexOf(c) !== i);
const forbidden = stmts.filter((s) => /\b(DROP|RENAME|ALTER COLUMN|SET NOT NULL|SET DEFAULT|DEFAULT |NOT NULL|UPDATE |INSERT |DELETE |TRUNCATE|CREATE INDEX|CREATE UNIQUE|ADD CONSTRAINT|CREATE TABLE|TYPE )/i.test(s) && !reAdd.test(s));

console.log("================ drizzle-kit push --verbose (accepted B18 code vs hosted schema copy) ================");
console.log(`statements parsed: ${stmts.length}`);
for (const s of stmts) {
  console.log("----");
  console.log(s);
}
console.log("================ classification ================");
console.log(`ADD COLUMN companies.brand_* (text, nullable, no default): ${seen.length}  ${seen.join(", ")}`);
console.log(`missing expected  : ${missing.length}${missing.length ? "  " + missing.join(" | ") : ""}`);
console.log(`duplicates        : ${dupes.length}${dupes.length ? "  " + dupes.join(" | ") : ""}`);
console.log(`forbidden patterns: ${forbidden.length}`);
for (const s of forbidden) console.log("  !! " + s.replace(/\n/g, "\n     "));
console.log(`unrelated stmts   : ${unrelated.length}`);
for (const s of unrelated) console.log("  !! " + s.replace(/\n/g, "\n     "));

const ok = stmts.length === 5 && seen.length === 5 && missing.length === 0 && dupes.length === 0 && unrelated.length === 0 && forbidden.length === 0;
if (!ok) {
  console.log(`RESULT: STOP — expected exactly the 5 approved additive column statements on companies; got ${stmts.length} statements with the problems listed above.`);
  process.exit(1);
}
console.log("RESULT: OK — exactly the 5 approved additive statements (ALTER TABLE \"companies\" ADD COLUMN brand_primary_color / brand_sidebar_color / brand_default_theme / brand_logo_key / brand_logo_content_type, all `text`, nullable, no default); no deletion, rename, type change, NOT NULL, default, data update, index/constraint or other-table change.");
