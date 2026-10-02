#!/bin/sh
# Production entrypoint for the Card Scanner Pro API server.
#
# Keeps startup explicit and fail-fast: required secrets are validated by the
# app itself (config.ts throws on missing SESSION_SECRET / DATABASE_URL). This
# script only logs non-secret context and execs the bundled server as PID 1 so
# it receives SIGTERM/SIGINT for graceful container shutdown.
set -eu

PORT="${PORT:-8080}"

echo "[entrypoint] Card Scanner Pro API"
echo "[entrypoint]   NODE_ENV=${NODE_ENV:-production}"
echo "[entrypoint]   PORT=${PORT}"
echo "[entrypoint]   LOG_LEVEL=${LOG_LEVEL:-info}"
# Batch 25 — object storage: non-secret context only (never the key, never a path).
echo "[entrypoint]   OBJECT_STORAGE_DRIVER=${OBJECT_STORAGE_DRIVER:-<auto>}"
if [ -n "${OBJECT_STORAGE_FS_ROOT:-}" ]; then echo "[entrypoint]   OBJECT_STORAGE_FS_ROOT=(set)"; else echo "[entrypoint]   OBJECT_STORAGE_FS_ROOT=(not set)"; fi
if [ -n "${OBJECT_STORAGE_ENCRYPTION_KEY:-}" ]; then echo "[entrypoint]   OBJECT_STORAGE_ENCRYPTION_KEY=(set)"; else echo "[entrypoint]   OBJECT_STORAGE_ENCRYPTION_KEY=(not set)"; fi
echo "[entrypoint]   OBJECT_STORAGE_LEGACY_FALLBACK=${OBJECT_STORAGE_LEGACY_FALLBACK:-false} OBJECT_STORAGE_MIRROR=${OBJECT_STORAGE_MIRROR:-off}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] WARNING: DATABASE_URL is not set — the server will fail to start." >&2
fi
if [ -z "${SESSION_SECRET:-}" ]; then
  echo "[entrypoint] WARNING: SESSION_SECRET is not set — the server will fail to start." >&2
fi

# exec replaces the shell so Node becomes PID 1 and handles signals directly.
exec node --enable-source-maps /app/dist/index.mjs
