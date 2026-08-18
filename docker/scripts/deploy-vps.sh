#!/bin/bash
# =============================================================================
# Card Scanner Pro — Hostinger VPS deployment (dev.kaptnow.com)
# =============================================================================
# Deploys ONE exact git commit of the existing Docker stack (api + web only,
# published solely on 127.0.0.1:18080) and health-checks the result. Invoked by
# .github/workflows/deploy-dev-vps.yml over SSH as the `leadpro` user, or
# manually on the VPS:
#
#     bash docker/scripts/deploy-vps.sh <git-sha> [branch]
#
# Rollback = deploy the previous known-good SHA (recorded in $STATE_DIR):
#
#     bash docker/scripts/deploy-vps.sh "$(cat /opt/lead-capture-pro/env/previous-deploy.sha)" develop
#
# Safety: never starts bundled postgres/redis, never prunes, never touches
# volumes or any resource outside the card-scanner-pro compose project.
# =============================================================================
set -euo pipefail

SHA="${1:?usage: deploy-vps.sh <git-sha> [branch]}"
BRANCH="${2:-develop}"
APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
HEALTH_URL="http://127.0.0.1:18080"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-150}"

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

compose() {
  docker compose -f docker-compose.yml -f compose.vps.yml "$@"
}

# ── 1. Preconditions ─────────────────────────────────────────────────────────
[ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout"
cd "$APP_DIR"

[ -f "$ENV_FILE" ] || fail "runtime env file missing: $ENV_FILE"
perms="$(stat -c '%a' "$ENV_FILE")"
[ "$perms" = "600" ] || fail "$ENV_FILE must be chmod 600 (is $perms)"
[ -e docker/.env ] || fail "docker/.env missing — create the symlink: ln -s $ENV_FILE $APP_DIR/docker/.env"
# The env file must never be tracked by git.
if git ls-files --error-unmatch docker/.env >/dev/null 2>&1; then
  fail "docker/.env is tracked by git — remove it from the index before deploying"
fi

# ── 2. Git: fetch, verify, pin the exact commit ─────────────────────────────
log "fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"

git cat-file -e "${SHA}^{commit}" 2>/dev/null || fail "commit $SHA not found after fetch"
git merge-base --is-ancestor "$SHA" "origin/$BRANCH" \
  || fail "commit $SHA is not on origin/$BRANCH — refusing to deploy"

dirty="$(git status --porcelain)"
[ -z "$dirty" ] || fail "working tree is unexpectedly dirty:\n$dirty"

PREV_GOOD=""
[ -f "$STATE_DIR/current-deploy.sha" ] && PREV_GOOD="$(cat "$STATE_DIR/current-deploy.sha")"

log "checking out $SHA (previous known-good: ${PREV_GOOD:-none})"
git -c advice.detachedHead=false checkout --quiet --detach "$SHA"

# ── 3. Compose safety guard: only api + postgres + web may resolve ──────────
# postgres is the bundled development database (profile local-db, internal
# network only, data in the named pgdata volume — never deleted by this
# script). Redis and every other optional service must not resolve.
cd docker
services="$(compose config --services | sort | tr '\n' ' ' | sed 's/ $//')"
[ "$services" = "api postgres web" ] \
  || fail "compose would start unexpected services: '$services' (expected 'api postgres web' — check COMPOSE_PROFILES=local-db in $ENV_FILE)"

# ── 4. Build + start (api and web only, never postgres/redis) ───────────────
# Sequential builds: the VPS has 2 vCPUs and hosts another live website, so
# never build both images in parallel (no CPU/RAM spike).
export COMPOSE_PARALLEL_LIMIT=1
log "building api image for $SHA"
compose build api
log "building web image for $SHA"
compose build web
# Explicit safe startup order: bring postgres up FIRST and block until its
# healthcheck passes (--wait exits non-zero on failure, aborting the deploy).
# An already-running healthy postgres is a no-op — app deployments never
# rebuild/recreate the postgres container and never touch the pgdata volume.
log "ensuring postgres is up and healthy"
compose up -d --wait --wait-timeout 120 postgres
log "starting api + web"
compose up -d --no-deps api web

# ── 5. Health checks through the loopback gateway ───────────────────────────
check_health() {
  curl -fsS --max-time 5 "$HEALTH_URL/healthz"      >/dev/null \
  && curl -fsS --max-time 5 "$HEALTH_URL/api/healthz" >/dev/null \
  && curl -fsS --max-time 5 "$HEALTH_URL/api/readyz"  >/dev/null
}

wait_healthy() {
  local waited=0
  until check_health; do
    waited=$((waited + 5))
    [ "$waited" -ge "$HEALTH_TIMEOUT_S" ] && return 1
    sleep 5
  done
  return 0
}

if wait_healthy; then
  mkdir -p "$STATE_DIR"
  [ -n "$PREV_GOOD" ] && echo "$PREV_GOOD" > "$STATE_DIR/previous-deploy.sha"
  echo "$SHA" > "$STATE_DIR/current-deploy.sha"
  log "health checks passed (healthz, api/healthz, api/readyz)"
  compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
  log "deployed $SHA successfully"
  exit 0
fi

# ── 6. Failure path: report, attempt one rollback, still exit non-zero ──────
echo "[deploy] ERROR: health checks FAILED for $SHA" >&2
compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' >&2 || true
compose logs --tail 25 api web >&2 || true

if [ -n "$PREV_GOOD" ] && [ "$PREV_GOOD" != "$SHA" ] && [ "${NO_AUTO_ROLLBACK:-0}" != "1" ]; then
  echo "[deploy] attempting rollback to previous known-good $PREV_GOOD" >&2
  cd "$APP_DIR"
  git -c advice.detachedHead=false checkout --quiet --detach "$PREV_GOOD"
  cd docker
  # Rollback rebuilds/restarts ONLY the application (api/web) at the previous
  # SHA. The same postgres container and pgdata volume are kept — database
  # contents are never reset, restored, or rolled back automatically.
  compose build api >&2
  compose build web >&2
  compose up -d --wait --wait-timeout 120 postgres >&2
  compose up -d --no-deps api web >&2
  if wait_healthy; then
    echo "[deploy] rollback to $PREV_GOOD is healthy — deployment of $SHA still FAILED" >&2
  else
    echo "[deploy] rollback to $PREV_GOOD ALSO unhealthy — manual intervention required" >&2
  fi
else
  echo "[deploy] no previous known-good commit recorded — manual intervention required" >&2
  echo "[deploy] manual rollback: bash docker/scripts/deploy-vps.sh <known-good-sha> $BRANCH" >&2
fi
exit 1
