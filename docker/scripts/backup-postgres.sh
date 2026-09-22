#!/bin/bash
# =============================================================================
# Card Scanner Pro — bundled-PostgreSQL backup (Hostinger VPS, dev.kaptnow.com)
# =============================================================================
# Dumps the development database from the running `postgres` compose service
# into a timestamped, compressed file OUTSIDE the database volume, verifies it,
# publishes it atomically, records a checksum and only then prunes old backups.
# Run as the `leadpro` user:
#
#     bash docker/scripts/backup-postgres.sh
#
# Behaviour (B23 G-6 Correction 1):
#   - one run at a time: a lock in $BACKUP_DIR (flock); a second invocation exits
#     with status 75 (EX_TEMPFAIL) immediately and never touches the first run's
#     output;
#   - the dump is written to a unique temporary file on the destination
#     filesystem; the final `leadcapture-<UTC stamp>.sql.gz` name appears only
#     after pg_dump and gzip succeeded, `gzip -t` passed, the size floor is met
#     and the dump carries its header and its completion marker;
#   - the sha256 is computed on the temporary file and written to a temporary
#     sidecar BEFORE anything is published; a checksum failure publishes nothing;
#   - publication never clobbers: sidecar and dump are hard-linked into their
#     final names (an existing target makes the link fail atomically), the
#     sidecar first, the dump second; a late name collision leaves the existing
#     files untouched and publishes nothing;
#   - the published pair is re-verified (`sha256sum -c`); a mismatch removes the
#     pair again — a `leadcapture-*.sql.gz` name therefore always means a
#     complete, verified dump with a matching `.sha256` sidecar (backups made
#     before this revision have no sidecar and stay valid — see backup-check.sh);
#   - any failure removes only the run's own temporary files (and its own
#     half-published sidecar) and leaves every existing backup untouched (no
#     pruning on failure);
#   - older backups are pruned together with their sidecar when they age out;
#   - directory 700, files 600; nothing about the database (credentials, rows)
#     is ever printed — pg_dump runs INSIDE the postgres container as the
#     container's own POSTGRES_USER over the local socket.
#
# Environment (all optional): DEPLOY_PATH, BACKUP_DIR, KEEP (default 7),
# BACKUP_MIN_BYTES (default 1024).
#
# Suggested daily schedule and the check script: docs/BACKUP_AND_RECOVERY.md.
# NOTE: a backup that lives only on this VPS does not protect against total
# VPS loss — copy backups off-host for real protection (same document).
# =============================================================================
set -euo pipefail
umask 077

APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
KEEP="${KEEP:-7}"
MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="leadcapture-$STAMP.sql.gz"
OUT="$BACKUP_DIR/$NAME"
LOCK="$BACKUP_DIR/.backup.lock"
TMP=""; SCTMP=""; SC_PUBLISHED=0; PUBLISHED=0

log()  { echo "[backup] $(date -u +%FT%TZ) $*"; }
fail() { echo "[backup] $(date -u +%FT%TZ) ERROR: $*" >&2; exit 1; }
cleanup() {
  # Only this run's own temporary files (and its own half-published sidecar) are ever removed here.
  if [ -n "$TMP" ] && [ -e "$TMP" ]; then rm -f "$TMP"; log "removed this run's incomplete temporary dump"; fi
  if [ -n "$SCTMP" ] && [ -e "$SCTMP" ]; then rm -f "$SCTMP"; log "removed this run's temporary checksum file"; fi
  if [ "$SC_PUBLISHED" = "1" ] && [ "$PUBLISHED" != "1" ] && [ -e "$OUT.sha256" ]; then rm -f "$OUT.sha256"; log "removed this run's sidecar (its dump was not published)"; fi
}
compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }

[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || fail "KEEP must be a positive integer (is '$KEEP')"
[[ "$MIN_BYTES" =~ ^[0-9]+$ ]] || fail "BACKUP_MIN_BYTES must be an integer (is '$MIN_BYTES')"
[ -d "$APP_DIR/docker" ] || fail "app directory not found: $APP_DIR/docker"
cd "$APP_DIR/docker"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# ── one run at a time ────────────────────────────────────────────────────────
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[backup] $(date -u +%FT%TZ) ERROR: another backup is already running (lock $LOCK is held) — exiting without touching anything" >&2
  exit 75
fi
trap cleanup EXIT

# Temporary files can only be left by a crashed earlier run (we hold the lock now).
stale="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '.leadcapture-*.tmp' 2>/dev/null | wc -l)"
if [ "$stale" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '.leadcapture-*.tmp' -delete
  log "removed $stale stale temporary file(s) left by an earlier interrupted run"
fi
# A sidecar without its dump (an earlier run interrupted between the two publications)
# is never a recovery point: drop it so it cannot be mistaken for one.
for sc in "$BACKUP_DIR"/leadcapture-*.sql.gz.sha256; do
  [ -e "$sc" ] || continue
  [ -e "${sc%.sha256}" ] || { rm -f "$sc"; log "removed orphan sidecar $(basename "$sc") left by an earlier interrupted run"; }
done

# The postgres service must be up (it is part of the normal VPS stack).
compose ps --status running postgres --format '{{.Name}}' | grep -q . \
  || fail "postgres service is not running — nothing to back up"

# ── dump to a unique temporary file on the destination filesystem ────────────
# Never overwrite an existing backup (same-second re-run): refuse early; the hard
# links at publication time enforce it even if the name appears later.
[ ! -e "$OUT" ] && [ ! -e "$OUT.sha256" ] || fail "target $NAME (or its sidecar) already exists — refusing to overwrite an existing backup"
TMP="$(mktemp "$BACKUP_DIR/.leadcapture-$STAMP.XXXXXX.tmp")"
chmod 600 "$TMP"
log "dumping to a temporary file (final name $NAME)"
# pipefail: a pg_dump failure fails this pipeline even though gzip succeeds.
if ! compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip -c > "$TMP"; then
  fail "pg_dump or gzip failed — no backup published"
fi

# ── verify before publishing ─────────────────────────────────────────────────
gzip -t "$TMP" || fail "gzip integrity check failed — no backup published"
size="$(stat -c '%s' "$TMP")"
[ "$size" -ge "$MIN_BYTES" ] || fail "backup suspiciously small ($size bytes, floor $MIN_BYTES) — no backup published"
head_lines="$(zcat "$TMP" | head -n 3 || true)"
printf '%s\n' "$head_lines" | grep -q '^-- PostgreSQL database dump$' || fail "unexpected dump header — no backup published"
tail_bytes="$(zcat "$TMP" | tail -c 4096 || true)"
printf '%s\n' "$tail_bytes" | grep -q '^-- PostgreSQL database dump complete$' || fail "dump completion marker missing (incomplete dump) — no backup published"

# ── checksum first: computed on the temporary dump, written to a temporary sidecar ─
sum="$(sha256sum "$TMP" | cut -c1-64)" || fail "checksum computation failed — no backup published"
[[ "$sum" =~ ^[0-9a-f]{64}$ ]] || fail "checksum computation returned an unexpected value — no backup published"
SCTMP="$(mktemp "$BACKUP_DIR/.leadcapture-$STAMP.XXXXXX.sha256.tmp")" || fail "cannot create the checksum temporary file — no backup published"
chmod 600 "$SCTMP"
printf '%s  %s\n' "$sum" "$NAME" > "$SCTMP" || fail "checksum write failed — no backup published"
[ "$(cut -c1-64 "$SCTMP" 2>/dev/null)" = "$sum" ] || fail "checksum sidecar re-read mismatch — no backup published"

# ── publish without clobbering: a hard link fails atomically when the target exists ─
# Sidecar first, dump second: a published dump name always has its sidecar already.
if ! ln "$SCTMP" "$OUT.sha256" 2>/dev/null; then
  fail "sidecar target $NAME.sha256 appeared during the run — refusing to overwrite; nothing published"
fi
SC_PUBLISHED=1
if ! ln "$TMP" "$OUT" 2>/dev/null; then
  rm -f "$OUT.sha256"; SC_PUBLISHED=0
  fail "target $NAME appeared during the run — refusing to overwrite an existing backup; nothing published"
fi
PUBLISHED=1
rm -f "$TMP" "$SCTMP"; TMP=""; SCTMP=""
chmod 600 "$OUT" "$OUT.sha256"

# ── the published pair must verify; otherwise it is removed again ────────────
if ! ( cd "$BACKUP_DIR" && sha256sum -c --quiet "$NAME.sha256" >/dev/null 2>&1 ); then
  rm -f "$OUT" "$OUT.sha256"; PUBLISHED=0; SC_PUBLISHED=0
  fail "published backup failed its checksum verification — removed again; nothing published"
fi
log "OK — $OUT ($size bytes) sha256=$sum"

# ── retention: only after the new backup is fully verified and published ─────
ls -1t "$BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  log "pruning $(basename "$old")$([ -e "$old.sha256" ] && echo ' (+ sidecar)')"
  rm -f "$old" "$old.sha256"
done
# Sidecars whose backup no longer exists (e.g. removed by hand) are dropped too.
for sc in "$BACKUP_DIR"/leadcapture-*.sql.gz.sha256; do
  [ -e "$sc" ] || continue
  [ -e "${sc%.sha256}" ] || { rm -f "$sc"; log "removed orphan sidecar $(basename "$sc")"; }
done
log "$(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz | wc -l) backup(s) retained (KEEP=$KEEP)"
