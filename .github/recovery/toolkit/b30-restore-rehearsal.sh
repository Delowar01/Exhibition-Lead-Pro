#!/bin/bash
# =============================================================================
# B30 — DISPOSABLE RESTORE REHEARSAL (operator artefact; NOT product code; NOT committed).
# Runs ONLY after the owner's separate A3 authorization, on the VPS (as the deploy user) or on another
# docker host that has the same images. Restores ONE recovery set (made by b30-backup-set.sh) into
# THROWAWAY containers and volumes on an INTERNAL docker network — no internet, no bucket, no live
# database, no live volume — and verifies:
#   restore: psql with ON_ERROR_STOP + --single-transaction (the dump is streamed, never stored decompressed),
#   B31: every one-off container (tar version probe, extraction, ownership check) runs with --network none;
#   only the throwaway postgres, the read-back helper and the verify container join the internal-only network.
#            public table count, schema fingerprint = manifest, inventory class counts = manifest;
#   archive: GNU tar extraction (--numeric-owner, permissions preserved) into a throwaway volume, regular
#            file count = manifest, every entry owned by 999:999, files 0600, directories 0700, no symlink;
#   objects: b30-readback.ts (the product's FsStorageDriver in read-only mode): envelope header, key id,
#            storage-key binding, ACTUAL decrypt + size/SHA-256 read-back of every active fs row, no
#            unexpected entry;
#   product: `migrate-storage --verify` offline (no bucket variable → the legacy driver is null), invoked as the
#            package script's own command (tsx ./scripts/migrate-storage.ts) so that no package manager can try to
#            fetch its pinned version inside the network-less container: before
#            the copy the EXPECTED result is incomplete with unregistered = the manifest's
#            expected_unregistered_before_copy and verified = active fs rows that carry a legacy key (0);
#            that is classified EXPECTED_INCOMPLETE, never as a restore failure; any mismatch / failed /
#            not_migrated is a failure.
# The owner supplies the key ONLY through B30_KEY_ENV_FILE: a file created with umask 077 on tmpfs whose
# single line is OBJECT_STORAGE_ENCRYPTION_KEY=<value>. The script never prints env values and removes the
# file (shred when available) at the end. Every throwaway resource is removed on exit; a final residue
# check must find none. Verdict: RESTORE VERIFIED only when every check passes, otherwise NOT VERIFIED.
# Usage: B30_KEY_ENV_FILE=/dev/shm/b30.env bash b30-restore-rehearsal.sh <recovery-set directory>
#        B30_DRY_RUN=1 prints the plan after the local input checks and executes nothing.
# Env NAMES (optional): DEPLOY_PATH (to resolve the running postgres image), B30_PG_IMAGE (override),
# B30_DRY_RUN, B30_KEEP_KEY_FILE=1 (do not delete the owner's key env file).
# =============================================================================
set -euo pipefail
umask 077
readonly B30_PRODUCT_SHA="6a8dad1fe161dc1b31041794e5e3532e9f13327c"
readonly B30_LOCK_NAME=".b25-stage2b-copy.lock"
readonly B30_IMAGE_LABEL="b25.stage2b.commit"
readonly B30_IMAGE="cardscanner/migrate:b25-stage2b-${B30_PRODUCT_SHA:0:12}"
readonly NET="b30-restore" PG="b30-restore-pg" PGVOL="b30-restore-pgdata" OBJVOL="b30-restore-objectdata"
APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
SET="${1:?usage: b30-restore-rehearsal.sh <recovery-set directory>}"
KEYENV="${B30_KEY_ENV_FILE:-}"
DRY="${B30_DRY_RUN:-0}"
log()  { echo "[b30-restore] $(date -u +%FT%TZ) $*"; }
fail() { echo "[b30-restore] $(date -u +%FT%TZ) ERROR: $*" >&2; exit 1; }
getm() { grep -E "^$1=" "$MANIFEST" | head -1 | cut -d= -f2-; }
FP_SQL="select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"
INV_SQL="select 'inventory_total='||count(*)||' inventory_active='||count(*) filter (where state='active')||' inventory_active_fs='||count(*) filter (where state='active' and driver='fs')||' inventory_active_fs_migrated='||count(*) filter (where state='active' and driver='fs' and legacy_key is not null)||' inventory_active_gcs='||count(*) filter (where state='active' and driver='gcs')||' inventory_deleted='||count(*) filter (where state='deleted')||' inventory_other_states='||count(*) filter (where state not in ('active','deleted')) from storage_objects"
# in-container parser of the product's sanitized verify summary: fixed fields only
read -r -d '' VERIFY_JS <<'JS' || true
const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync("/tmp/b30-verify.json","utf8"));}catch(e){console.log("vf_parse_ok=false");process.exit(0);}
const c=s.counts||{};const g=(k)=>Number.isInteger(c[k])?c[k]:-1;
console.log(`vf_parse_ok=true vf_mode=${s.mode} vf_read_only=${s.readOnly===true} vf_target_root=${s.targetRoot} vf_complete=${s.complete===true} vf_source_references=${s.sourceReferences} vf_unique_objects=${s.uniqueObjects} vf_verified=${g("verified")} vf_not_migrated=${g("not_migrated")} vf_unregistered=${g("unregistered")} vf_checksum_mismatch=${g("checksum_mismatch")} vf_failed=${g("failed")} vf_duplicate=${g("duplicate")} vf_missing_source=${g("missing_source")}`);
JS

# ---- local input checks (no docker) ------------------------------------------------------------------
[ -d "$SET" ] || fail "recovery set directory not found"
MANIFEST="$(ls -1 "$SET"/recovery-*.txt 2>/dev/null | head -1 || true)"; [ -n "$MANIFEST" ] || fail "manifest not found in the set (incomplete or foreign directory)"
( cd "$SET" && sha256sum -c --quiet SHA256SUMS ) || fail "SHA256SUMS verification failed — the set is not trustworthy"
DUMP="$SET/$(getm dump_file)"; ARCHIVE="$SET/$(getm archive_file)"; HELPER="$SET/b30-readback.ts"
[ -f "$DUMP" ] && [ -f "$ARCHIVE" ] && [ -f "$HELPER" ] || fail "dump, archive or b30-readback.ts missing from the set"
gzip -t "$DUMP" || fail "dump gzip test failed"
zcat "$DUMP" | tail -c 4096 | awk '$0 == "-- PostgreSQL database dump complete" { f = 1 } END { exit(f ? 0 : 1) }' || fail "dump completion marker missing"
m_fp="$(getm schema_fingerprint)"; m_inv_active_fs="$(getm inventory_active_fs)"; m_inv_migrated="$(getm inventory_active_fs_migrated)"
m_key_id="$(getm envelope_key_id)"; m_regular="$(getm archive_regular_files)"; m_unreg="$(getm expected_unregistered_before_copy)"
m_inv_line="$(grep -E '^inventory_' "$MANIFEST" | tr '\n' ' ' | sed 's/ $//')"
[[ "$m_fp" =~ ^[0-9a-f]{32}$ ]] && [[ "$m_inv_active_fs" =~ ^[0-9]+$ ]] && [[ "$m_inv_migrated" =~ ^[0-9]+$ ]] && [[ "$m_key_id" =~ ^[0-9a-f]{16}$ ]] && [[ "$m_regular" =~ ^[0-9]+$ ]] && [[ "$m_unreg" =~ ^[0-9]+$ ]] || fail "manifest fields malformed"
if [ "$DRY" != "1" ]; then
  [ -n "$KEYENV" ] && [ -f "$KEYENV" ] && [ ! -L "$KEYENV" ] || fail "B30_KEY_ENV_FILE must name the owner's key env file (regular file)"
  [ "$(stat -c %a "$KEYENV")" = "600" ] || fail "key env file must be mode 600"
  # B31: EVERY line must be the single key assignment (no second variable can be smuggled into the containers)
  KEY_RE='^OBJECT_STORAGE_ENCRYPTION_KEY=([0-9a-fA-F]{64}|[A-Za-z0-9+/=_-]{43,44})$'
  [ "$(grep -cE "$KEY_RE" "$KEYENV")" = "1" ] && [ "$(grep -cvE "$KEY_RE" "$KEYENV")" = "0" ] || fail "key env file must contain exactly one line OBJECT_STORAGE_ENCRYPTION_KEY=<64 hex or base64 of 32 bytes> and nothing else"
  [ ! -e "$HOME/$B30_LOCK_NAME" ] && [ ! -L "$HOME/$B30_LOCK_NAME" ] || fail "a Stage 2B copy lock is present"
  [ "$(docker ps --format '{{.Image}}' | grep -c '^cardscanner/migrate' || true)" = "0" ] || fail "a migrate container is running"
  lbl="$(docker image inspect -f "{{index .Config.Labels \"$B30_IMAGE_LABEL\"}}" "$B30_IMAGE" 2>/dev/null || true)"; [ "$lbl" = "$B30_PRODUCT_SHA" ] || fail "migrate image for the locked product commit not present / not labelled"
  docker run --rm --network none --entrypoint tar "$B30_IMAGE" --version 2>/dev/null | head -1 | grep -q 'GNU tar' || fail "GNU tar not available in the migrate image"
  for n in "$PG"; do docker ps -a --format '{{.Names}}' | grep -qx "$n" && fail "residue from an earlier rehearsal: container $n"; done
  for v in "$PGVOL" "$OBJVOL"; do docker volume ls --format '{{.Name}}' | grep -qx "$v" && fail "residue from an earlier rehearsal: volume $v"; done
  docker network ls --format '{{.Name}}' | grep -qx "$NET" && fail "residue from an earlier rehearsal: network $NET"
  if [ -n "${B30_PG_IMAGE:-}" ]; then PGIMG="$B30_PG_IMAGE"
  elif [ -d "$APP_DIR/docker" ]; then PGIMG="$(cd "$APP_DIR/docker" && docker inspect -f '{{.Image}}' "$(docker compose -f docker-compose.yml -f compose.vps.yml ps -q postgres)" 2>/dev/null || true)"
  fi
  [ -n "${PGIMG:-}" ] || fail "postgres image could not be resolved (set B30_PG_IMAGE)"
fi
log "inputs OK: set=$(basename "$SET") active_fs=$m_inv_active_fs migrated=$m_inv_migrated expected_unregistered=$m_unreg archive_regular_files=$m_regular"

if [ "$DRY" = "1" ]; then
  cat <<PLAN
[b30-restore] DRY RUN — nothing executed. Plan:
  1. docker network create --internal $NET ; docker volume create $PGVOL ; docker volume create $OBJVOL
  2. docker run -d --name $PG --network $NET --memory 640m --cpus 1 -e POSTGRES_USER=b30 -e POSTGRES_DB=b30restore -e POSTGRES_PASSWORD=<random, never printed> -v $PGVOL:/var/lib/postgresql/data <postgres image of the running stack>
     wait: docker exec $PG pg_isready -U b30 -d b30restore
  3. create the dump's owner role; zcat <dump> | docker exec -i $PG psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U b30 -d b30restore -f -
  4. checks in $PG: public table count; schema fingerprint = manifest ($m_fp); inventory counts = manifest
  5. docker run --rm --network none --user 0:0 -v $OBJVOL:/dst -v <set>:/in:ro --entrypoint sh $B30_IMAGE -c 'tar --numeric-owner -C /dst -xpf /in/<archive> && chown 999:999 /dst && chmod 700 /dst'
     checks: regular files = $m_regular; owner 999:999 everywhere; files 0600; dirs 0700; no symlink
  6. docker run --rm --user 999:999 --network $NET --env-file <key env file> -e HOME=/tmp -e DATABASE_URL=<throwaway> -e OBJECT_STORAGE_DRIVER=fs -e OBJECT_STORAGE_FS_ROOT=/restore/objects -e B30_EXPECT_ROWS=$m_inv_active_fs -e B30_EXPECT_KEY_ID=<manifest key id> -v $OBJVOL:/restore/objects:ro -v <set>/b30-readback.ts:/repo/artifacts/api-server/scripts/b30-readback.ts:ro --entrypoint sh $B30_IMAGE -c 'cd /repo/artifacts/api-server && exec ./node_modules/.bin/tsx scripts/b30-readback.ts'
     expected: B30_READBACK … result=PASS
  7. docker run --rm --user 999:999 --network $NET --env-file <key env file> -e HOME=/tmp -e NODE_ENV=development -e SESSION_SECRET=<random> -e DATABASE_URL=<throwaway> -e OBJECT_STORAGE_DRIVER=fs -e OBJECT_STORAGE_FS_ROOT=/restore/objects -v $OBJVOL:/restore/objects:ro --entrypoint sh $B30_IMAGE -c 'cd /repo/artifacts/api-server && ./node_modules/.bin/tsx ./scripts/migrate-storage.ts --verify --out /tmp/b30-verify.json'
     expected before the copy: readOnly=true targetRoot=present verified=$m_inv_migrated unregistered=$m_unreg not_migrated=0 checksum_mismatch=0 failed=0 → EXPECTED_INCOMPLETE (exit 2 is expected); after a copy: unregistered=0, complete=true
  8. cleanup: docker rm -f $PG ; docker volume rm $PGVOL $OBJVOL ; docker network rm $NET ; shred -u <key env file> ; residue check
PLAN
  exit 0
fi

# ---- execution ----------------------------------------------------------------------------------------
TMP="$(mktemp -d)"; chmod 700 "$TMP"
VERDICT="NOT VERIFIED"; FAILS=()
note_fail() { FAILS+=("$1"); log "CHECK FAIL: $1"; }
cleanup() {
  set +e
  docker rm -f "$PG" >/dev/null 2>&1
  docker volume rm "$PGVOL" "$OBJVOL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  if [ "${B30_KEEP_KEY_FILE:-0}" != "1" ] && [ -n "$KEYENV" ] && [ -f "$KEYENV" ]; then
    if command -v shred >/dev/null 2>&1; then shred -u "$KEYENV" 2>/dev/null || rm -f "$KEYENV"; else rm -f "$KEYENV"; fi
  fi
  rm -rf "$TMP"
  local residue=0
  docker ps -a --format '{{.Names}}' | grep -qx "$PG" && residue=1
  docker volume ls --format '{{.Name}}' | grep -qxE "$PGVOL|$OBJVOL" && residue=1
  docker network ls --format '{{.Name}}' | grep -qx "$NET" && residue=1
  [ "$residue" = 0 ] && log "cleanup: no residue (containers, volumes, network, key file removed)" || log "cleanup: RESIDUE REMAINS — remove manually"
  log "VERDICT: RESTORE $VERDICT${FAILS[*]:+ (failed checks: ${#FAILS[@]})}"
}
trap cleanup EXIT

log "step 1 — isolated network and throwaway volumes"
docker network create --internal "$NET" >/dev/null
docker volume create "$PGVOL" >/dev/null; docker volume create "$OBJVOL" >/dev/null

log "step 2 — throwaway postgres"
PGPW="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name "$PG" --network "$NET" --memory 640m --cpus 1 -e POSTGRES_USER=b30 -e POSTGRES_DB=b30restore -e POSTGRES_PASSWORD="$PGPW" -v "$PGVOL:/var/lib/postgresql/data" "$PGIMG" >/dev/null
for i in $(seq 1 60); do docker exec "$PG" pg_isready -q -U b30 -d b30restore 2>/dev/null && break; sleep 1; [ "$i" = 60 ] && fail "throwaway postgres not ready"; done

log "step 3 — restore (streamed, single transaction)"
role="$(zcat "$DUMP" | grep -m1 -oE 'OWNER TO [^;]+' | awk '{print $3}' | tr -d '"' || true)"
if [ -n "$role" ] && [ "$role" != "b30" ]; then
  [[ "$role" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "unexpected owner role shape in the dump"
  docker exec "$PG" psql -X -q -U b30 -d b30restore -c "create role \"$role\" login" >/dev/null
fi
if zcat "$DUMP" | docker exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U b30 -d b30restore -f - >"$TMP/restore.log" 2>&1; then
  log "restore: psql exit 0"; restore_ok=1
else
  log "restore: psql FAILED (first line, sanitized): $(head -1 "$TMP/restore.log" | sed -E 's/[A-Za-z0-9+/=_-]{32,}/<redacted>/g' | cut -c1-160)"; restore_ok=0; note_fail restore
fi

log "step 4 — database checks"
pgx() { docker exec "$PG" psql -X -tA -U b30 -d b30restore -c "$1"; }
tables="$(pgx "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]' || true)"
fp="$(pgx "$FP_SQL" 2>/dev/null | tr -d '[:space:]' || true)"
inv="$(pgx "$INV_SQL" 2>/dev/null | tr -d '\r' | head -1 || true)"
log "tables=$tables fingerprint_match=$([ "$fp" = "$m_fp" ] && echo true || echo false) counts_match=$([ "$inv" = "$m_inv_line" ] && echo true || echo false)"
[ "$fp" = "$m_fp" ] || note_fail fingerprint
[ "$inv" = "$m_inv_line" ] || note_fail inventory_counts
[ "${tables:-0}" -gt 0 ] || note_fail tables

log "step 5 — archive extraction into the throwaway volume + ownership checks"
docker run --rm --network none --user 0:0 -e NAME="$(basename "$ARCHIVE")" -v "$OBJVOL:/dst" -v "$SET:/in:ro" --entrypoint sh "$B30_IMAGE" -c 'set -e; tar --numeric-owner -C /dst -xpf "/in/$NAME" && chown 999:999 /dst && chmod 700 /dst' || note_fail extraction
own="$(docker run --rm --network none --user 0:0 -v "$OBJVOL:/dst:ro" --entrypoint sh "$B30_IMAGE" -c 'echo "regular=$(find /dst -type f | wc -l) not_999=$(find /dst -mindepth 1 \( ! -uid 999 -o ! -gid 999 \) | wc -l) files_not_600=$(find /dst -type f ! -perm 600 | wc -l) dirs_not_700=$(find /dst -mindepth 1 -type d ! -perm 700 | wc -l) symlinks=$(find /dst -type l | wc -l)"' 2>/dev/null | tr -d '\r' || true)"
log "archive: $own"
[ "$(printf '%s' "$own" | grep -oE 'regular=[0-9]+' | cut -d= -f2)" = "$m_regular" ] || note_fail archive_regular_files
printf '%s' "$own" | grep -qE 'not_999=0 files_not_600=0 dirs_not_700=0 symlinks=0' || note_fail archive_ownership_modes

log "step 6 — decrypt / read-back of every active fs object (b30-readback.ts, read-only)"
DBURL="postgres://b30:${PGPW}@${PG}:5432/b30restore"
rb="$(docker run --rm --user 999:999 --network "$NET" --env-file "$KEYENV" -e HOME=/tmp -e DATABASE_URL="$DBURL" -e OBJECT_STORAGE_DRIVER=fs -e OBJECT_STORAGE_FS_ROOT=/restore/objects -e B30_EXPECT_ROWS="$m_inv_active_fs" -e B30_EXPECT_KEY_ID="$m_key_id" -e B30_EXPECT_UID=999 -e B30_EXPECT_GID=999 -v "$OBJVOL:/restore/objects:ro" -v "$HELPER:/repo/artifacts/api-server/scripts/b30-readback.ts:ro" --entrypoint sh "$B30_IMAGE" -c 'cd /repo/artifacts/api-server && exec ./node_modules/.bin/tsx scripts/b30-readback.ts' 2>&1 | grep -E '^B30_READBACK' | tail -1 || true)"
log "${rb:-B30_READBACK (no output)}"
printf '%s' "$rb" | grep -q 'result=PASS' || note_fail readback

log "step 7 — the product's migrate-storage --verify, offline (no bucket variable)"
SS="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
vf="$(docker run --rm --user 999:999 --network "$NET" --env-file "$KEYENV" -e HOME=/tmp -e NODE_ENV=development -e SESSION_SECRET="$SS" -e DATABASE_URL="$DBURL" -e OBJECT_STORAGE_DRIVER=fs -e OBJECT_STORAGE_FS_ROOT=/restore/objects -e VERIFY_JS="$VERIFY_JS" -v "$OBJVOL:/restore/objects:ro" --entrypoint sh "$B30_IMAGE" -c 'cd /repo/artifacts/api-server && ./node_modules/.bin/tsx ./scripts/migrate-storage.ts --verify --out /tmp/b30-verify.json >/tmp/b30-verify.log 2>&1; rc=$?; node -e "$VERIFY_JS"; echo "vf_exit=$rc"' 2>/dev/null | tr '\n' ' ' || true)"
log "verify: $vf"
g() { printf '%s' "$vf" | grep -oE "$1=[^ ]+" | head -1 | cut -d= -f2; }
if [ "$(g vf_parse_ok)" = "true" ] && [ "$(g vf_read_only)" = "true" ] && [ "$(g vf_target_root)" = "present" ] && [ "$(g vf_not_migrated)" = "0" ] && [ "$(g vf_checksum_mismatch)" = "0" ] && [ "$(g vf_failed)" = "0" ] && [ "$(g vf_duplicate)" = "0" ] && [ "$(g vf_verified)" = "$m_inv_migrated" ] && [ "$(g vf_unregistered)" = "$m_unreg" ]; then
  if [ "$m_unreg" = "0" ]; then [ "$(g vf_complete)" = "true" ] && [ "$(g vf_exit)" = "0" ] && log "verify classification: COMPLETE" || note_fail verify_complete
  else [ "$(g vf_complete)" = "false" ] && [ "$(g vf_exit)" = "2" ] && log "verify classification: EXPECTED_INCOMPLETE (unregistered=$m_unreg before the copy — not a restore failure)" || note_fail verify_expected_incomplete; fi
else
  note_fail verify_counts
fi

[ "${#FAILS[@]}" = 0 ] && VERDICT="VERIFIED"
log "evidence: set=$(basename "$SET") tables=$tables fingerprint_match=$([ "$fp" = "$m_fp" ] && echo true || echo false) counts_match=$([ "$inv" = "$m_inv_line" ] && echo true || echo false) archive[$own] readback[${rb#B30_READBACK }] verify[$vf]"
[ "$VERDICT" = "VERIFIED" ] && exit 0 || exit 2
