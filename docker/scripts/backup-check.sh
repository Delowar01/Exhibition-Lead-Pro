#!/bin/bash
# =============================================================================
# Card Scanner Pro — backup freshness and integrity check (dev VPS)
# =============================================================================
# Exits 0 when the newest backup in $BACKUP_DIR is younger than
# $BACKUP_MAX_AGE_HOURS (default 26), passes `gzip -t`, carries the pg_dump
# completion marker and — when a `.sha256` sidecar exists — matches it.
# Exits 1 otherwise and prints one line saying why. Intended for the daily
# schedule (after the backup) and for manual inspection:
#
#     bash docker/scripts/backup-check.sh
#
# Prints file name, age and size only — never database contents.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"

fail() { echo "[backup-check] $(date -u +%FT%TZ) FAIL: $*" >&2; exit 1; }

[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || fail "BACKUP_MAX_AGE_HOURS must be an integer (is '$MAX_AGE_HOURS')"
[ -d "$BACKUP_DIR" ] || fail "backup directory $BACKUP_DIR is absent"
newest="$(ls -1t "$BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | head -n 1 || true)"
[ -n "$newest" ] || fail "no backup file in $BACKUP_DIR"
name="$(basename "$newest")"
age_min=$(( ( $(date +%s) - $(stat -c '%Y' "$newest") ) / 60 ))
size="$(stat -c '%s' "$newest")"
[ "$age_min" -le $(( MAX_AGE_HOURS * 60 )) ] || fail "newest backup $name is $age_min minutes old (limit ${MAX_AGE_HOURS} h)"
gzip -t "$newest" 2>/dev/null || fail "newest backup $name fails gzip -t"
tail_bytes="$(zcat "$newest" | tail -c 4096 || true)"
printf '%s\n' "$tail_bytes" | grep -q '^-- PostgreSQL database dump complete$' || fail "newest backup $name has no completion marker"
if [ -e "$newest.sha256" ]; then
  ( cd "$BACKUP_DIR" && sha256sum -c --quiet "$name.sha256" >/dev/null 2>&1 ) || fail "newest backup $name does not match its .sha256 sidecar"
  sidecar="sha256 ok"
else
  sidecar="no sidecar (pre-C1 backup)"
fi
echo "[backup-check] $(date -u +%FT%TZ) OK: $name age=${age_min}min size=${size}B gzip ok, completion marker ok, $sidecar"
