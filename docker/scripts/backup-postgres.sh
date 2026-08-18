#!/bin/bash
# =============================================================================
# Card Scanner Pro — bundled-PostgreSQL backup (Hostinger VPS, dev.kaptnow.com)
# =============================================================================
# Dumps the development database from the running `postgres` compose service
# into a timestamped, compressed file OUTSIDE the database volume, then prunes
# old backups. Run as the `leadpro` user:
#
#     bash docker/scripts/backup-postgres.sh
#
# Suggested cron (documented only — install manually when desired):
#     15 3 * * *  bash /opt/lead-capture-pro/app/docker/scripts/backup-postgres.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1
#
# NOTE: a backup that lives only on this VPS does not protect against total
# VPS loss — copy backups off-host for real protection (see
# docs/HOSTINGER_VPS_DEPLOYMENT.md §Backups).
#
# pg_dump runs INSIDE the postgres container as the container's own
# POSTGRES_USER over the local socket, so no password is read, passed, or
# printed by this script.
# =============================================================================
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
KEEP="${KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/leadcapture-$STAMP.sql.gz"

fail() { echo "[backup] ERROR: $*" >&2; exit 1; }

compose() {
  docker compose -f docker-compose.yml -f compose.vps.yml "$@"
}

cd "$APP_DIR/docker" || fail "app directory not found: $APP_DIR/docker"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# The postgres service must be up (it is part of the normal VPS stack).
compose ps --status running postgres --format '{{.Name}}' | grep -q . \
  || fail "postgres service is not running — nothing to back up"

echo "[backup] dumping to $OUT"
if ! compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$OUT"; then
  rm -f "$OUT"
  fail "pg_dump failed — no backup written"
fi
chmod 600 "$OUT"

# A dump of even an empty schema is well over 1 KB; treat tiny files as failure.
size="$(stat -c '%s' "$OUT")"
[ "$size" -ge 1024 ] || { rm -f "$OUT"; fail "backup suspiciously small ($size bytes) — discarded"; }

# Retention: keep the newest $KEEP backups, delete the rest (backups only).
ls -1t "$BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "[backup] pruning $old"
  rm -f "$old"
done

echo "[backup] OK — $OUT ($size bytes), $(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz | wc -l) backup(s) retained"
