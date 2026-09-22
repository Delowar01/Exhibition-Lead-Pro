#!/bin/bash
# =============================================================================
# Card Scanner Pro — backup freshness and integrity check (dev VPS)
# =============================================================================
# Exit 0 only when ALL of the following hold, otherwise exit 1 with one FAIL line:
#   - the newest `leadcapture-*.sql.gz` in $BACKUP_DIR is younger than
#     $BACKUP_MAX_AGE_HOURS, passes `gzip -t` and carries the pg_dump
#     completion marker;
#   - every backup of the "sidecar generation" has a matching `.sha256` sidecar.
#     The generation starts with the OLDEST backup (by name = UTC stamp) that
#     has a sidecar; every backup from that one on must have a matching sidecar.
#     Backups older than that were made before backup-postgres.sh wrote sidecars
#     (the seven activation-time dumps, the two 2026-09 captures) and stay valid
#     without one. A newer backup without a sidecar is therefore never healthy.
#
# BACKUP_MAX_AGE_HOURS (default 26) is the GENERAL-PURPOSE limit: "a backup was
# produced within roughly the last day". It is NOT the limit for the checks
# that run shortly after the scheduled backup — there a missed run must be
# caught while yesterday's file is only ~24.5 h old, so those checks pass
# BACKUP_MAX_AGE_HOURS=4 (see docs/BACKUP_AND_RECOVERY.md §3).
#
# BACKUP_CHECK_NOW (epoch seconds) overrides "now" — for tests only.
#
#     bash docker/scripts/backup-check.sh
#
# Prints file names, ages, sizes and counts only — never database contents.
# =============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
NOW="${BACKUP_CHECK_NOW:-$(date +%s)}"

fail() { echo "[backup-check] $(date -u +%FT%TZ) FAIL: $*" >&2; exit 1; }

[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || fail "BACKUP_MAX_AGE_HOURS must be an integer (is '$MAX_AGE_HOURS')"
[[ "$NOW" =~ ^[0-9]+$ ]] || fail "BACKUP_CHECK_NOW must be epoch seconds (is '$NOW')"
[ -d "$BACKUP_DIR" ] || fail "backup directory $BACKUP_DIR is absent"
cd "$BACKUP_DIR"

mapfile -t files < <(ls -1 leadcapture-*.sql.gz 2>/dev/null | sort)
[ "${#files[@]}" -gt 0 ] || fail "no backup file in $BACKUP_DIR"

# ── newest backup: age, gzip, completion marker ──────────────────────────────
newest="$(ls -1t leadcapture-*.sql.gz | head -n 1)"
age_min=$(( ( NOW - $(stat -c '%Y' "$newest") ) / 60 ))
size="$(stat -c '%s' "$newest")"
[ "$age_min" -le $(( MAX_AGE_HOURS * 60 )) ] || fail "newest backup $newest is $age_min minutes old (limit ${MAX_AGE_HOURS} h)"
gzip -t "$newest" 2>/dev/null || fail "newest backup $newest fails gzip -t"
tail_bytes="$(zcat "$newest" | tail -c 4096 || true)"
printf '%s\n' "$tail_bytes" | grep -q '^-- PostgreSQL database dump complete$' || fail "newest backup $newest has no completion marker"

# ── sidecar generation: from the oldest sidecar-bearing backup on, a sidecar is mandatory ─
first_gen=""
for f in "${files[@]}"; do
  if [ -e "$f.sha256" ]; then first_gen="$f"; break; fi
done
legacy=0; verified=0
for f in "${files[@]}"; do
  if [ -n "$first_gen" ] && [[ ! "$f" < "$first_gen" ]]; then
    [ -e "$f.sha256" ] || fail "backup $f has no .sha256 sidecar although the sidecar generation started with $first_gen — not a verified backup"
    sha256sum -c --quiet "$f.sha256" >/dev/null 2>&1 || fail "backup $f does not match its .sha256 sidecar"
    verified=$((verified + 1))
  else
    legacy=$((legacy + 1))
  fi
done
if [ -n "$first_gen" ]; then gen="sidecars verified=$verified (generation from $first_gen), pre-sidecar backups=$legacy"; else gen="no sidecar generation yet, pre-sidecar backups=$legacy"; fi
echo "[backup-check] $(date -u +%FT%TZ) OK: $newest age=${age_min}min (limit ${MAX_AGE_HOURS}h) size=${size}B gzip ok, completion marker ok, $gen"
