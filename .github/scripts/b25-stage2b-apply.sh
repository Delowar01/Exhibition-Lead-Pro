#!/bin/bash
# =============================================================================
# B25 STAGE 2B — legacy bucket → encrypted filesystem migration tooling: HOST PHASES
# (ops/b25-stage2b-migration-tooling). Streamed over SSH stdin by .github/workflows/b25-stage1-inspection.yml of THIS
# branch in the order purge-lib → apply-lib → stage2b-lib → THIS FILE → b25-stage1-apply.sh; the Stage 2A apply script is
# the unchanged Stage 2A library (STAGE2B_STAGE2A_OPS_SHA) plus one dispatch hook (`stage2b-*) stage2b_dispatch "$PHASE"`)
# so every Stage 2A reader, probe and gate is reused byte-for-byte and nothing of the Stage 2A model is redefined here.
#
# PHASES (every typed confirmation is validated by the workflow BEFORE any SSH session; none passes an ARG):
#   stage2b-preflight            READ-ONLY: host / runtime / the five locked variables / schema / jobs / the two-class inventory
#                                partition / the complete legacy reference census / capacity / native + migrated proofs /
#                                volume / exception / bucket partition / leak gates → B25_STAGE2B_PREFLIGHT_READY
#   stage2b-migrate-dry-run      READ-ONLY (product state): preflight in the same session → the migrate image built from
#                                exactly the product commit (docker image cache only) → `migrate-storage --dry-run` TWICE in a
#                                one-off container (target root opened read-only by the product; the only write is the
#                                summary file inside the discarded container) → identical sanitized summaries → inventory
#                                unchanged → B25_STAGE2B_DRY_RUN_REPORTED
#   stage2b-migrate-copy-verify  GUARDED MUTATION (typed confirmations: product commit, maintenance window,
#                                COPY_B25_STAGE2B_LEGACY_TO_FS): preflight → dry-run → copy lock → `--copy` (bounded
#                                concurrency / batch, read-back verified by the product) → `--verify` → every migrated row
#                                proven (shape, file, retained source) → native class and bucket inventory identical to the
#                                preflight → B25_STAGE2B_COPY_VERIFIED. Nothing is deleted anywhere; no env line is rendered.
#                                Maintenance dependency: the typed window confirmation attests an ACTIVE coordinated no-upload
#                                window; the application does not enforce one, so if the current window is released before a
#                                copy, a NEW coordinated window must be established (operationally) before the copy is run.
#                                Copy lock: created exclusively by this operation (a pre-existing lock fails closed), held
#                                during --copy / --verify / the post-copy facts, released ONLY after a TRUE copy verdict and
#                                ONLY when still owned (content = this run's record); a FALSE verdict, a failed step or a
#                                foreign lock leaves it in place as the review marker — every later mode fails closed on it.
#                                Copy scope (Batch 26): the fresh preflight / dry-run of the SAME session must observe exactly the
#                                owner-approved scope (S2B_COPY_SCOPE_*: legacy candidates, candidate bytes, unknown-size
#                                candidates = 0, dry-run planned = candidates, no transient legacy-source row) BEFORE the lock
#                                is written; any difference fails closed with nothing copied and no lock. These values are
#                                copy-authorization constraints, not inventory predicates: the library's 14 conditions never
#                                gate them, no historical census digest is gated; a different approved scope needs a new
#                                owner authorization and a new commit of the three values. Batch 27: the scope is checked TWICE —
#                                an EARLY checkpoint on the preflight facts (before the image build) and a FINAL checkpoint on a
#                                FRESH read plus this session's dry-run plan immediately before the lock; every source fact must
#                                be present exactly once with an integer value (missing / duplicated / malformed facts are named
#                                and fail closed, never resolved first- or last-wins). The read-only dry-run mode reports
#                                the same comparison informationally (never gates on it).
#   stage2b-postverify           READ-ONLY: `--verify` → inventory L = 0, U = 0 → two-class proofs → bucket unchanged →
#                                B25_STAGE2B_POSTVERIFY_READY
# Rollback boundary (design §6.3 rule 9): the retained legacy source IS the rollback copy; this tooling has no revert mode,
# never deletes a source, never sets legacy delete, never turns the fallback or the mirror off, never edits the env file.
# =============================================================================
stage2b_dispatch() {
  case "$1" in
    stage2b-preflight) phase_stage2b_preflight ;;
    stage2b-migrate-dry-run) phase_stage2b_migrate_dry_run ;;
    stage2b-migrate-copy-verify) phase_stage2b_migrate_copy_verify ;;
    stage2b-postverify) phase_stage2b_postverify ;;
    *) fail "stage2b phase '$1' is not implemented" ;;
  esac
}
stage2b_image_tag() { printf '%s:b25-stage2b-%s' "$S2B_IMAGE_REPO" "${STAGE2B_PRODUCT_SHA:0:12}"; }
stage2b_lock_file() { printf '%s/%s' "$HOME" "$S2B_LOCK_NAME"; }
# Owner-approved copy scope (Batch 26): copy-authorization constraints for the copy phase only — compared with the SAME
# session's fresh preflight / dry-run facts BEFORE the copy lock is written; never consulted by the 14 eligibility conditions.
readonly S2B_COPY_SCOPE_CANDIDATES=4          # legacy candidates: unregistered references = candidate rows = the dry-run's planned count
readonly S2B_COPY_SCOPE_BYTES=1299            # candidate bytes: the sum of every candidate's recorded size
readonly S2B_COPY_SCOPE_UNKNOWN_ROWS=0        # candidates of unknown size: an approved scope never contains one
stage2b_copy_scope_constants_ok() { [[ "$S2B_COPY_SCOPE_CANDIDATES" =~ ^[1-9][0-9]*$ ]] && [[ "$S2B_COPY_SCOPE_BYTES" =~ ^[1-9][0-9]*$ ]] && [ "$S2B_COPY_SCOPE_UNKNOWN_ROWS" = "0" ]; }
stage2b_scope_pick() {   # <facts> <key> → the integer value when the key occurs EXACTLY ONCE with an integer value; otherwise the marker missing | dup | malformed (never first- or last-wins)
  local n v; n="$(printf '%s\n' "$1" | grep -cE "^$2=" || true)"
  case "$n" in 0) echo missing; return 0 ;; 1) ;; *) echo dup; return 0 ;; esac
  v="$(printf '%s\n' "$1" | grep -E "^$2=" | cut -d= -f2-)"
  if [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"; else echo malformed; fi
}
stage2b_copy_scope_facts() {   # <preflight facts> [dry-run facts] → scope_* facts: the approved scope and the observations (an integer, or the marker missing | dup | malformed); scope_dr_planned only when a dry-run stream is given (final checkpoint)
  local pf="$1"
  echo "scope_expected_candidates=$S2B_COPY_SCOPE_CANDIDATES"
  echo "scope_expected_bytes=$S2B_COPY_SCOPE_BYTES"
  echo "scope_expected_unknown_rows=$S2B_COPY_SCOPE_UNKNOWN_ROWS"
  echo "scope_census_unregistered=$(stage2b_scope_pick "$pf" census_unregistered)"
  echo "scope_census_legacy_source=$(stage2b_scope_pick "$pf" census_legacy_source)"
  echo "scope_cand_rows=$(stage2b_scope_pick "$pf" cand_rows)"
  echo "scope_cand_bytes_known=$(stage2b_scope_pick "$pf" cand_bytes_known)"
  echo "scope_cand_bytes_unknown_rows=$(stage2b_scope_pick "$pf" cand_bytes_unknown_rows)"
  if [ $# -ge 2 ]; then echo "scope_dr_planned=$(stage2b_scope_pick "$2" dr_planned)"; fi
}
stage2b_copy_scope_eligible() {   # [early|final] (default final); reads the scope_* facts on stdin → one line per rule + B25_STAGE2B_COPY_SCOPE_CHECKPOINT / _FAILED / B25_STAGE2B_COPY_SCOPE=MATCH|MISMATCH; returns 0 only on MATCH (pure; fails closed on anything missing, duplicated or malformed)
  local form="${1:-final}"; case "$form" in early|final) ;; *) echo "B25_STAGE2B_COPY_SCOPE_CHECKPOINT=UNKNOWN"; echo "B25_STAGE2B_COPY_SCOPE_FAILED=1"; echo "B25_STAGE2B_COPY_SCOPE=MISMATCH"; return 1 ;; esac
  local -A f=() cnt=()
  local line failed=0 n=0 ok k
  while IFS= read -r line; do [[ "$line" =~ ^([a-z0-9_]+)=(.*)$ ]] || continue; k="${BASH_REMATCH[1]}"; f[$k]="${BASH_REMATCH[2]}"; cnt[$k]=$(( ${cnt[$k]:-0} + 1 )); done
  sg() { printf '%s' "${f[$1]:-<missing>}"; }
  snum() { [[ "$(sg "$1")" =~ ^[0-9]+$ ]]; }
  seq_() { snum "$1" && snum "$2" && [ "$(sg "$1")" = "$(sg "$2")" ]; }
  rule() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "scope $n: $1 — OK ($3)"; else echo "scope $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  ok=1; [[ "$(sg scope_expected_candidates)" =~ ^[1-9][0-9]*$ ]] && [[ "$(sg scope_expected_bytes)" =~ ^[1-9][0-9]*$ ]] && [ "$(sg scope_expected_unknown_rows)" = "0" ] && ok=0
  rule "the owner-approved scope is well-formed: candidates ≥ 1, bytes ≥ 1, unknown-size candidates exactly 0" $ok "expected=$(sg scope_expected_candidates)/$(sg scope_expected_bytes)/$(sg scope_expected_unknown_rows)"
  ok=1; seq_ scope_census_unregistered scope_expected_candidates && seq_ scope_cand_rows scope_expected_candidates && ok=0
  rule "fresh candidates = the approved count (unregistered census and candidate rows alike)" $ok "unregistered=$(sg scope_census_unregistered) cand_rows=$(sg scope_cand_rows) expected=$(sg scope_expected_candidates)"
  ok=1; seq_ scope_cand_bytes_known scope_expected_bytes && ok=0
  rule "fresh candidate bytes = the approved bytes" $ok "bytes=$(sg scope_cand_bytes_known) expected=$(sg scope_expected_bytes)"
  ok=1; seq_ scope_cand_bytes_unknown_rows scope_expected_unknown_rows && ok=0
  rule "no candidate of unknown size (= the approved 0)" $ok "unknown_rows=$(sg scope_cand_bytes_unknown_rows) expected=$(sg scope_expected_unknown_rows)"
  if [ "$form" = early ]; then
    ok=1; snum scope_census_legacy_source && [ "$(sg scope_census_legacy_source)" = "0" ] && ok=0
    rule "no transient legacy-source row exists (the dry-run plan is checked at the final checkpoint)" $ok "planned=<deferred> legacy_source=$(sg scope_census_legacy_source) expected=$(sg scope_expected_candidates)"
  else
    ok=1; seq_ scope_dr_planned scope_expected_candidates && snum scope_census_legacy_source && [ "$(sg scope_census_legacy_source)" = "0" ] && ok=0
    rule "this session's dry-run plans exactly the approved candidates and no transient legacy-source row exists" $ok "planned=$(sg scope_dr_planned) legacy_source=$(sg scope_census_legacy_source) expected=$(sg scope_expected_candidates)"
  fi
  # rule 6: every scope fact exactly once with an integer value — a missing, duplicated or malformed source fact is named here
  # (stage2b_scope_pick prints the marker instead of guessing) and a duplicated scope_* line in this stream is counted as dup
  local req="scope_expected_candidates scope_expected_bytes scope_expected_unknown_rows scope_census_unregistered scope_census_legacy_source scope_cand_rows scope_cand_bytes_known scope_cand_bytes_unknown_rows" flagged=""
  [ "$form" = final ] && req="$req scope_dr_planned"
  for k in $req; do
    if [ "${cnt[$k]:-0}" = 0 ]; then flagged="$flagged $k=missing"
    elif [ "${cnt[$k]}" != 1 ]; then flagged="$flagged $k=dup"
    elif ! [[ "${f[$k]}" =~ ^[0-9]+$ ]]; then case "${f[$k]}" in missing|dup|malformed) flagged="$flagged $k=${f[$k]}" ;; *) flagged="$flagged $k=malformed" ;; esac
    fi
  done
  ok=1; [ -z "$flagged" ] && ok=0
  rule "every scope fact is present exactly once with an integer value (none missing, duplicated or malformed)" $ok "$([ -n "$flagged" ] && printf '%s' "${flagged# }" || printf none)"
  echo "B25_STAGE2B_COPY_SCOPE_CHECKPOINT=$(printf '%s' "$form" | tr '[:lower:]' '[:upper:]')"
  echo "B25_STAGE2B_COPY_SCOPE_FAILED=$failed"
  if [ "$failed" = 0 ]; then echo "B25_STAGE2B_COPY_SCOPE=MATCH"; return 0; fi
  echo "B25_STAGE2B_COPY_SCOPE=MISMATCH"; return 1
}
# ---- the Stage 2B copy lock: owned by exactly one operation ---------------------------------------------------------------
# S2B_LOCK_EXPECT holds, in memory only, the record this operation wrote (start instant, product commit, a random token);
# it is empty in every read-only phase, so no lock can ever be "owned" there. Ownership = a regular, non-symlink, 0600 file of
# the current user whose content is exactly the record. A pre-existing lock is never adopted, never overwritten (exclusive
# creation) and never removed; the own lock is released only by stage2b_lock_release after a TRUE copy verdict.
S2B_LOCK_EXPECT=""
stage2b_lock_owned() {   # <lock path> → 0 only for this operation's own lock
  local l="$1"
  [ -n "${S2B_LOCK_EXPECT:-}" ] && [ -f "$l" ] && [ ! -L "$l" ] && [ "$(stat -c '%a:%u' "$l" 2>/dev/null)" = "600:$(id -u)" ] && [ "$(cat "$l" 2>/dev/null)" = "$S2B_LOCK_EXPECT" ]
}
stage2b_lock_write() {   # <lock path> → creates THIS operation's lock exclusively (fails closed on any existing entry)
  local l="$1" tok
  [ ! -e "$l" ] && [ ! -L "$l" ] || fail "a Stage 2B copy lock is present — a previous copy did not finish; review before any retry"
  tok="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [[ "$tok" =~ ^[0-9a-f]{32}$ ]] || fail "the copy lock token could not be generated"
  S2B_LOCK_EXPECT="started_at=$(date -u +%FT%TZ) product=$STAGE2B_PRODUCT_SHA token=$tok"
  ( umask 077; set -C; printf '%s\n' "$S2B_LOCK_EXPECT" > "$l" ) 2>/dev/null || { S2B_LOCK_EXPECT=""; fail "the Stage 2B copy lock could not be created exclusively — review before any retry"; }
  stage2b_lock_owned "$l" || fail "the copy lock just written is not this operation's — review before any retry"
}
stage2b_lock_release() {   # <lock path> → removes ONLY this operation's own lock (called only after a TRUE copy verdict)
  local l="$1"
  stage2b_lock_owned "$l" || fail "the copy lock is not this operation's (replaced or vanished) — NOT removed; review before any retry"
  rm -f "$l"
  [ ! -e "$l" ] && [ ! -L "$l" ] || fail "the copy lock could not be released — review before any retry"
  S2B_LOCK_EXPECT=""
}
# ---- the sanitized summary of migrate-storage → flat counts / booleans (runs inside the api container; stdin = the JSON) ----
STAGE2B_SUMMARY_JS=$(cat <<'JS'
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
const exc = String(a.exception || "");
const out = { parse_ok: false, mode: "none", complete: false, read_only: false, target_root: "unknown", source_references: 0, unique_objects: 0, registered: 0, registrations_planned: 0, unattributable: 0, processed: 0,
  planned: 0, copied: 0, already: 0, verified: 0, not_migrated: 0, unregistered: 0, missing_source: 0, checksum_mismatch: 0, conflict: 0, duplicate: 0, failed: 0, skipped: 0,
  duplicate_groups: 0, problems: 0, exception_listed: 0, digest: "" };
let s;
try { s = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { console.log(JSON.stringify(out)); process.exit(0); }
if (!s || typeof s !== "object" || typeof s.counts !== "object" || s.counts === null) { console.log(JSON.stringify(out)); process.exit(0); }
const modes = new Set(["dry-run", "copy", "verify"]);
out.parse_ok = modes.has(s.mode) && typeof s.complete === "boolean" && Array.isArray(s.problems) && Array.isArray(s.duplicateGroups);
if (!out.parse_ok) { console.log(JSON.stringify(out)); process.exit(0); }
out.mode = s.mode; out.complete = s.complete === true; out.read_only = s.readOnly === true; out.target_root = typeof s.targetRoot === "string" ? s.targetRoot : "unknown";
for (const k of ["sourceReferences", "uniqueObjects", "registered", "registrationsPlanned", "unattributable", "processed"]) { const v = Number(s[k]); out[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())] = Number.isInteger(v) && v >= 0 ? v : 0; }
for (const k of Object.keys(out)) { if (k in s.counts) { const v = Number(s.counts[k]); out[k] = Number.isInteger(v) && v >= 0 ? v : 0; } }
out.duplicate_groups = s.duplicateGroups.length; out.problems = s.problems.length;
out.exception_listed = s.problems.filter((p) => p && String(p.objectId || "") === exc).length;
const stable = { mode: out.mode, complete: out.complete, read_only: out.read_only, target_root: out.target_root, source_references: out.source_references, unique_objects: out.unique_objects, registered: out.registered, registrations_planned: out.registrations_planned, unattributable: out.unattributable, processed: out.processed, counts: s.counts, problems: s.problems.map((p) => [String(p.objectId || ""), Number(p.companyId || 0), String(p.kind || ""), String(p.status || ""), String(p.code || "")]).sort(), groups: s.duplicateGroups.map((g) => [Number(g.companyId || 0), String(g.legacyKeyHash || "")]).sort() };
out.digest = createHash("md5").update(JSON.stringify(stable)).digest("hex");
console.log(JSON.stringify(out));
JS
)
# ---- the retained legacy SOURCE of a migrated row: present in the configured bucket, size + plaintext digest = the row, canonical generation, unmarked original ----
STAGE2B_SOURCE_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
const { createHash } = require("node:crypto");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const out = { rows: rows.length, present: 0, bucket_ok: 0, size_ok: 0, sha_ok: 0, generation_ok: 0, marked: 0, generations_md5: "" };
  const gens = [];
  for (const r of rows) {
    const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(String(r.l || ""));
    if (!m) continue;
    if (m[1] === bucket) out.bucket_ok += 1;
    const f = storage.bucket(m[1]).file(m[2]);
    let meta; try { [meta] = await f.getMetadata(); } catch (e) { if (e && e.code === 404) continue; throw e; }
    out.present += 1;
    if (meta.metadata && meta.metadata["lcp-object-id"]) out.marked += 1;
    const gen = typeof meta.generation === "string" ? meta.generation : "";
    if (/^[1-9]\d*$/.test(gen)) out.generation_ok += 1;
    gens.push(String(r.id) + ":" + gen);
    if (String(meta.size) === String(r.s)) out.size_ok += 1;
    if (Number(meta.size) <= 8 * 1024 * 1024) { const [buf] = await f.download(); if (createHash("sha256").update(buf).digest("hex") === r.sha) out.sha_ok += 1; }
  }
  gens.sort(); out.generations_md5 = createHash("md5").update(gens.join("\n")).digest("hex");
  console.log(JSON.stringify(out));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
stage2b_summary_facts() {   # <prefix> <exit code> <summary json text> → <prefix>_* facts (counts, booleans, exit meaning, digest)
  local p="$1" rc="$2" txt="$3" arg cj k
  arg="$(printf '{"exception":"%s"}' "$B25PHYS_UUID" | base64 -w0)"
  cj="$(printf '%s\n' "$txt" | api_node_stdin "$STAGE2B_SUMMARY_JS" "$arg")"
  echo "${p}_exit=$rc"; echo "${p}_exit_meaning=$(s2b_exit_meaning "$rc")"
  if ! [[ "$cj" == \{* ]]; then echo "${p}_parse_ok=false"; return 0; fi
  for k in source_references unique_objects registered registrations_planned unattributable processed planned copied already verified not_migrated unregistered missing_source checksum_mismatch conflict duplicate failed skipped duplicate_groups problems exception_listed; do
    echo "${p}_$k=$(census_field "$cj" "$k" count 2>/dev/null || echo '?')"
  done
  for k in parse_ok complete read_only; do echo "${p}_$k=$(json_flat_field "$cj" "$k" 2>/dev/null | grep -xE 'true|false' || echo '?')"; done
  # json_flat_field returns a JSON string value WITH its quotes; only the fixed vocabularies below are ever printed
  echo "${p}_mode=$(json_flat_field "$cj" mode 2>/dev/null | tr -d '"' | grep -xE 'dry-run|copy|verify|none' || echo '?')"
  echo "${p}_target_root=$(json_flat_field "$cj" target_root 2>/dev/null | tr -d '"' | grep -xE 'present|absent|n/a|unknown' || echo '?')"
  echo "${p}_digest=$(census_field "$cj" digest hex32 2>/dev/null || echo '?')"
}
stage2b_output_leaks() {   # <text> → number of lines carrying a storage path, bucket reference, tenant key, 64-hex digest, key assignment or signature
  printf '%s\n' "$1" | grep -cE '/data/objects|gs://|tenants/[0-9]+/|OBJECT_STORAGE_ENCRYPTION_KEY=|[0-9a-f]{64}|X-Goog-Signature|Signature=' || true
}
# ---- readers (counts, booleans, md5 digests only) ----
stage2b_lock_facts() {   # absent = no entry of any kind at the lock path; owned = this operation's own lock (never true in a read-only phase)
  local l; l="$(stage2b_lock_file)"
  echo "s2b_lock_absent=$([ ! -e "$l" ] && [ ! -L "$l" ] && echo true || echo false)"
  echo "s2b_lock_owned=$(stage2b_lock_owned "$l" && echo true || echo false)"
}
stage2b_partition_facts() { q "$(s2b_partition_sql)"; }
stage2b_census_facts() { q "$(s2b_census_sql)"; q "$(s2b_candidate_bytes_sql)"; }
stage2b_capacity_facts() {
  local v; v="$(compose exec -T api sh -c 'df -B1 --output=avail /data/objects 2>/dev/null | tail -1' 2>/dev/null | tr -d ' \r')"
  echo "vol_free_bytes=$([[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo '?')"
}
stage2b_image_facts() {
  local tag label; tag="$(stage2b_image_tag)"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    echo "image_present=true"; label="$(docker image inspect "$tag" -f "{{index .Config.Labels \"$S2B_IMAGE_LABEL\"}}" 2>/dev/null || true)"
    echo "image_commit_ok=$([ "$label" = "$STAGE2B_PRODUCT_SHA" ] && echo true || echo false)"
  else echo "image_present=false"; echo "image_commit_ok=false"; fi
}
stage2b_image_ensure() {   # tooling image built from exactly the product commit of the app checkout (docker image cache only; no product state)
  local tag; tag="$(stage2b_image_tag)"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$STAGE2B_PRODUCT_SHA" ] || fail "app checkout is not the Stage 2B product commit"
  [ "$(git -C "$APP_DIR" status --porcelain | wc -l)" = "0" ] || fail "app checkout is dirty"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    export DOCKER_BUILDKIT=1
    docker build --quiet -f "$APP_DIR/docker/Dockerfile.api" --target migrate --label "$S2B_IMAGE_LABEL=$STAGE2B_PRODUCT_SHA" -t "$tag" "$APP_DIR" >/dev/null || fail "migrate image build failed"
  fi
  [ "$(docker image inspect "$tag" -f "{{index .Config.Labels \"$S2B_IMAGE_LABEL\"}}")" = "$STAGE2B_PRODUCT_SHA" ] || fail "migrate image is not labelled with the product commit"
}
stage2b_class_facts() {   # <nat|mig> → per-class facts: rows / predicate / association / keys digest / file probe (+ mirror probe for native, source probe for migrated)
  local cls="$1" p W pred live assoc rows_b64 fj k mrows_b64 mj
  case "$cls" in nat) p=nat; pred="$(s2b_native_sql 'so.')" ;; mig) p=mig; pred="$(s2b_migrated_sql 'so.')" ;; *) return 1 ;; esac
  W="so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and not $(s2b_duplicate_legacy_sql 'so.') and $pred"
  live="$(stage2a_live_row_sql 'so.')"; assoc="$(stage2a_assoc_sql 'so.')"
  echo "${p}_rows=$(q "select count(*) from storage_objects so where $W")"
  if [ "$cls" = nat ]; then echo "${p}_live_ok=$(q "select count(*) from storage_objects so where $W and $live")"; else echo "${p}_shape_ok=$(q "select count(*) from storage_objects so where $W")"; fi
  echo "${p}_assoc_ok=$(q "select count(*) from storage_objects so where $W and $assoc")"
  echo "${p}_keys_md5=$(q "select md5(coalesce(string_agg(so.storage_key, E'\n' order by so.storage_key collate \"C\"), '')) from storage_objects so where $W")"
  rows_b64="$(q "select json_build_object('marker', '', 'rows', coalesce(json_agg(json_build_object('id', so.id, 'k', so.storage_key, 's', so.size_bytes)), '[]'::json)) from storage_objects so where $W" | base64 -w0)"
  fj="$(api_node "$STAGE2A_FS_VERIFY_JS" "$rows_b64")"
  echo "${p}_pf_read_ok=$(census_field "$fj" rows count >/dev/null 2>&1 && echo true || echo false)"
  for k in present regular owner_ok mode_ok magic_ok pdf_free size_differs; do echo "${p}_pf_$k=$(census_field "$fj" "$k" count 2>/dev/null || echo '?')"; done
  echo "${p}_pf_cipher_md5=$(census_field "$fj" rows_cipher_md5 hex32 2>/dev/null || echo '?')"
  if [ "$cls" = nat ]; then
    for k in tenant_files other_files symlinks; do echo "fs_$k=$(census_field "$fj" "$k" count 2>/dev/null || echo '?')"; done
    mrows_b64="$(q "select coalesce(json_agg(json_build_object('id', so.id, 'k', so.storage_key, 'm', so.mirror_key, 's', so.size_bytes, 'sha', so.sha256)), '[]'::json) from storage_objects so where $W" | base64 -w0)"
    mj="$(api_node "$STAGE2A_MIRROR_JS" "$mrows_b64")"
    echo "${p}_pm_read_ok=$(census_field "$mj" rows count >/dev/null 2>&1 && echo true || echo false)"
    for k in present bucket_ok canonical_key marker_ok generation_ok size_ok sha_ok; do echo "${p}_pm_$k=$(census_field "$mj" "$k" count 2>/dev/null || echo '?')"; done
    echo "${p}_pm_generations_md5=$(census_field "$mj" generations_md5 hex32 2>/dev/null || echo '?')"
  else
    # migrated rows: the file probe names must match the evaluator (mf_*); the retained source probe (ms_*)
    for k in present regular owner_ok mode_ok magic_ok size_differs; do echo "${p}_mf_$k=$(census_field "$fj" "$k" count 2>/dev/null || echo '?')"; done
    echo "${p}_mf_read_ok=$(census_field "$fj" rows count >/dev/null 2>&1 && echo true || echo false)"
    mrows_b64="$(q "select coalesce(json_agg(json_build_object('id', so.id, 'l', so.legacy_key, 's', so.size_bytes, 'sha', so.sha256)), '[]'::json) from storage_objects so where $W" | base64 -w0)"
    mj="$(api_node "$STAGE2B_SOURCE_JS" "$mrows_b64")"
    echo "${p}_ms_read_ok=$(census_field "$mj" rows count >/dev/null 2>&1 && echo true || echo false)"
    for k in present bucket_ok size_ok sha_ok generation_ok marked; do echo "${p}_ms_$k=$(census_field "$mj" "$k" count 2>/dev/null || echo '?')"; done
    echo "${p}_ms_generations_md5=$(census_field "$mj" generations_md5 hex32 2>/dev/null || echo '?')"
  fi
}
stage2b_facts() {   # the complete read-only fact stream shared by every form
  local cid rf mg; cid="$(compose ps -q api || true)"
  stage2a_host_facts; stage2a_container_facts "$cid"; stage2a_readyz_facts
  stage2a_init_facts "$cid"; stage2a_container_env_facts; stage2a_web_leak_facts
  mg="$(stage2a_env_managed_of activate < "$ENV_FILE" | sha256sum | cut -c1-64)"
  echo "env_file_managed_ok=$([ "$mg" = "$(stage2a_env_lines activate | sha256sum | cut -c1-64)" ] && echo true || echo false)"
  echo "env_file_key_lines=$(stage2a_key_lines)"
  rf="$(stage2a_root_facts "$cid")"; printf '%s\n' "$rf"; echo "root_entries_allowed=$(stage2a_root_entries_allowed "$rf")"
  stage2a_exception_facts
  echo "refs_legacy_count=$(references_legacy "")"; echo "refs_ambiguous=$(references_ambiguous "")"
  stage2b_lock_facts; stage2b_partition_facts; stage2b_census_facts; stage2b_capacity_facts; stage2b_image_facts
  stage2b_class_facts nat; stage2b_class_facts mig
}
stage2b_print() { printf '%s\n' "$1" | grep -E "$2" | sed 's/^/  /'; }
stage2b_cli() {   # <dry-run|verify|copy> → stdout: the sanitized summary JSON followed by one line __S2B_EXIT=<rc>; the CLI's own log never leaves the container
  local mode="$1" args vmode pg_net cred gid out rc
  # the object volume is mounted READ-ONLY for the product's read-only modes (--dry-run / --verify open the target read-only
  # and never create the root; the summary and the CLI log are written to the container's own /tmp) and READ-WRITE for --copy only
  case "$mode" in
    dry-run) args="--dry-run"; vmode=ro ;;
    verify)  args="--verify"; vmode=ro ;;
    copy)    args="--copy --concurrency $S2B_COPY_CONCURRENCY --batch $S2B_COPY_BATCH --recheck"; vmode=rw ;;
    *) fail "stage2b_cli: unknown mode" ;;
  esac
  pg_net="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(compose ps -q postgres)" 2>/dev/null | head -c 200)"
  [[ "$pg_net" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "stage2b_cli: the compose network could not be resolved"
  cred="$(compose config 2>/dev/null | grep -oE 'source: /[^ ]*gcs-service-account\.json' | head -1 | cut -d' ' -f2)"
  [ -n "$cred" ] && [ -e "$cred" ] || fail "stage2b_cli: the api service's bucket credential mount could not be resolved"
  gid="$(grep -E '^GCS_CREDENTIAL_GID=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '"')"
  [[ "$gid" =~ ^[0-9]+$ ]] || fail "stage2b_cli: GCS_CREDENTIAL_GID is not numeric"
  # the one-off container: the migrate image of exactly the product commit, the api env file (read inside the container only),
  # the api runtime uid/gid (files it writes are the api's), the credential group, the object volume (ro / rw per mode), the
  # credential read-only
  out="$(docker run --rm --network "$pg_net" --env-file "$ENV_FILE" -e HOME=/tmp -e NODE_ENV=production --user "$S2B_RUNTIME_UID_GID" --group-add "$gid" -v "${STAGE2A_VOLUME}:/data/objects:$vmode" -v "$cred:/secrets/gcs-service-account.json:ro" --entrypoint sh "$(stage2b_image_tag)" -c "cd /repo && pnpm --filter @workspace/api-server run migrate-storage $args --out /tmp/b25-s2b-summary.json >/tmp/b25-s2b-cli.log 2>&1; rc=\$?; cat /tmp/b25-s2b-summary.json 2>/dev/null; echo; echo __S2B_EXIT=\$rc" </dev/null 2>/dev/null || true)"
  rc="$(printf '%s\n' "$out" | grep -oE '^__S2B_EXIT=[0-9]+$' | tail -1 | cut -d= -f2)"
  [[ "$rc" =~ ^[0-9]+$ ]] || rc=255
  printf '%s\n' "$out" | grep -vE '^__S2B_EXIT='
  echo "__S2B_EXIT=$rc"
}
stage2b_cli_run() {   # <mode> <prefix> → facts of one CLI run (summary parsed inside the api container; the JSON itself is never printed)
  local mode="$1" p="$2" raw rc js
  raw="$(stage2b_cli "$mode")"; rc="$(printf '%s\n' "$raw" | grep -oE '^__S2B_EXIT=[0-9]+$' | tail -1 | cut -d= -f2)"; js="$(printf '%s\n' "$raw" | grep -vE '^__S2B_EXIT=')"
  stage2b_summary_facts "$p" "${rc:-255}" "$js"
}
stage2b_evaluate() {   # <form> <facts> → prints the verdict, returns 0 only when the form's marker is TRUE
  local form="$1" facts="$2" verdict marker
  case "$form" in preflight) marker=B25_STAGE2B_PREFLIGHT_READY ;; dryrun) marker=B25_STAGE2B_DRY_RUN_REPORTED ;; copy) marker=B25_STAGE2B_COPY_VERIFIED ;; postverify) marker=B25_STAGE2B_POSTVERIFY_READY ;; *) fail "stage2b_evaluate: unknown form" ;; esac
  facts+=$'\n'"s2b_output_leaks=$(stage2b_output_leaks "$facts")"
  if verdict="$(printf '%s\n' "$facts" | stage2b_eligibility "$form")"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "stage2b evaluator ($form) failed — the lines above are the verdict"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx "$marker=TRUE"
}
stage2b_sections() {   # <facts> → the sanitized sections of a read-only report
  section "1. host / deployment / containers / readiness (product $STAGE2B_PRODUCT_SHA expected)"; stage2b_print "$1" '^(head_sha|current_deploy_sha|dirty|lock_absent|s2b_lock_absent|s2b_lock_owned|schema_fingerprint|storage_jobs_active|dead_jobs_total|api_running|api_health|web_health|pg_health|readyz_)'
  section "2. storage runtime configuration (values never printed) and the api log counters"; stage2b_print "$1" '^(init_|banner_|env_|log_|leak_|web_leak_)'
  section "3. the named volume"; stage2b_print "$1" '^(mount_|root_|fs_)'
  section "4. two-class inventory partition, legacy reference census, candidates, capacity, image"; stage2b_print "$1" '^(s2b_|census_(total|unregistered|legacy_source|migrated|native_resolved|unclassified|dup_|exception_refs|smoke_refs)|cand_|vol_free_bytes|image_)'
  section "5. native class (Correction 5 proofs) and migrated class (Stage 2B proofs)"; stage2b_print "$1" '^(nat_|mig_)'
  section "6. Stage 1 exception, bucket partition, originals, references"; stage2b_print "$1" '^(exc_|inv_|census_(objects|bytes|marked|generationless|md5)|unmarked_|originals_|refs_)'
}
# ---- phases ----
phase_stage2b_preflight() {   # READ-ONLY; no argument is read
  section "0. read-only guard"; stage2a_readonly_guard
  local facts; facts="$(stage2b_facts)"; stage2b_sections "$facts"
  section "7. preflight verdict (read-only decision; nothing is changed)"
  if stage2b_evaluate preflight "$facts"; then log "stage2b-preflight complete (read-only; nothing changed; B25_STAGE2B_PREFLIGHT_READY=TRUE)"
  else fail "stage2b-preflight: prerequisites not met (read-only; nothing changed; B25_STAGE2B_PREFLIGHT_READY=FALSE)"; fi
}
stage2b_dryrun_facts() {   # the product's --dry-run twice + inventory unchanged; appended to a fresh fact stream
  local before after r1 r2 d1 d2 same inv
  before="$(stage2b_partition_facts; stage2b_census_facts)"
  r1="$(stage2b_cli_run dry-run dr)"; r2="$(stage2b_cli_run dry-run dr2)"
  after="$(stage2b_partition_facts; stage2b_census_facts)"
  d1="$(printf '%s\n' "$r1" | grep -oE '^dr_digest=[0-9a-f]{32}$' | cut -d= -f2)"; d2="$(printf '%s\n' "$r2" | grep -oE '^dr2_digest=[0-9a-f]{32}$' | cut -d= -f2)"
  same=false; [ -n "$d1" ] && [ "$d1" = "$d2" ] && same=true
  inv=false; [ "$(printf '%s' "$before" | md5sum)" = "$(printf '%s' "$after" | md5sum)" ] && inv=true
  printf '%s\n' "$r1"; echo "dr_repeat_identical=$same"; echo "dr_inventory_unchanged=$inv"
}
phase_stage2b_migrate_dry_run() {   # READ-ONLY for product state; no argument is read
  section "0. read-only guard"; stage2a_readonly_guard
  local facts; facts="$(stage2b_facts)"; stage2b_sections "$facts"
  section "7. preflight verdict (must be TRUE before the product command runs)"
  stage2b_evaluate preflight "$facts" || fail "stage2b-migrate-dry-run: preflight not ready — the product command was not run"
  local pre; pre="pre_census_md5=$(printf '%s\n' "$facts" | grep -oE '^census_md5=[0-9a-f]{32}$' | cut -d= -f2)"
  section "8. migrate image from exactly the product commit (docker image cache only)"; stage2b_image_ensure; stage2b_image_facts | sed 's/^/  /'
  section "9. migrate-storage --dry-run twice (read-only target on a read-only mount; the summary never leaves the container unparsed)"
  local dr; dr="$(stage2b_dryrun_facts)"; stage2b_print "$dr" '^dr_(exit|exit_meaning|parse_ok|mode|complete|read_only|target_root|source_references|unique_objects|unattributable|planned|already|missing_source|checksum_mismatch|conflict|duplicate|failed|duplicate_groups|problems|exception_listed|repeat_identical|inventory_unchanged)='
  facts="$(stage2b_facts)"$'\n'"$pre"$'\n'"$dr"
  section "9b. owner-approved copy scope (reported only in this read-only mode; the copy mode fails closed on it before its lock)"
  local scope; if scope="$(stage2b_copy_scope_facts "$facts" "$dr" | stage2b_copy_scope_eligible final)"; then printf '%s\n' "$scope"; else printf '%s\n' "$scope"; log "the fresh candidate scope differs from the owner-approved copy scope — reported only (read-only mode; nothing changed); the copy mode would fail closed before its lock"; fi
  section "10. dry-run verdict (read-only decision; nothing is changed)"
  if stage2b_evaluate dryrun "$facts"; then log "stage2b-migrate-dry-run complete (nothing changed; B25_STAGE2B_DRY_RUN_REPORTED=TRUE)"
  else fail "stage2b-migrate-dry-run: the dry-run is not clean (nothing changed; B25_STAGE2B_DRY_RUN_REPORTED=FALSE)"; fi
}
phase_stage2b_migrate_copy_verify() {   # GUARDED MUTATION (confirmed by the workflow BEFORE SSH); no argument is read; nothing is deleted
  section "0. read-only guard (the copy itself is performed by the product command, never by this shell)"; stage2a_readonly_guard
  local lock; lock="$(stage2b_lock_file)"; [ ! -e "$lock" ] && [ ! -L "$lock" ] || fail "a Stage 2B copy lock is present — a previous copy did not finish; review before any retry"
  local facts pre; facts="$(stage2b_facts)"; stage2b_sections "$facts"
  section "7. preflight verdict (must be TRUE before anything else)"
  stage2b_evaluate preflight "$facts" || fail "stage2b-migrate-copy-verify: preflight not ready — nothing copied"
  section "7b. owner-approved copy scope — EARLY checkpoint (the preflight facts; fail-closed before the image build; re-checked in full on a fresh read immediately before the lock)"
  stage2b_copy_scope_constants_ok || fail "stage2b-migrate-copy-verify: the owner-approved copy scope constants are malformed — nothing copied; no image built; no lock written"
  local scope_early; if scope_early="$(stage2b_copy_scope_facts "$facts" | stage2b_copy_scope_eligible early)"; then printf '%s\n' "$scope_early"; else printf '%s\n' "$scope_early"; fail "stage2b-migrate-copy-verify: the fresh candidate scope is NOT the owner-approved scope at the early checkpoint (B25_STAGE2B_COPY_SCOPE=MISMATCH) — nothing copied; no image built; no lock written; a different scope needs a new owner authorization"; fi
  pre="pre_candidates=$(printf '%s\n' "$facts" | grep -oE '^census_unregistered=[0-9]+$' | cut -d= -f2)"$'\n'"pre_migrated=$(printf '%s\n' "$facts" | grep -oE '^s2b_migrated=[0-9]+$' | cut -d= -f2)"$'\n'"pre_native=$(printf '%s\n' "$facts" | grep -oE '^s2b_native=[0-9]+$' | cut -d= -f2)"$'\n'"pre_nat_keys_md5=$(printf '%s\n' "$facts" | grep -oE '^nat_keys_md5=[0-9a-f]{32}$' | cut -d= -f2)"$'\n'"pre_nat_pf_cipher_md5=$(printf '%s\n' "$facts" | grep -oE '^nat_pf_cipher_md5=[0-9a-f]{32}$' | cut -d= -f2)"$'\n'"pre_nat_pm_generations_md5=$(printf '%s\n' "$facts" | grep -oE '^nat_pm_generations_md5=[0-9a-f]{32}$' | cut -d= -f2)"$'\n'"pre_census_md5=$(printf '%s\n' "$facts" | grep -oE '^census_md5=[0-9a-f]{32}$' | cut -d= -f2)"
  section "8. migrate image from exactly the product commit"; stage2b_image_ensure; stage2b_image_facts | sed 's/^/  /'
  section "9. dry-run twice (must be clean before the copy; bucket inventory identical to the preflight)"
  local dr; dr="$(stage2b_dryrun_facts)"; stage2b_print "$dr" '^dr_(exit_meaning|complete|planned|already|missing_source|checksum_mismatch|conflict|duplicate|failed|exception_listed|repeat_identical|inventory_unchanged)='
  local facts2; facts2="$(stage2b_facts)"   # a FRESH read after the dry-run: the dry-run verdict and the FINAL scope checkpoint both consume it
  stage2b_evaluate dryrun "$facts2"$'\n'"$pre"$'\n'"$dr" || fail "stage2b-migrate-copy-verify: the dry-run is not clean — nothing copied"
  section "9b. owner-approved copy scope — FINAL checkpoint (the fresh read + this session's dry-run plan; fail-closed immediately BEFORE the copy lock; the 14 conditions above are unchanged)"
  stage2b_copy_scope_constants_ok || fail "stage2b-migrate-copy-verify: the owner-approved copy scope constants are malformed — nothing copied; no lock written"
  local scope; if scope="$(stage2b_copy_scope_facts "$facts2" "$dr" | stage2b_copy_scope_eligible final)"; then printf '%s\n' "$scope"; else printf '%s\n' "$scope"; fail "stage2b-migrate-copy-verify: the fresh candidate scope is NOT the owner-approved scope (B25_STAGE2B_COPY_SCOPE=MISMATCH) — nothing copied; no lock written; a different scope needs a new owner authorization"; fi
  section "10. copy (the product's --copy: register, copy, read back, flip rows; a conflicting local object is never overwritten; nothing is deleted)"
  # the copy lock: created exclusively by this operation (any existing entry fails closed), held through the copy, the verify
  # and the post-copy facts; the copy verdict is evaluated WHILE it is held (condition 1, copy form: present and owned)
  stage2b_lock_write "$lock"
  local cp vf; cp="$(stage2b_cli_run copy cp)"; stage2b_print "$cp" '^cp_(exit|exit_meaning|parse_ok|mode|complete|registered|processed|planned|copied|already|missing_source|checksum_mismatch|conflict|duplicate|failed|skipped|duplicate_groups|problems|exception_listed)='
  section "11. verify (the product's --verify: every migrated object read back against the inventory digest)"
  vf="$(stage2b_cli_run verify vf)"; stage2b_print "$vf" '^vf_(exit|exit_meaning|parse_ok|mode|complete|read_only|verified|not_migrated|unregistered|checksum_mismatch|failed|problems|exception_listed)='
  section "12. post-copy state (two-class inventory, native class and bucket inventory compared with the preflight; the copy lock still held)"
  facts="$(stage2b_facts)"$'\n'"$pre"$'\n'"$cp"$'\n'"$vf"; stage2b_sections "$facts"
  section "13. copy-verify verdict (evaluated while this operation's lock is held; the lock is released only on TRUE)"
  if stage2b_evaluate copy "$facts"; then
    stage2b_lock_release "$lock"
    log "stage2b-migrate-copy-verify complete (B25_STAGE2B_COPY_VERIFIED=TRUE; sources retained; nothing deleted; copy lock released)"
  else
    fail "stage2b-migrate-copy-verify: the copy is NOT fully verified (B25_STAGE2B_COPY_VERIFIED=FALSE) — nothing deleted; the retained legacy sources remain the rollback copies; the copy lock is RETAINED as the review marker (every later Stage 2B mode fails closed until it is removed after independent review); review the lines above before any further authorized copy"
  fi
}
phase_stage2b_postverify() {   # READ-ONLY; no argument is read
  section "0. read-only guard"; stage2a_readonly_guard
  local facts; facts="$(stage2b_facts)"; stage2b_sections "$facts"
  section "7. migrate image from exactly the product commit"; stage2b_image_ensure; stage2b_image_facts | sed 's/^/  /'
  section "8. migrate-storage --verify (read-only target)"
  local vf; vf="$(stage2b_cli_run verify vf)"; stage2b_print "$vf" '^vf_(exit|exit_meaning|parse_ok|mode|complete|read_only|target_root|verified|not_migrated|unregistered|checksum_mismatch|failed|problems|exception_listed)='
  facts="$(stage2b_facts)"$'\n'"$vf"
  section "9. postverify verdict (read-only decision; nothing is changed)"
  if stage2b_evaluate postverify "$facts"; then log "stage2b-postverify complete (read-only; nothing changed; B25_STAGE2B_POSTVERIFY_READY=TRUE)"
  else fail "stage2b-postverify: prerequisites not met (read-only; nothing changed; B25_STAGE2B_POSTVERIFY_READY=FALSE)"; fi
}
