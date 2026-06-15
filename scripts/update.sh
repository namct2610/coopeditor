#!/usr/bin/env bash
# Frame Editor auto-updater.
#
# Usage:
#   bash scripts/update.sh                       # update now
#   bash scripts/update.sh --check               # report status, do not update
#   bash scripts/update.sh --branch main         # pull a specific branch
#
# Crontab line (chạy 3h sáng mỗi ngày, log vào /var/log/frame-editor-update.log):
#   0 3 * * *  cd /home/me/frame-editor && /bin/bash scripts/update.sh >> /var/log/frame-editor-update.log 2>&1
#
# Safe to re-run: if no new commits, exits early. Data volumes never touched.

set -euo pipefail

BRANCH="${BRANCH:-main}"
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --branch) shift; BRANCH="$1" ;;
  esac
done

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

if [ ! -d ".git" ]; then
  log "ERROR: $ROOT is not a git checkout — auto-update requires git pull. Manual rebuild only."
  exit 2
fi

# 1) Fetch + check
log "Fetching origin/$BRANCH..."
git fetch --quiet origin "$BRANCH" || { log "ERROR: git fetch failed"; exit 3; }

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  log "Already up to date ($LOCAL_SHA)."
  exit 0
fi

BEHIND="$(git rev-list --count HEAD..origin/$BRANCH)"
log "Update available: $BEHIND commit(s) behind. Local=$LOCAL_SHA Remote=$REMOTE_SHA"

if [ "$CHECK_ONLY" = "1" ]; then
  exit 4   # exit code 4 = update available (use in monitoring)
fi

# 2) Pull
log "Pulling..."
git pull --ff-only origin "$BRANCH" || { log "ERROR: fast-forward pull failed — manual conflict resolution needed"; exit 5; }

# 3) Rebuild affected images. Pass BUILD_SHA + BUILT_AT so containers know their version.
export BUILD_SHA="$REMOTE_SHA"
export BUILT_AT="$TIMESTAMP"

log "Rebuilding Docker images..."
docker compose build api web worker || { log "ERROR: docker build failed"; exit 6; }

# 4) Roll the services. Data volumes (postgres_data, minio_data, api_state, caddy_data) are untouched.
log "Recreating containers..."
docker compose up -d --no-deps api web worker || { log "ERROR: docker compose up failed"; exit 7; }

# 5) Smoke check: API back up?
sleep 4
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health}"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
    log "Health check OK at $HEALTH_URL"
  else
    log "WARNING: health check failed at $HEALTH_URL — inspect: docker compose logs --since=2m api"
    exit 8
  fi
fi

log "Update complete. Now running $REMOTE_SHA."
