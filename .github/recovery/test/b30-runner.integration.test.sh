#!/bin/bash
# =============================================================================
# B30 RECOVERY RUNNER — LOCAL DOCKER + POSTGRESQL INTEGRATION TEST (opt-in; a THROWAWAY Docker daemon ONLY).
# Runs the REAL host bootstrap, the REAL toolkit backup script and the repository's REAL dump script
# (docker/scripts/backup-postgres.sh at the product commit) with the REAL Docker client, the REAL `docker compose exec`
# and REAL PostgreSQL in the stack's own image, brought up from the product commit's own compose files. It shows what
# the stub suite (b30-runner.test.sh) cannot: what the real client does with standard input, what psql really prints,
# real named-volume mounts and the real ownership of files a container writes.
#
# NEVER RUN THIS ON A MACHINE THAT HOSTS THE STACK. The compose project and the object volume carry the stack's real
# names (the toolkit has them as constants). The test refuses unless ALL of the following hold, and removes only what it
# created, in that daemon:
#   1. B30_IT_CONFIRM=THROWAWAY_DAEMON_ONLY
#   2. DOCKER_HOST names a unix socket that is NOT a system default socket
#   3. that daemon declares itself a throwaway: it was started with  dockerd --label b30.it.throwaway=true
#      (the socket path alone cannot identify a daemon; the label is the positive mark)
#   4. that daemon has no container, no volume, no user-defined network and no cardscanner/* image
#   5. the stack's default directory does not exist on this machine
#   6. a temporary directory could be created (every path the test writes derives from it)
# These are checks against a mistake, not a security boundary.
# Optional: B30_IT_SCHEMA_SQL=<schema-only SQL of the product schema> (then the fingerprint must MATCH and the set must be
#           VERIFIED; without it a one-table schema is used, the fingerprint is well-formed but MISMATCH, and the expected
#           result is SET_NOT_VERIFIED with every other check passing);
#           B30_IT_NODE_IMAGE (default node:24-bookworm-slim — the base of the stack's migrate image);
#           B30_IT_RUN_AS=<existing unprivileged user with access to the daemon socket> when the test is started by root:
#           the host sessions then run as that user, as on a real host (default: the current user).
#           With sshd, ssh and ssh-keygen installed, root and B30_IT_RUN_AS (an account sshd accepts, i.e. not locked),
#           section I10 also runs the workflow's OWN SSH-setup and host-session steps over a real SSH session to a local
#           sshd on 127.0.0.1 (throwaway keys, a private configuration, stopped at exit); otherwise I10 is skipped.
# NOT verified here: the host's own sshd and network, the GitHub runner, the real API image (a labelled stand-in
# container is the "api" service), the real migrate image (a stand-in built from its base image carries its tag and
# label), live application traffic during a set run, hosted dispatch.
# Usage: dockerd --host unix:///path/to/throwaway.sock --data-root <empty dir> --label b30.it.throwaway=true …   (once)
#        B30_IT_CONFIRM=THROWAWAY_DAEMON_ONLY DOCKER_HOST=unix:///path/to/throwaway.sock bash .github/recovery/test/b30-runner.integration.test.sh
# =============================================================================
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; REC="$ROOT/.github/recovery"; KIT="$REC/toolkit"
PRODUCT_SHA="6a8dad1fe161dc1b31041794e5e3532e9f13327c"
PROJECT="card-scanner-pro"; VOLNAME="${PROJECT}_objectdata"; MIG_TAG="cardscanner/migrate:b25-stage2b-${PRODUCT_SHA:0:12}"
NODE_IMG="${B30_IT_NODE_IMAGE:-node:24-bookworm-slim}"
refuse() { echo "REFUSED - $*"; exit 3; }

# ---- guards (before anything is created) ----------------------------------------------------------------------------
[ "${B30_IT_CONFIRM:-}" = "THROWAWAY_DAEMON_ONLY" ] || refuse "set B30_IT_CONFIRM=THROWAWAY_DAEMON_ONLY (this test must only ever see a throwaway Docker daemon)"
case "${DOCKER_HOST:-}" in unix:///?*) ;; *) refuse "DOCKER_HOST must name the unix socket of a throwaway daemon";; esac
SOCK="${DOCKER_HOST#unix://}"; SOCKREAL="$(readlink -f "$SOCK" 2>/dev/null || true)"
for d in /var/run/docker.sock /run/docker.sock; do
  [ "$SOCK" != "$d" ] && [ "$SOCKREAL" != "$(readlink -f "$d" 2>/dev/null || echo "$d")" ] || refuse "DOCKER_HOST is the system Docker socket"
done
[ ! -e /opt/lead-capture-pro ] || refuse "this machine carries the stack's default directory"
command -v docker >/dev/null 2>&1 || refuse "docker client not found"
docker info >/dev/null 2>&1 || refuse "the daemon behind DOCKER_HOST does not answer"
docker compose version >/dev/null 2>&1 || refuse "docker compose not available"
DAEMON_LABELS="$(docker info --format '{{range .Labels}}{{println .}}{{end}}' 2>/dev/null)"   # read completely first: no pipe for the client to lose
grep -qx 'b30.it.throwaway=true' <<<"$DAEMON_LABELS" || refuse "the daemon does not carry the label b30.it.throwaway=true (start the throwaway daemon with: dockerd --label b30.it.throwaway=true)"
[ "$(docker ps -aq | wc -l | tr -d ' ')" = 0 ] || refuse "the daemon already has containers — not a throwaway daemon"
[ "$(docker volume ls -q | wc -l | tr -d ' ')" = 0 ] || refuse "the daemon already has volumes — not a throwaway daemon"
[ "$(docker network ls -q --filter type=custom | wc -l | tr -d ' ')" = 0 ] || refuse "the daemon already has user-defined networks — not a throwaway daemon"
[ "$(docker images -q 'cardscanner/*' | wc -l | tr -d ' ')" = 0 ] || refuse "the daemon already holds cardscanner/* images — not a throwaway daemon"
docker image inspect postgres:16-alpine >/dev/null 2>&1 || docker pull -q postgres:16-alpine >/dev/null 2>&1 || refuse "image postgres:16-alpine not available"
docker image inspect "$NODE_IMG" >/dev/null 2>&1 || docker pull -q "$NODE_IMG" >/dev/null 2>&1 || refuse "image $NODE_IMG not available (set B30_IT_NODE_IMAGE)"
RUN_AS="${B30_IT_RUN_AS:-}"
if [ -n "$RUN_AS" ]; then
  [ "$(id -u)" = 0 ] || refuse "B30_IT_RUN_AS needs the test to be started by root"
  id "$RUN_AS" >/dev/null 2>&1 && [ "$(id -u "$RUN_AS")" != 0 ] || refuse "B30_IT_RUN_AS must be an existing unprivileged user"
  command -v setpriv >/dev/null 2>&1 || refuse "setpriv not found (needed for B30_IT_RUN_AS)"
fi
SCHEMA_SQL="${B30_IT_SCHEMA_SQL:-}"; [ -z "$SCHEMA_SQL" ] || [ -r "$SCHEMA_SQL" ] || refuse "B30_IT_SCHEMA_SQL is not readable"

T="$(mktemp -d)" && [ -n "$T" ] && [ -d "$T" ] || refuse "no temporary directory (is TMPDIR usable?); nothing was done"   # every path below derives from T
chmod 711 "$T"
pass=0; fail=0
t()  { local n="$1"; shift; if "$@" >/dev/null 2>&1; then pass=$((pass+1)); echo "ok   - $n"; else fail=$((fail+1)); echo "FAIL - $n"; fi; }
tv() { local n="$1" want="$2" got="$3"; if [ "$want" = "$got" ]; then pass=$((pass+1)); echo "ok   - $n ($got)"; else fail=$((fail+1)); echo "FAIL - $n (want '$want' got '$got')"; fi; }
APP="$T/app"; BK="$T/backups"; ST="$T/state"; HM="$T/home"; HT="$T/hosttmp"; SHIM="$T/shim"
REALDOCKER="$(command -v docker)"
compose() { ( cd "$APP/docker" && docker compose -f docker-compose.yml -f compose.vps.yml "$@" ); }
CREATED=0; SSHD_PIDFILE=""; MADE_RUN_SSHD=0
cleanup() {
  [ -n "$SSHD_PIDFILE" ] && [ -s "$SSHD_PIDFILE" ] && kill "$(cat "$SSHD_PIDFILE")" 2>/dev/null
  [ "$MADE_RUN_SSHD" = 1 ] && rmdir /run/sshd 2>/dev/null
  if [ "$CREATED" = 1 ]; then
    docker rm -f -v "${PROJECT}-api-1" >/dev/null 2>&1
    [ -d "$APP/docker" ] && compose down -v --remove-orphans >/dev/null 2>&1
    docker volume rm "$VOLNAME" >/dev/null 2>&1
    docker image rm "$MIG_TAG" >/dev/null 2>&1
  fi
  rm -rf "$T"
}
trap cleanup EXIT
umask 077
# shellcheck source=/dev/null
. "$REC/b30-runner-lib.sh"
export -f b30_filter_summary b30_refuse

echo "== I0. environment (throwaway daemon: $(docker info --format '{{.ServerVersion}}'), $(docker compose version --short 2>/dev/null | head -1))"
CREATED=1
# a self-contained checkout of exactly the product commit (no history, no link to this repository), as the app directory
{ git init -q "$APP" && git -C "$APP" -c uploadpack.allowAnySHA1InWant=true fetch -q --depth 1 "file://$ROOT" "$PRODUCT_SHA" && git -C "$APP" checkout -q --detach FETCH_HEAD; } >/dev/null 2>&1 || { echo "FAIL - cannot create the product checkout"; exit 1; }
PGPW="it$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"; MARK="tenantmarker$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# the stack's own (git-ignored) env file, as on a host; local throwaway values only
{ echo "COMPOSE_PROFILES=local-db"; echo "POSTGRES_USER=lcp_it"; echo "POSTGRES_PASSWORD=$PGPW"; echo "POSTGRES_DB=lcp_it"
  echo "DATABASE_URL=postgres://lcp_it:$PGPW@postgres:5432/lcp_it"; echo "SESSION_SECRET=$PGPW"; echo "GCS_CREDENTIAL_GID=$(id -g)"; } > "$APP/docker/.env"
tv "product checkout = product commit, clean (env file is git-ignored)" "$PRODUCT_SHA 0" "$(git -C "$APP" rev-parse HEAD) $(git -C "$APP" status --porcelain | wc -l | tr -d ' ')"
t "production backup script in the checkout is the product commit's" bash -c "cd '$ROOT' && [ \"\$(git rev-parse $PRODUCT_SHA:docker/scripts/backup-postgres.sh)\" = \"\$(git -C '$APP' rev-parse HEAD:docker/scripts/backup-postgres.sh)\" ]"
mkdir -p "$BK" "$ST" "$HM" "$HT" "$SHIM"; chmod 700 "$BK" "$ST" "$HM" "$HT"; chmod 755 "$SHIM"; echo "$PRODUCT_SHA" > "$ST/current-deploy.sha"
compose up -d postgres >/dev/null 2>&1 || { echo "FAIL - compose up postgres"; exit 1; }
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-postgres-1" 2>/dev/null)" = healthy ] && break; sleep 1; done
tv "postgres service running from the product commit's compose files" "${PROJECT}-postgres-1" "$(compose ps --status running postgres --format '{{.Name}}')"
psqlq() { compose exec -T postgres sh -c 'exec psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1" </dev/null; }
if [ -n "$SCHEMA_SQL" ]; then
  compose exec -T postgres sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$SCHEMA_SQL" >/dev/null 2>&1 || { echo "FAIL - schema load"; exit 1; }
  EXPECT_FP=MATCH; EXPECT_RESULT=SET_VERIFIED; EXPECT_MARKER=VERIFIED; EXPECT_RC=0
  ROWSQL="set session_replication_role = replica; insert into storage_objects (id, company_id, kind, reference, storage_key, driver, content_type, state) select gen_random_uuid(), 1, 'document', '$MARK-'||g, 'documents/1/'||g||'.bin', 'fs', 'application/octet-stream', 'active' from generate_series(1,3) g; insert into storage_objects (id, company_id, kind, reference, storage_key, driver, content_type, state, deleted_at) values (gen_random_uuid(), 1, 'document', '$MARK-del', 'documents/1/del.bin', 'fs', 'application/octet-stream', 'deleted', now())"
else
  # one table for the inventory query + incompressible filler, so that the dump clears the dump script's 1024-byte floor
  psqlq "create table storage_objects (id uuid primary key default gen_random_uuid(), reference text not null, state text not null, driver text not null, legacy_key text); create table b30_it_filler as select md5(random()::text)||md5(random()::text) as x from generate_series(1,300)" >/dev/null || { echo "FAIL - minimal schema"; exit 1; }
  EXPECT_FP=MISMATCH; EXPECT_RESULT=SET_NOT_VERIFIED; EXPECT_MARKER=NOT_VERIFIED; EXPECT_RC=2
  ROWSQL="insert into storage_objects (reference, state, driver) select '$MARK-'||g, 'active', 'fs' from generate_series(1,3) g; insert into storage_objects (reference, state, driver) values ('$MARK-del', 'deleted', 'fs')"
fi
psqlq "$ROWSQL" >/dev/null || { echo "FAIL - fixture rows"; exit 1; }
tv "fixture rows: 3 active fs + 1 deleted" "4 3" "$(psqlq "select count(*)||' '||count(*) filter (where state='active' and driver='fs') from storage_objects")"
echo "note - schema: $([ -n "$SCHEMA_SQL" ] && echo 'product schema supplied (fingerprint must MATCH)' || echo 'one-table schema (fingerprint MISMATCH expected; result SET_NOT_VERIFIED expected)')"
# "api" service: a stand-in container that compose recognises through the compose labels (no host path is mounted)
L=(); while IFS= read -r kv; do k="${kv%%=*}"; v="${kv#*=}"; case "$k" in com.docker.compose.service) v=api;; com.docker.compose.depends_on) v="";; esac; L+=(--label "$k=$v"); done < <(docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "${PROJECT}-postgres-1" | grep '^com\.docker\.compose')
docker run -d --name "${PROJECT}-api-1" --network none "${L[@]}" "$NODE_IMG" sleep 86400 >/dev/null
tv "api service seen as running by compose (stand-in)" "${PROJECT}-api-1" "$(compose ps --status running api --format '{{.Name}}')"
# migrate image stand-in: the migrate image's base (node + GNU tar) with its tag and its label
cid="$(docker create "$NODE_IMG" true)" && docker commit -c "LABEL b25.stage2b.commit=$PRODUCT_SHA" "$cid" "$MIG_TAG" >/dev/null && docker rm "$cid" >/dev/null
tv "migrate image stand-in labelled with the product commit" "$PRODUCT_SHA" "$(docker image inspect -f '{{index .Config.Labels "b25.stage2b.commit"}}' "$MIG_TAG")"
# object volume: 3 tenant files with envelope headers (one key id) + 1 health file, owned 999:999, dirs 700, files 600
docker volume create "$VOLNAME" >/dev/null
read -r -d '' FIXJS <<'JS' || true
const fs=require("fs"),p=require("path"),c=require("crypto");const root="/dst";const kid=c.randomBytes(8).toString("hex");
function mk(d){fs.mkdirSync(d,{recursive:true,mode:0o700});}
for(let i=1;i<=3;i++){const key=`documents/1/${i}.bin`;const hdr=Buffer.from(JSON.stringify({v:1,k:kid,n:c.randomBytes(12).toString("hex"),c:"application/octet-stream",o:key}));
const f=p.join(root,key);mk(p.dirname(f));const l=Buffer.alloc(2);l.writeUInt16BE(hdr.length);fs.writeFileSync(f,Buffer.concat([Buffer.from("LCPO"),Buffer.from([1]),l,hdr,c.randomBytes(4096)]),{mode:0o600});}
mk(p.join(root,"health"));fs.writeFileSync(p.join(root,"health",c.randomUUID()),"ok",{mode:0o600});console.log("kid="+kid);
JS
KID="$(docker run --rm --network none --user 0:0 -v "$VOLNAME:/dst" --entrypoint sh "$MIG_TAG" -c 'node -e "$1" && chown -R 999:999 /dst && chmod 700 /dst && find /dst -type d -exec chmod 700 {} +' sh "$FIXJS" | sed -n 's/^kid=//p')"
t "fixture volume populated (one envelope key id)" bash -c "[[ '$KID' =~ ^[0-9a-f]{16}\$ ]]"
voldigest() { docker run --rm --network none --user 0:0 -v "$VOLNAME:/src:ro" --entrypoint sh "$MIG_TAG" -c 'cd /src && { find . -type f -print0 | sort -z | xargs -0 sha256sum; find . -printf "%p %m %u %g %y\n" | sort; } | sha256sum | cut -c1-32' </dev/null; }
dbdigest() { psqlq "select md5(string_agg(id::text||state||driver||reference, '|' order by id::text))||' '||count(*) from storage_objects"; }
VOL0="$(voldigest)"; DB0="$(dbdigest)"
if [ -n "$RUN_AS" ]; then chown -R "$RUN_AS" "$APP" "$BK" "$ST" "$HM" "$HT"; fi
HOSTUSER="${RUN_AS:-$(id -un)}"; HOSTUID="$(id -u "$HOSTUSER")"
echo "note - host sessions run as: $([ "$HOSTUID" = 0 ] && echo 'root (unprivileged operator NOT modelled; set B30_IT_RUN_AS)' || echo 'an unprivileged user, as on a host')"

SUMS_SHA="$(sha256sum "$KIT/SHA256SUMS" | cut -c1-64)"
tar -cf "$T/payload.tar" --owner=0 --group=0 --numeric-owner -C "$KIT" . && PAYLOAD="$(base64 -w0 "$T/payload.tar")"
# run_host <mode> <start> <end> <transport: pipe|file> [NAME=value ...] → OUT (filtered summary), RAWOUT, RC, FRC
# The stream is the workflow's: %q assignments, then the bootstrap; `bash -s` reads it from standard input.
# transport pipe = standard input is a pipe (what sshd gives a remote command); file = a regular file.
run_host() {
  local mode="$1" qs="$2" qe="$3" tr="$4"; shift 4
  { printf 'MODE=%q\n' "$mode"; printf 'B30_PRODUCT_SHA=%q\n' "$PRODUCT_SHA"; printf 'B30_SUMS_SHA256=%q\n' "$SUMS_SHA"; printf 'QUIET_START=%q\n' "$qs"; printf 'QUIET_END=%q\n' "$qe"; printf 'DEPLOY_PATH=%q\n' "$APP"; printf 'B30_PAYLOAD_B64=%q\n' "$PAYLOAD"; cat "$REC/b30-host-bootstrap.sh"; } > "$T/stream.sh"; chmod 644 "$T/stream.sh"
  local -a pre=(); [ -n "$RUN_AS" ] && pre=(setpriv --reuid "$RUN_AS" --regid "$(id -g "$RUN_AS")" --init-groups)
  local -a envv=(env -i "PATH=$PATH" "HOME=$HM" "BACKUP_DIR=$BK" "STATE_DIR=$ST" "TMPDIR=$HT" "DOCKER_HOST=$DOCKER_HOST" "$@")
  if [ "$tr" = pipe ]; then cat "$T/stream.sh" | "${pre[@]}" "${envv[@]}" bash -s > "$T/host.out" 2>"$T/host.err"; RC="${PIPESTATUS[1]}"
  else "${pre[@]}" "${envv[@]}" bash -s < "$T/stream.sh" > "$T/host.out" 2>"$T/host.err"; RC=$?; fi
  RAWOUT="$(cat "$T/host.out")"; OUT="$(b30_filter_summary < "$T/host.out")"; FRC=$?
}
val() { printf '%s\n' "$OUT" | grep -E "^$1=" | head -1 | cut -d= -f2-; }
show() { printf '%s\n' "$RAWOUT" | sed -E 's/^/     | /; s/b30-[0-9]{8}-[0-9]{6}/b30-<stamp>/'; }
LOGS="$BK/recovery-sets/runner-logs"
# what the newest host-side log of a mode recorded, as fixed tokens only (step markers, error text, final marker)
showlog() { local f; f="$(ls -t "$LOGS"/b30-"$1"-*.log 2>/dev/null | head -1)"; [ -n "$f" ] || return 0
  grep -oE 'step [1-6] |ERROR: [a-z0-9 ._-]+|INCOMPLETE SET left for review|RECOVERY SET (NOT )?VERIFIED|preconditions OK' "$f" | sed -E 's/^/     log> /'; }
sets() { ls -d "$BK"/recovery-sets/b30-2* 2>/dev/null | wc -l | tr -d ' '; }
incdir() { local s; s="$(ls -d "$BK"/recovery-sets/b30-*/.start 2>/dev/null | head -1)"; [ -n "$s" ] && dirname "$s"; }   # the pending incomplete set, if any
incfiles() { local d; d="$(incdir)"; [ -n "$d" ] && ls -A "$d" | sed -E 's/leadcapture-[0-9-]+/leadcapture/' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'; }
incstate() { local d; d="$(incdir)"; [ -n "$d" ] && ( cd "$d" && ls -Al --time-style=+%s | sha256sum | cut -c1-16 ); }
# the test's stand-in for an owner-reviewed resolution: the incomplete set is moved out of the b30-* names, not deleted
resolveinc() { local d; d="$(incdir)"; [ -n "$d" ] && mv "$d" "$BK/recovery-sets/reviewed-$(basename "$d")"; return 0; }
dumps() { ls "$BK"/leadcapture-*.sql.gz 2>/dev/null | wc -l | tr -d ' '; }
hosttmp() { find "$HT" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' '; }
WS="$(date -u -d '-30 min' +%Y-%m-%dT%H:%MZ)"; WE="$(date -u -d '+60 min' +%Y-%m-%dT%H:%MZ)"

echo "== I1. check mode (real client, pipe transport)"
run_host b30_recovery_check "" "" pipe; show
tv "I1 exit 0, every line allow-listed" "0 0" "$RC $FRC"; tv "I1 result" CHECK_OK "$(val B30_RUNNER_RESULT)"
tv "I1 summary = the check-mode lines, in order" "B30_MODE B30_PRODUCT_COMMIT B30_TOOLKIT B30_TOOLKIT_FILES B30_CHECK_EXIT B30_PRECONDITIONS B30_EXISTING_DUMPS B30_KEEP B30_EXPECTED_UNREGISTERED B30_SET_PHASE B30_RAW_LOG B30_RUNNER_RESULT" "$(printf '%s\n' "$RAWOUT" | cut -d= -f1 | tr '\n' ' ' | sed 's/ $//')"
tv "I1 nothing created besides the runner log; no set, no dump; host temp dir removed; host stderr empty" "0 0 0 0" "$(sets) $(dumps) $(hosttmp) $(wc -c < "$T/host.err" | tr -d ' ')"
tv "I1 volume and database unchanged" "$VOL0 $DB0" "$(voldigest) $(dbdigest)"

echo "== I2. set mode (real client, pipe transport — standard input is a pipe, as under sshd)"
run_host b30_recovery_set "$WS" "$WE" pipe; show; showlog b30_recovery_set
tv "I2 the bootstrap reached its result logic (result line present, set exit reported)" "1 1" "$(grep -c '^B30_RUNNER_RESULT=' "$T/host.out") $(grep -c '^B30_SET_EXIT=' "$T/host.out")"
tv "I2 result / marker / exit" "$EXPECT_RESULT $EXPECT_MARKER $EXPECT_RC" "$(val B30_RUNNER_RESULT) $(val B30_SET_MARKER) $RC"
tv "I2 every line allow-listed; host stderr empty; host temp dir removed" "0 0 0" "$FRC $(wc -c < "$T/host.err" | tr -d ' ') $(hosttmp)"
tv "I2 fingerprint" "$EXPECT_FP" "$(val B30_FINGERPRINT)"
tv "I2 checks: sums, tenant files, headers, symlinks, archive files, key id" "OK MATCH valid none MATCH single" "$(val B30_SHA256SUMS) $(val B30_TENANT_FILES) $(val B30_HEADERS) $(val B30_SYMLINKS) $(val B30_ARCHIVE_FILES) $(val B30_KEY_ID)"
tv "I2 inventory read from the real database (total active active_fs migrated gcs deleted other)" "4 3 3 0 0 1 0" "$(val B30_INV_TOTAL) $(val B30_INV_ACTIVE) $(val B30_INV_ACTIVE_FS) $(val B30_INV_ACTIVE_FS_MIGRATED) $(val B30_INV_ACTIVE_GCS) $(val B30_INV_DELETED) $(val B30_INV_OTHER_STATES)"
tv "I2 archive regular = tenant + health" "4 3 1 0" "$(val B30_ARCHIVE_REGULAR) $(val B30_VOLUME_TENANT_FILES) $(val B30_VOLUME_HEALTH_FILES) $(val B30_VOLUME_SYMLINKS)"
SET1="$(ls -d "$BK"/recovery-sets/b30-2* 2>/dev/null | head -1)"; MAN1="$(ls "$SET1"/recovery-*.txt 2>/dev/null | head -1)"
tv "I2 one complete set: no .start, 8 files" "1 0 8" "$(sets) $(ls -A "$SET1" | grep -c '^\.start$') $(ls -A "$SET1" | wc -l | tr -d ' ')"
t "I2 SHA256SUMS of the set verifies" bash -c "cd '$SET1' && sha256sum -c --quiet --strict SHA256SUMS"
t "I2 manifest: schema fingerprint is exactly 32 hexadecimal characters" bash -c "[ \"\$(grep -cE '^schema_fingerprint=[0-9a-f]{32}\$' '$MAN1')\" = 1 ]"
[ -n "$SCHEMA_SQL" ] && t "I2 manifest: fingerprint equals the expected one" bash -c "[ \"\$(grep -E '^schema_fingerprint=' '$MAN1' | cut -d= -f2)\" = \"\$(grep -E '^schema_fingerprint_expected=' '$MAN1' | cut -d= -f2)\" ]"
tv "I2 manifest: inventory lines exact, one each" "inventory_total=4 inventory_active=3 inventory_active_fs=3 inventory_active_fs_migrated=0 inventory_active_gcs=0 inventory_deleted=1 inventory_other_states=0" "$(grep -E '^inventory_' "$MAN1" | tr '\n' ' ' | sed 's/ $//')"
RAW1="$(ls "$LOGS"/b30-b30_recovery_set-*.log | head -1)"
tv "I2 no psql command tag anywhere in the manifest" "0" "$(grep -c 'SET' "$MAN1")"
t "I2 manifest: every line is name=value; key id recorded once" bash -c "! grep -qvE '^[a-z_0-9]+=.+' '$MAN1' && [ \"\$(grep -c '^envelope_key_id=$KID\$' '$MAN1')\" = 1 ]"
DUMP1="$(ls "$SET1"/leadcapture-*.sql.gz | head -1)"
t "I2 the dump is a complete pg_dump of the fixture database (header, table, fixture rows, completion marker)" bash -c "zcat '$DUMP1' | head -3 | grep -q '^-- PostgreSQL database dump\$' && zcat '$DUMP1' | grep -q 'storage_objects' && [ \"\$(zcat '$DUMP1' | grep -c '$MARK')\" = 4 ] && zcat '$DUMP1' | tail -c 4096 | grep -q '^-- PostgreSQL database dump complete\$'"
tv "I2 one published dump, hard-linked into the set (2 links), KEEP=1000 pruned nothing" "1 2" "$(dumps) $(stat -c %h "$DUMP1")"
ARCH1="$(ls "$SET1"/objectdata-*.tar | head -1)"
tv "I2 archive: owned by the host session user, mode 600, 4 regular files, numeric owner 999 inside" "$HOSTUID 600 4 1" "$(stat -c '%u %a' "$ARCH1") $(tar -tvf "$ARCH1" | grep -c '^-') $(tar --numeric-owner -tvf "$ARCH1" | grep '^-' | awk '{print $2}' | sort -u | grep -c '^999/999$')"
tv "I2 set files all mode 600, directory 700" "0 700" "$(find "$SET1" -type f ! -perm 600 | wc -l | tr -d ' ') $(stat -c %a "$SET1")"
tv "I2 raw log kept on the host, mode 600; key id in the log, never in the summary" "600 1 0" "$(stat -c %a "$RAW1") $(grep -c "envelope_key_id=$KID" "$RAW1" | sed 's/^[2-9]$/1/') $(grep -c "$KID" "$T/host.out")"
tv "I2 nothing of the database password, the fixture marker or a path in the summary" "0 0 0" "$(grep -c "$PGPW" "$T/host.out") $(grep -c "$MARK" "$T/host.out") $(grep -c '/' "$T/host.out")"
t "I2 no 16+ hex run in the summary except the product commit" bash -c "! grep -v '^B30_PRODUCT_COMMIT=' '$T/host.out' | grep -qE '[0-9a-fA-F]{16,}'"
tv "I2 volume and database unchanged by the set run" "$VOL0 $DB0" "$(voldigest) $(dbdigest)"
tv "I2 the live volume was never left with a container attached" "0" "$(docker ps -aq --filter "volume=$VOLNAME" | wc -l | tr -d ' ')"

echo "== I3. second execution in the same window (no retry, no second set, no second dump)"
run_host b30_recovery_set "$WS" "$WE" pipe; show
tv "I3 refused / exit 1 / existing sets in the window" "REFUSED_window_already_used 1 1" "$(val B30_RUNNER_RESULT) $RC $(val B30_WINDOW_SETS_EXISTING)"
tv "I3 still one set, still one dump, host temp dir removed" "1 1 0" "$(sets) $(dumps) $(hosttmp)"

echo "== I4. set mode again, other window, regular-file transport, every docker client call recorded"
# recording shim: logs the argument list and what standard input of the client call points at, then runs the real client
cat > "$SHIM/docker" <<EOS
#!/bin/bash
printf '%s\t%s\n' "\$(readlink /proc/\$\$/fd/0 2>/dev/null)" "\${*//\$'\n'/ }" >> "$T/shim.log"
exec "$REALDOCKER" "\$@"
EOS
chmod 755 "$SHIM/docker"; : > "$T/shim.log"; chmod 666 "$T/shim.log"
run_host b30_recovery_set 2026-11-02T14:00Z 2026-11-02T15:00Z file "PATH=$SHIM:$PATH"; show
tv "I4 result / exit" "$EXPECT_RESULT $EXPECT_RC" "$(val B30_RUNNER_RESULT) $RC"
tv "I4 two sets, two dumps, host temp dir removed" "2 2 0" "$(sets) $(dumps) $(hosttmp)"
tv "I4 every docker client call of the session had standard input detached (/dev/null)" "0" "$(grep -vc "^/dev/null	" "$T/shim.log")"
tv "I4 client calls that keep standard input attached: 1 dump + 2 queries, exactly" "1 2" "$(grep -c 'exec -T postgres sh -c exec pg_dump' "$T/shim.log") $(grep -c 'exec -T postgres sh -c exec psql' "$T/shim.log")"
tv "I4 queries ran quiet, read-only, with ON_ERROR_STOP" "2 2 2" "$(grep 'exec psql' "$T/shim.log" | grep -c -- ' -q ') $(grep 'exec psql' "$T/shim.log" | grep -c 'set default_transaction_read_only = on') $(grep 'exec psql' "$T/shim.log" | grep -c -- '-v ON_ERROR_STOP=1')"
tv "I4 the live volume was mounted read-only in every call that mounted it" "0" "$(grep -- "-v $VOLNAME:" "$T/shim.log" | grep -vc -- "-v $VOLNAME:/src:ro")"
subcmd() { cut -f2 "$T/shim.log" | sed -E 's/^compose( -f [^ ]+)* //' | awk "{print \$1 ${1:-}}" | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//'; }
tv "I4 the session used only these client commands: compose ps / compose exec -T, image inspect, ps, run, volume inspect" "exec image ps run volume | exec:-T image:inspect volume:inspect" "$(subcmd) | $(subcmd '":"$2' | tr ' ' '\n' | grep -E '^(exec|image|volume):' | tr '\n' ' ' | sed 's/ $//')"
tv "I4 every one-off container: removed on exit and without network" "0 0" "$(cut -f2 "$T/shim.log" | grep '^run ' | grep -vc -- '--rm ') $(cut -f2 "$T/shim.log" | grep '^run ' | grep -vc -- '--network none ')"
tv "I4 volume and database unchanged" "$VOL0 $DB0" "$(voldigest) $(dbdigest)"

echo "== I5. injected failure after the dump (archive step fails) → incomplete set preserved, failure reported"
cat > "$SHIM/docker" <<EOS
#!/bin/bash
case "\$*" in *"tar --numeric-owner -C /src -cf"*) echo "injected archive failure" >&2; exit 125;; esac
exec "$REALDOCKER" "\$@"
EOS
run_host b30_recovery_set 2026-11-03T14:00Z 2026-11-03T15:00Z pipe "PATH=$SHIM:$PATH"; show; showlog b30_recovery_set
tv "I5 result / marker / class / exit" "SET_INCOMPLETE INCOMPLETE archive 2" "$(val B30_RUNNER_RESULT) $(val B30_SET_MARKER) $(val B30_FAILURE_CLASS) $RC"
tv "I5 incomplete set kept: .start + dump + sidecar, nothing else" ".start leadcapture.sql.gz leadcapture.sql.gz.sha256" "$(incfiles)"
tv "I5 the dump taken before the failure stays published; nothing pruned; host temp dir removed; lines allow-listed" "3 0 0" "$(dumps) $(hosttmp) $FRC"
INC0="$(incstate)"

echo "== I6. while an incomplete set is pending: check mode and set mode both refuse; the set is left alone"
run_host b30_recovery_check "" "" pipe
tv "I6 check: result / class / exit" "CHECK_FAILED incomplete_set 2" "$(val B30_RUNNER_RESULT) $(val B30_FAILURE_CLASS) $RC"
run_host b30_recovery_set 2026-11-04T14:00Z 2026-11-04T15:00Z pipe
tv "I6 set: result / class / exit; no new set, no new dump" "CHECK_FAILED incomplete_set 2 3 3" "$(val B30_RUNNER_RESULT) $(val B30_FAILURE_CLASS) $RC $(ls -d "$BK"/recovery-sets/b30-2* | wc -l | tr -d ' ') $(dumps)"
tv "I6 incomplete set untouched" "$INC0" "$(incstate)"
resolveinc

echo "== I7. the 22 November failure class on the corrected runner: a query answer carrying a psql command tag"
# shim: prints "SET" before the real answer of every psql query — what psql does without -q
cat > "$SHIM/docker" <<EOS
#!/bin/bash
case "\$*" in *"exec -T postgres sh -c exec psql"*) echo SET;; esac
exec "$REALDOCKER" "\$@"
EOS
run_host b30_recovery_set 2026-11-05T14:00Z 2026-11-05T15:00Z pipe "PATH=$SHIM:$PATH"; show; showlog b30_recovery_set
tv "I7 a contaminated fingerprint is refused, never accepted: result / marker / class / exit" "SET_INCOMPLETE INCOMPLETE db_facts 2" "$(val B30_RUNNER_RESULT) $(val B30_SET_MARKER) $(val B30_FAILURE_CLASS) $RC"
tv "I7 host state = the state found on 22 November (.start + dump + sidecar), now WITH a reported result" ".start leadcapture.sql.gz leadcapture.sql.gz.sha256 1" "$(incfiles) $(grep -c '^B30_RUNNER_RESULT=' "$T/host.out")"
tv "I7 host temp dir removed" "0" "$(hosttmp)"
resolveinc

echo "== I8. read-only and error handling of the query helper against the real database"
PGQ_LINE="$(grep -E '^pgq\(\) ' "$KIT/b30-backup-set.sh")"
t "I8 pgq extracted from the toolkit" bash -c "[ -n \"\$1\" ]" _ "$PGQ_LINE"
pgq_real() { ( cd "$APP/docker" && compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; } && eval "$PGQ_LINE" && pgq "$1" ) </dev/null; }
FP_SQL_LINE="$(grep -E '^FP_SQL=' "$KIT/b30-backup-set.sh")"; eval "$FP_SQL_LINE"
t "I8 fingerprint query returns exactly one line of exactly 32 hexadecimal characters" bash -c "[[ \"\$1\" =~ ^[0-9a-f]{32}\$ ]]" _ "$(pgq_real "$FP_SQL")"
tv "I8 the same value survives the toolkit's own whitespace stripping unchanged (nothing but the value was printed)" "$(pgq_real "$FP_SQL")" "$(pgq_real "$FP_SQL" | tr -d '[:space:]')"
pgq_real "create table b30_must_not_exist (i int)" >/dev/null 2>"$T/ro.err"; tv "I8 a write through pgq is refused (read-only transaction), non-zero exit" "1 1" "$([ $? -ne 0 ] && echo 1 || echo 0) $(grep -c 'read-only transaction' "$T/ro.err")"
tv "I8 the table was not created" "0" "$(psqlq "select count(*) from information_schema.tables where table_name='b30_must_not_exist'")"
pgq_real "select 1/0" >/dev/null 2>&1; tv "I8 a failing statement gives a non-zero exit (ON_ERROR_STOP)" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

echo "== I8b. negative controls with the real tools: the two behaviours the corrections rest on"
# the query helper as it was on 2026-11-22 (no -q), against the same database
pgq_old() { ( cd "$APP/docker" && docker compose -f docker-compose.yml -f compose.vps.yml exec -T postgres sh -c 'exec psql -X -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "set default_transaction_read_only = on" -c "$1"' sh "$1" ) </dev/null; }
tv "I8b without -q the real psql prints its command tag before the answer (what the toolkit read on 2026-11-22)" "SET $(pgq_real "$FP_SQL")" "$(pgq_old "$FP_SQL" | tr '\n' ' ' | sed 's/ $//')"
t "I8b that answer is refused by the toolkit's shape check" bash -c '! [[ "$(printf "%s" "$1" | tr -d "[:space:]")" =~ ^[0-9a-f]{32}$ ]]' _ "$(pgq_old "$FP_SQL")"
# a real `compose exec -T` with a stream on standard input, and the same call with standard input detached
SENT=4000
left_attached="$(head -c "$SENT" /dev/zero | tr '\0' x | { compose exec -T postgres true; wc -c; } | tr -d ' ')"
left_detached="$(head -c "$SENT" /dev/zero | tr '\0' x | { compose exec -T postgres true </dev/null; wc -c; } | tr -d ' ')"
t "I8b a real compose exec -T takes bytes from an attached stream ($left_attached of $SENT left for the next reader)" test "$left_attached" -lt "$SENT"
tv "I8b with </dev/null the same call leaves the stream untouched" "$SENT" "$left_detached"

echo "== I10. the workflow's own SSH-setup and host-session steps over a REAL SSH session to a local sshd"
W="$ROOT/.github/workflows/b25-stage1-inspection.yml"
if [ -n "$RUN_AS" ] && command -v sshd >/dev/null 2>&1 && command -v ssh >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1; then
  step() { awk -v n="$1" 'index($0,"- name: " n)==7{p=1} p&&/^        run: \|/{r=1;next} r&&/^      - name:/{exit} r{sub(/^          /,""); print}' "$W"; }
  step "Install SSH key and pinned host key" > "$T/step-ssh.sh"; step "Recovery runner — host session" > "$T/step-host.sh"
  t "I10 both steps extracted from the workflow" bash -c "grep -q 'StrictHostKeyChecking yes' '$T/step-ssh.sh' && grep -q \"^ssh vps 'bash -s' < \" '$T/step-host.sh'"
  SD="$T/sshd"; RH="$T/runnerhome"; mkdir -p "$SD" "$RH"; chmod 711 "$SD"; chmod 700 "$RH"
  ssh-keygen -q -t ed25519 -N '' -C b30-it-host -f "$SD/hostkey"; ssh-keygen -q -t ed25519 -N '' -C b30-it-client -f "$SD/clientkey"
  cp "$SD/clientkey.pub" "$SD/authorized_keys"; chown "$RUN_AS" "$SD/authorized_keys"; chmod 600 "$SD/authorized_keys"
  PORT="$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  { echo "Port $PORT"; echo "ListenAddress 127.0.0.1"; echo "HostKey $SD/hostkey"; echo "PidFile $SD/sshd.pid"; echo "AuthorizedKeysFile $SD/authorized_keys"
    echo "PasswordAuthentication no"; echo "KbdInteractiveAuthentication no"; echo "UsePAM no"; echo "PermitRootLogin no"; echo "AllowUsers $RUN_AS"; echo "LogLevel ERROR"
    # the directories a host has at its defaults are named here for the remote session; nothing else differs from a host
    echo "SetEnv BACKUP_DIR=$BK STATE_DIR=$ST TMPDIR=$HT DOCKER_HOST=$DOCKER_HOST"; } > "$SD/sshd_config"
  [ -d /run/sshd ] || { mkdir -p /run/sshd && MADE_RUN_SSHD=1; }
  SSHD_PIDFILE="$SD/sshd.pid"; "$(command -v sshd)" -f "$SD/sshd_config" -E "$SD/sshd.log"; for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$SSHD_PIDFILE" ] && break; sleep 0.3; done
  if [ -s "$SSHD_PIDFILE" ]; then
    # the workflow's SSH-setup step with local values in place of the repository secrets (strict host key checking stays on)
    ( cd "$ROOT" && env -i PATH="$PATH" HOME="$RH" VPS_SSH_KEY="$(cat "$SD/clientkey")" VPS_KNOWN_HOSTS="[127.0.0.1]:$PORT $(cut -d' ' -f1,2 "$SD/hostkey.pub")" VPS_HOST=127.0.0.1 VPS_PORT="$PORT" VPS_USER="$RUN_AS" bash "$T/step-ssh.sh" ) >/dev/null 2>&1
    tv "I10 SSH setup step: key, pinned host key and config written 600" "600 600 600" "$(stat -c %a "$RH/.ssh/deploy_key" "$RH/.ssh/known_hosts" "$RH/.ssh/config" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
    # The ssh client resolves "~" from the account database, not from HOME; on the GitHub runner both are the same
    # directory. Here the files the step wrote live under the test directory, so a wrapper points the real client at
    # them. Host, port, user, BatchMode, IdentitiesOnly and strict host key checking still come from the step's config.
    SW="$T/sshwrap"; mkdir -p "$SW"; REALSSH="$(command -v ssh)"
    printf '#!/bin/bash\nexec %q -F %q -o IdentityFile=%q -o UserKnownHostsFile=%q "$@"\n' "$REALSSH" "$RH/.ssh/config" "$RH/.ssh/deploy_key" "$RH/.ssh/known_hosts" > "$SW/ssh"; chmod 755 "$SW/ssh"
    if [ "$(env -i PATH="$SW:$PATH" HOME="$RH" ssh vps 'echo reachable' 2>/dev/null </dev/null)" = reachable ]; then
      # run_step <mode> <start> <end> → SOUT (everything the step prints = what the GitHub log would hold), SRC
      run_step() { rm -rf "$T/rt"; mkdir -p "$T/rt"
        SOUT="$(cd "$ROOT" && env -i PATH="$SW:$PATH" HOME="$RH" RUNNER_TEMP="$T/rt" MODE="$1" IN_START="$2" IN_END="$3" VPS_DEPLOY_PATH="$APP" B30_PRODUCT_SHA="$PRODUCT_SHA" B30_SUMS_SHA256="$SUMS_SHA" bash "$T/step-host.sh" 2>&1)"; SRC=$?; }
      sline() { printf '%s\n' "$SOUT" | grep -cx -- "$1"; }
      sshow() { printf '%s\n' "$SOUT" | sed -E 's/^/     | /; s/b30-[0-9]{8}-[0-9]{6}/b30-<stamp>/'; }
      run_step b30_recovery_check "" ""; sshow
      tv "I10 check mode over SSH: step exit / result line" "0 1" "$SRC $(sline 'B30_RUNNER_RESULT=CHECK_OK')"
      nd="$(dumps)"; ns="$(sets)"
      # a window that is active now, as a real dispatch needs, and that starts after every set made above: the host's
      # one-set-per-window guard goes by the creation time recorded in a set's manifest
      lastmin="$(cat "$BK"/recovery-sets/b30-2*/recovery-*.txt 2>/dev/null | sed -n 's/^created_utc=\(.\{16\}\).*/\1/p' | LC_ALL=C sort | tail -1)"
      while [ "$(date -u +%Y-%m-%dT%H:%M)" = "$lastmin" ]; do sleep 2; done
      WS2="$(date -u +%Y-%m-%dT%H:%MZ)"; WE2="$(date -u -d '+60 min' +%Y-%m-%dT%H:%MZ)"
      run_step b30_recovery_set "$WS2" "$WE2"; sshow
      if [ "$EXPECT_RESULT" = SET_VERIFIED ]; then
        tv "I10 set mode over SSH: step PASSES; result line and marker in the log; one more set, one more dump; host temp dir removed" "0 1 1 $((ns + 1)) $((nd + 1)) 0" "$SRC $(sline 'B30_RUNNER_RESULT=SET_VERIFIED') $(sline 'B30_SET_MARKER=VERIFIED') $(sets) $(dumps) $(hosttmp)"
        t "I10 the log of the passing set run holds allow-listed summary lines only" bash -c 'printf "%s\n" "$1" | b30_filter_summary >/dev/null' _ "$SOUT"
      else
        tv "I10 set mode over SSH: result REPORTED (not verified: fingerprint), step fails with the host exit code; one more set and dump; host temp dir removed" "1 1 1 $((ns + 1)) $((nd + 1)) 0" "$SRC $(sline 'B30_RUNNER_RESULT=SET_NOT_VERIFIED') $(sline '::error::the host did not report B30_RUNNER_RESULT=SET_VERIFIED (ssh exit 2)') $(sets) $(dumps) $(hosttmp)"
      fi
      tv "I10 nothing of the password, the fixture marker, the key id or a host path in that log" "0 0 0 0" "$(printf '%s\n' "$SOUT" | grep -c "$PGPW") $(printf '%s\n' "$SOUT" | grep -c "$MARK") $(printf '%s\n' "$SOUT" | grep -c "$KID") $(printf '%s\n' "$SOUT" | grep -c "$T")"
      run_step b30_recovery_set "$WS2" "$WE2"
      tv "I10 same window again over SSH: refused, step fails, no further set or dump" "1 1 $((ns + 1)) $((nd + 1))" "$SRC $(sline 'B30_RUNNER_RESULT=REFUSED_window_already_used') $(sets) $(dumps)"
    else echo "note - I10 skipped: the local sshd did not accept the session (is the B30_IT_RUN_AS account locked?)"; fi
  else echo "note - I10 skipped: the local sshd did not start"; fi
else echo "note - I10 skipped: needs sshd, ssh, ssh-keygen, root and B30_IT_RUN_AS (the real SSH transport is then NOT covered by this run)"; fi

echo "== I9. end state"
tv "I9 volume and database unchanged across all scenarios" "$VOL0 $DB0" "$(voldigest) $(dbdigest)"
tv "I9 no container left behind by any session (only the two services)" "2" "$(docker ps -aq | wc -l | tr -d ' ')"
tv "I9 no host temp dir left behind" "0" "$(hosttmp)"

echo "== RESULT pass=$pass fail=$fail (real Docker client + compose exec + PostgreSQL in the stack's image; NOT verified: the host's own sshd and network, GitHub runner, real API and migrate images, live traffic, hosted dispatch)"
[ "$fail" = 0 ]
