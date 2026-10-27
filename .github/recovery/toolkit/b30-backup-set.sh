#!/bin/bash
# =============================================================================
# B30 — RECOVERY BACKUP SET (operator artefact; NOT product code). Toolkit v1.1 (Route B): v1 + the fail-closed
# stale-artifact / orphan-sidecar / retention-candidate / incomplete-set prechecks (the production backup script is unchanged).
# Runs on the VPS as the deploy user ONLY after the owner's separate A2 authorization and inside a
# declared quiet period (no uploads / branding changes / exports / deletions). Produces one NEW set
# directory under the backup tree with:
#   (1) a fresh PostgreSQL dump taken by the EXISTING hardened script docker/scripts/backup-postgres.sh
#       (its own flock, gzip test, size floor, completion marker, sha256 sidecar, no-clobber publication,
#       KEEP pruning — unchanged), hard-linked into the set;
#   (2) a READ-ONLY tar archive of the named encrypted object volume (GNU tar, --numeric-owner, modes
#       preserved; the volume is mounted :ro; ciphertext only);
#   (3) a plain-text manifest: locked commits, checkout + current-deploy identity, schema fingerprint,
#       inventory class counts, dump + archive digests/sizes/entry counts, the envelope KEY ID read from
#       the ciphertext headers (an identifier; the key itself is never read, never printed), variable NAMES;
#   (4) sha256 sidecars + SHA256SUMS; then a verification pass over the set.
# Product data is never modified: the volume is mounted read-only, every query is a SELECT in a
# read-only transaction, nothing is deleted (the existing dump script prunes only by its KEEP policy).
# RETENTION (B31): the existing dump script prunes dumps beyond KEEP after publishing; this set run passes KEEP=1000 by
# default so that it NEVER prunes anything (the nightly crontab run keeps its own KEEP=14 policy); every one-off container
# runs with --network none.
# Env NAMES (all optional): DEPLOY_PATH, BACKUP_DIR, STATE_DIR, KEEP (default 1000 = no pruning in this run),
# B30_CHECK_ONLY=1 (preconditions only, creates nothing), B30_KEYID_ONLY=1 (preconditions + envelope key id
# from the ciphertext headers for the owner's A1 comparison, creates nothing), B30_SCRIPT_DIR (b30-readback.ts),
# B30_EXPECTED_UNREGISTERED=4|0 (4 = pre-copy set, default; 0 = post-copy set after a verified copy).
# Exit 0 = set created and verified; 2 = verification mismatch (set kept as evidence); 1 = precondition.
# =============================================================================
set -euo pipefail
umask 077
readonly B30_PRODUCT_SHA="6a8dad1fe161dc1b31041794e5e3532e9f13327c"
readonly B30_OPS_SHA="443fa16468e58eef1e4061cb02932b22eacc6698"
readonly B30_SCHEMA_FINGERPRINT="30c4ecbd867cd2cd59abcb58581ecb04"
readonly B30_VOLUME="card-scanner-pro_objectdata"
readonly B30_LOCK_NAME=".b25-stage2b-copy.lock"
readonly B30_IMAGE_LABEL="b25.stage2b.commit"
readonly B30_IMAGE="cardscanner/migrate:b25-stage2b-${B30_PRODUCT_SHA:0:12}"
# B31: expected unregistered legacy references at the time of the set — 4 BEFORE the copy (the owner-approved Stage 2B
# scope: legacy references without an inventory row), 0 for the POST-COPY set after a verified copy. Only 0 or 4 accepted.
B30_EXPECTED_UNREGISTERED="${B30_EXPECTED_UNREGISTERED:-4}"
readonly B30_MIN_FREE_KB=524288           # 512 MiB floor on the backup filesystem
APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
KEEP="${KEEP:-1000}"   # B31: the set run never prunes (the existing script prunes to KEEP); the nightly cron keeps its own KEEP=14
SCRIPT_DIR="${B30_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
log()  { echo "[b30-backup] $(date -u +%FT%TZ) $*"; }
fail() { echo "[b30-backup] $(date -u +%FT%TZ) ERROR: $*" >&2; exit 1; }
compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }
# read-only SQL inside the postgres container as its own POSTGRES_USER (no credential leaves the container)
pgq() { compose exec -T postgres sh -c 'exec psql -X -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "set default_transaction_read_only = on" -c "$1"' sh "$1"; }
FP_SQL="select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"
INV_SQL="select 'inventory_total='||count(*)||' inventory_active='||count(*) filter (where state='active')||' inventory_active_fs='||count(*) filter (where state='active' and driver='fs')||' inventory_active_fs_migrated='||count(*) filter (where state='active' and driver='fs' and legacy_key is not null)||' inventory_active_gcs='||count(*) filter (where state='active' and driver='gcs')||' inventory_deleted='||count(*) filter (where state='deleted')||' inventory_other_states='||count(*) filter (where state not in ('active','deleted')) from storage_objects"
# header scan (no key): walks the mounted volume, parses each envelope header, reports counts + the single key id
read -r -d '' HEADER_JS <<'JS' || true
const fs=require("fs"),p=require("path");const root="/src";let tenant=0,health=0,magic=0,sym=0,bad=0;const ids=new Set();
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isSymbolicLink()){sym++;continue;}if(e.isDirectory()){walk(f);continue;}
const rel=p.relative(root,f);if(rel.split(p.sep)[0]==="health"){health++;continue;}tenant++;
try{const fd=fs.openSync(f,"r");const h=Buffer.alloc(7);fs.readSync(fd,h,0,7,0);if(h.subarray(0,4).toString("ascii")==="LCPO"&&h[4]===1){const n=h.readUInt16BE(5);const j=Buffer.alloc(n);fs.readSync(fd,j,0,n,7);const o=JSON.parse(j.toString("utf8"));if(o&&o.v===1&&typeof o.k==="string"){magic++;ids.add(o.k);}else bad++;}else bad++;fs.closeSync(fd);}catch(e){bad++;}}}
walk(root);
console.log(`volume_tenant_files=${tenant} volume_health_files=${health} volume_magic_ok=${magic} volume_header_bad=${bad} volume_symlinks=${sym} volume_key_ids=${ids.size} envelope_key_id=${ids.size===1?[...ids][0]:(ids.size===0?"none":"multiple")}`);
JS

log "B30 recovery backup set — preconditions"
[ -d "$APP_DIR/docker" ] || fail "app directory not found"
[ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || fail "backup directory missing or not writable by this user"
[ ! -e "$HOME/$B30_LOCK_NAME" ] && [ ! -L "$HOME/$B30_LOCK_NAME" ] || fail "a Stage 2B copy lock is present — no backup set while a copy is pending review"
[ "$(docker ps --format '{{.Image}}' | grep -c '^cardscanner/migrate' || true)" = "0" ] || fail "a migrate container is running — not a quiet period"
cd "$APP_DIR/docker"
compose ps --status running postgres --format '{{.Name}}' | grep -q . || fail "postgres service is not running"
compose ps --status running api --format '{{.Name}}' | grep -q . || fail "api service is not running"
docker volume inspect "$B30_VOLUME" >/dev/null 2>&1 || fail "named volume $B30_VOLUME not found"
head="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"; [ "$head" = "$B30_PRODUCT_SHA" ] || fail "app checkout is not the locked product commit"
[ -z "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ] || fail "app checkout is not clean"
cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || true)"; [ "$cur" = "$B30_PRODUCT_SHA" ] || fail "current-deploy.sha is not the locked product commit"
lbl="$(docker image inspect -f "{{index .Config.Labels \"$B30_IMAGE_LABEL\"}}" "$B30_IMAGE" 2>/dev/null || true)"; [ "$lbl" = "$B30_PRODUCT_SHA" ] || fail "migrate image for the locked product commit is not present / not labelled (run the authorized read-only dry-run mode first, which builds it)"
docker run --rm --network none --entrypoint tar "$B30_IMAGE" --version 2>/dev/null | head -1 | grep -q 'GNU tar' || fail "GNU tar not available in the migrate image"
free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2{print $4}')"; [ "$free_kb" -ge "$B30_MIN_FREE_KB" ] || fail "less than 512 MiB free on the backup filesystem"
[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || fail "KEEP must be a positive integer"
[ -f "$SCRIPT_DIR/b30-readback.ts" ] || fail "b30-readback.ts not found next to this script (toolkit incomplete; set B30_SCRIPT_DIR)"
[ "$B30_EXPECTED_UNREGISTERED" = "4" ] || [ "$B30_EXPECTED_UNREGISTERED" = "0" ] || fail "B30_EXPECTED_UNREGISTERED must be 4 (pre-copy set) or 0 (post-copy set)"
SET_PHASE="$([ "$B30_EXPECTED_UNREGISTERED" = "4" ] && echo pre-copy || echo post-copy)"
# v1.1 (Route B): the EXISTING dump script removes stale temporary dumps (.leadcapture-*.tmp) and orphan sidecars
# BEFORE it dumps and prunes dumps beyond KEEP AFTER it publishes. A set run must never be the occasion for any such
# removal: refuse (fail closed, nothing created) when a stale temporary file, an orphan sidecar or a retention-pruning
# candidate exists, and refuse while an INCOMPLETE set of an earlier run is still pending review.
stale_tmp="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '.leadcapture-*.tmp' 2>/dev/null | wc -l | tr -d ' ')"
[ "$stale_tmp" = "0" ] || fail "stale temporary dump file(s) present in the backup directory ($stale_tmp) — the existing backup script would delete them; review them under a separate authorization first"
orphans=0; for sc in "$BACKUP_DIR"/leadcapture-*.sql.gz.sha256; do [ -e "$sc" ] || continue; [ -e "${sc%.sha256}" ] || orphans=$((orphans + 1)); done
[ "$orphans" = "0" ] || fail "orphan sidecar(s) present ($orphans) — the existing backup script would delete them; review them first"
existing_dumps="$(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l | tr -d ' ' || true)"; existing_dumps="${existing_dumps:-0}"
[ "$((existing_dumps + 1))" -le "$KEEP" ] || fail "retention-pruning candidate: $existing_dumps dump(s) exist and KEEP=$KEEP — the existing script would prune after publishing; refusing"
incomplete="$(ls -d "$BACKUP_DIR"/recovery-sets/b30-*/.start 2>/dev/null | wc -l | tr -d ' ' || true)"; incomplete="${incomplete:-0}"
[ "$incomplete" = "0" ] || fail "an INCOMPLETE recovery set of an earlier run is pending review ($incomplete) — resolve it first"
log "preconditions OK (free_kb=$free_kb keep=$KEEP set_phase=$SET_PHASE expected_unregistered=$B30_EXPECTED_UNREGISTERED existing_dumps=$existing_dumps stale_tmp=0 orphan_sidecars=0 retention_candidates=0 incomplete_sets=0)"
if [ "${B30_CHECK_ONLY:-0}" = "1" ]; then log "B30_CHECK_ONLY=1 — nothing created"; exit 0; fi
if [ "${B30_KEYID_ONLY:-0}" = "1" ]; then
  # A1 support: read ONLY the ciphertext envelope headers of the volume (never the key) and print the
  # non-secret envelope key id for the owner's offline comparison; creates nothing
  hdr="$(docker run --rm --network none --user 999:999 -v "$B30_VOLUME:/src:ro" --entrypoint node "$B30_IMAGE" -e "$HEADER_JS" 2>/dev/null | tail -1)"
  [[ "$hdr" =~ ^volume_tenant_files=[0-9]+ ]] || fail "header scan failed"
  log "B30_KEYID_ONLY=1 — nothing created; $hdr"
  exit 0
fi

SET="$BACKUP_DIR/recovery-sets/b30-$STAMP"
[ ! -e "$SET" ] || fail "set directory already exists"
mkdir -p "$SET"; chmod 700 "$SET"; : > "$SET/.start"
# B31: on any abort after this point the partial directory is KEPT (never auto-deleted) and named as incomplete;
# the restore script refuses it (no SHA256SUMS / manifest). Remove it manually after review.
on_exit() { [ -e "$SET/.start" ] && echo "[b30-backup] $(date -u +%FT%TZ) INCOMPLETE SET left for review (contains .start; unusable): $(basename "$SET")" >&2; return 0; }
trap on_exit EXIT
log "set directory created: $(basename "$SET")"

log "step 1 — fresh PostgreSQL dump through the existing hardened script"
KEEP="$KEEP" bash "$APP_DIR/docker/scripts/backup-postgres.sh" || fail "backup-postgres.sh failed — no set"
DUMP="$(ls -1t "$BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | head -1 || true)"
[ -n "$DUMP" ] && [ "$DUMP" -nt "$SET/.start" ] || fail "no new dump published by the backup script"
[ -e "$DUMP.sha256" ] || fail "the new dump has no sidecar"
DUMPNAME="$(basename "$DUMP")"
ln "$DUMP" "$SET/$DUMPNAME" 2>/dev/null || cp "$DUMP" "$SET/$DUMPNAME"
ln "$DUMP.sha256" "$SET/$DUMPNAME.sha256" 2>/dev/null || cp "$DUMP.sha256" "$SET/$DUMPNAME.sha256"
( cd "$SET" && sha256sum -c --quiet "$DUMPNAME.sha256" ) || fail "dump sidecar mismatch"
gzip -t "$SET/$DUMPNAME" || fail "dump gzip test failed"
zcat "$SET/$DUMPNAME" | tail -c 4096 | awk '$0 == "-- PostgreSQL database dump complete" { f = 1 } END { exit(f ? 0 : 1) }' || fail "dump completion marker missing"
dump_sha="$(cut -c1-64 "$SET/$DUMPNAME.sha256")"; dump_bytes="$(stat -c %s "$SET/$DUMPNAME")"
log "dump: $DUMPNAME bytes=$dump_bytes sidecar verified"

log "step 2 — read-only database facts"
fp="$(pgq "$FP_SQL" | tr -d '[:space:]')"; [[ "$fp" =~ ^[0-9a-f]{32}$ ]] || fail "schema fingerprint unreadable"
inv="$(pgq "$INV_SQL" | tr -d '\r' | head -1)"; [[ "$inv" =~ ^inventory_total=[0-9]+ ]] || fail "inventory counts unreadable"
active_fs="$(printf '%s\n' "$inv" | grep -oE 'inventory_active_fs=[0-9]+' | cut -d= -f2)"
log "fingerprint_match=$([ "$fp" = "$B30_SCHEMA_FINGERPRINT" ] && echo true || echo false) $inv"

log "step 3 — read-only archive of the encrypted object volume"
ARCHIVE="objectdata-$STAMP.tar"
docker run --rm --network none --user 0:0 -e OUT_UID="$(id -u)" -e OUT_GID="$(id -g)" -e NAME="$ARCHIVE" \
  -v "$B30_VOLUME:/src:ro" -v "$SET:/out" --entrypoint sh "$B30_IMAGE" \
  -c 'set -e; umask 077; tar --numeric-owner -C /src -cf "/out/$NAME" . && chown "$OUT_UID:$OUT_GID" "/out/$NAME" && chmod 600 "/out/$NAME"' \
  || fail "volume archive failed"
[ -s "$SET/$ARCHIVE" ] || fail "archive missing or empty"
archive_bytes="$(stat -c %s "$SET/$ARCHIVE")"
archive_entries="$(tar -tf "$SET/$ARCHIVE" | wc -l | tr -d ' ')"
archive_regular="$(tar -tvf "$SET/$ARCHIVE" | grep -c '^-' || true)"
archive_symlinks="$(tar -tvf "$SET/$ARCHIVE" | grep -c '^l' || true)"
log "archive: $ARCHIVE bytes=$archive_bytes entries=$archive_entries regular_files=$archive_regular symlinks=$archive_symlinks"

log "step 4 — envelope header scan (no key): key id + counts"
hdr="$(docker run --rm --network none --user 999:999 -v "$B30_VOLUME:/src:ro" --entrypoint node "$B30_IMAGE" -e "$HEADER_JS" 2>/dev/null | tail -1)"
[[ "$hdr" =~ ^volume_tenant_files=[0-9]+ ]] || fail "header scan failed"
key_id="$(printf '%s\n' "$hdr" | grep -oE 'envelope_key_id=[0-9a-f]{16}' | cut -d= -f2 || true)"
tenant_files="$(printf '%s\n' "$hdr" | grep -oE 'volume_tenant_files=[0-9]+' | cut -d= -f2)"
health_files="$(printf '%s\n' "$hdr" | grep -oE 'volume_health_files=[0-9]+' | cut -d= -f2)"
magic_ok="$(printf '%s\n' "$hdr" | grep -oE 'volume_magic_ok=[0-9]+' | cut -d= -f2)"
vol_symlinks="$(printf '%s\n' "$hdr" | grep -oE 'volume_symlinks=[0-9]+' | cut -d= -f2)"
log "$hdr"

log "step 5 — manifest + sidecars"
archive_sha="$(sha256sum "$SET/$ARCHIVE" | cut -c1-64)"
printf '%s\n' "$archive_sha  $ARCHIVE" > "$SET/$ARCHIVE.sha256"
cp "$SCRIPT_DIR/b30-readback.ts" "$SET/b30-readback.ts"; helper_sha="$(sha256sum "$SET/b30-readback.ts" | cut -c1-64)"
MANIFEST="recovery-$STAMP.txt"
{
  echo "b30_manifest_version=1"
  echo "created_utc=$(date -u +%FT%TZ)"
  echo "product_commit=$B30_PRODUCT_SHA"
  echo "ops_commit=$B30_OPS_SHA"
  echo "checkout_head=$head"
  echo "current_deploy_sha=$cur"
  echo "schema_fingerprint=$fp"
  echo "schema_fingerprint_expected=$B30_SCHEMA_FINGERPRINT"
  echo "dump_file=$DUMPNAME"
  echo "dump_sha256=$dump_sha"
  echo "dump_bytes=$dump_bytes"
  echo "archive_file=$ARCHIVE"
  echo "archive_sha256=$archive_sha"
  echo "archive_bytes=$archive_bytes"
  echo "archive_entries=$archive_entries"
  echo "archive_regular_files=$archive_regular"
  echo "archive_symlinks=$archive_symlinks"
  printf '%s\n' "$inv" | tr ' ' '\n'
  printf '%s\n' "$hdr" | tr ' ' '\n'
  echo "set_phase=$SET_PHASE"
  echo "expected_unregistered_before_copy=$B30_EXPECTED_UNREGISTERED"
  echo "readback_helper_sha256=$helper_sha"
  echo "storage_variable_names=OBJECT_STORAGE_DRIVER=fs OBJECT_STORAGE_FS_ROOT=<locked> OBJECT_STORAGE_LEGACY_FALLBACK=true OBJECT_STORAGE_MIRROR=gcs OBJECT_STORAGE_LEGACY_DELETE=false"
  echo "encryption_key=OBJECT_STORAGE_ENCRYPTION_KEY is held offline by the owner (key id above); the value is never stored in this set"
} > "$SET/$MANIFEST"
( cd "$SET" && sha256sum "$MANIFEST" > "$MANIFEST.sha256" && sha256sum "$DUMPNAME" "$ARCHIVE" "$MANIFEST" b30-readback.ts > SHA256SUMS )
chmod 600 "$SET"/*; rm -f "$SET/.start"

log "step 6 — verification of the set"
rc=0
( cd "$SET" && sha256sum -c --quiet SHA256SUMS ) && log "sha256sums: OK" || { log "sha256sums: FAIL"; rc=2; }
[ "$fp" = "$B30_SCHEMA_FINGERPRINT" ] && log "fingerprint: MATCH" || { log "fingerprint: MISMATCH"; rc=2; }
[ "$tenant_files" = "$active_fs" ] && log "volume tenant files = inventory active fs rows ($tenant_files): MATCH" || { log "volume tenant files ($tenant_files) != inventory active fs rows ($active_fs): MISMATCH"; rc=2; }
[ "$magic_ok" = "$tenant_files" ] && log "envelope headers: all tenant files valid" || { log "envelope headers: $magic_ok of $tenant_files valid"; rc=2; }
[ "$vol_symlinks" = "0" ] && [ "$archive_symlinks" = "0" ] && log "symlinks: none" || { log "symlinks present"; rc=2; }
[ "$archive_regular" = "$((tenant_files + health_files))" ] && log "archive regular files = tenant + health files ($archive_regular): MATCH" || { log "archive regular files ($archive_regular) != tenant + health ($((tenant_files + health_files))): MISMATCH"; rc=2; }
[ -n "$key_id" ] && log "envelope key id: single (recorded in the manifest)" || { log "envelope key id: not single"; rc=2; }
[ "$rc" = 0 ] && log "RECOVERY SET VERIFIED: $(basename "$SET")" || log "RECOVERY SET NOT VERIFIED (kept as evidence): $(basename "$SET")"
exit "$rc"
