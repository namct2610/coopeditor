#!/bin/bash
# Coopeditor NAS auto-update — 1 lệnh để pull image mới + force restart.
#
# Cách dùng:
#   bash /volume1/docker/coopeditor/scripts/nas-update.sh
#
# Tự động hoá qua DSM Task Scheduler (gợi ý chạy 03:00 mỗi ngày):
#   Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script
#     User: root
#     Schedule: Daily 03:00
#     Run command: bash /volume1/docker/coopeditor/scripts/nas-update.sh
#
# Script verbose có chủ ý — KHÔNG dùng set -e/pipefail vì Synology DSM bash
# có vài quirk khiến script chết âm thầm. Mọi bước đều log status rõ ràng.

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# 0. Tự dò compose file
COMPOSE_CANDIDATES=("${COMPOSE_FILE:-}" "docker-compose.nas-auto.yml" "docker-compose.nas-clean.yml" "docker-compose.yml")
COMPOSE_FILE=""
for f in "${COMPOSE_CANDIDATES[@]}"; do
  [ -z "$f" ] && continue
  if [ -f "$ROOT/$f" ]; then COMPOSE_FILE="$f"; break; fi
done

if [ -z "$COMPOSE_FILE" ]; then
  echo "ERROR: Không tìm thấy docker-compose.*.yml trong $ROOT" >&2
  echo "       Đã thử: ${COMPOSE_CANDIDATES[*]}" >&2
  exit 1
fi

COMPOSE_FLAGS="-f $COMPOSE_FILE"
[ -f docker-compose.override.yml ] && COMPOSE_FLAGS="$COMPOSE_FLAGS -f docker-compose.override.yml"

LOG_FILE="${LOG_FILE:-/tmp/coopeditor-update.log}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080/api/version}"
WEB_URL="${WEB_URL:-http://127.0.0.1:8080/}"
APP_SERVICES=(web api worker)

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null
}

# 1. Snapshot SHA + digest trước khi pull
log "Compose file: $COMPOSE_FILE"

BEFORE_SHA="$(curl -fsS --max-time 5 "$GATEWAY_URL" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4)"
BEFORE_SHA="${BEFORE_SHA:-unknown}"

declare -A BEFORE_DIGEST
for svc in "${APP_SERVICES[@]}"; do
  cid="$(docker compose $COMPOSE_FLAGS ps -q "$svc" 2>/dev/null | head -1)"
  if [ -n "$cid" ]; then
    BEFORE_DIGEST[$svc]="$(docker inspect --format='{{.Image}}' "$cid" 2>/dev/null | sed 's|sha256:||' | cut -c1-12)"
    BEFORE_DIGEST[$svc]="${BEFORE_DIGEST[$svc]:-none}"
  else
    BEFORE_DIGEST[$svc]="none"
  fi
done
log "Trước update — API SHA: ${BEFORE_SHA:0:12} · web=${BEFORE_DIGEST[web]} api=${BEFORE_DIGEST[api]} worker=${BEFORE_DIGEST[worker]}"

# 2. Pull image mới từ GHCR — KHÔNG dùng --quiet để thấy progress nếu chậm.
log "Pull image mới từ ghcr.io..."
docker compose $COMPOSE_FLAGS pull 2>&1 | tee -a "$LOG_FILE"
PULL_EXIT=${PIPESTATUS[0]}
if [ "$PULL_EXIT" != "0" ]; then
  log "ERROR: docker compose pull exit $PULL_EXIT"
  exit 1
fi
log "Pull xong."

# 3. So digest và force recreate service nào lệch
declare -A AFTER_IMAGE_DIGEST
for svc in "${APP_SERVICES[@]}"; do
  IMG="ghcr.io/namct2610/coopeditor-$svc:latest"
  d="$(docker image inspect --format='{{.Id}}' "$IMG" 2>/dev/null | sed 's|sha256:||' | cut -c1-12)"
  AFTER_IMAGE_DIGEST[$svc]="${d:-unknown}"
done

TO_RECREATE=()
for svc in "${APP_SERVICES[@]}"; do
  new="${AFTER_IMAGE_DIGEST[$svc]}"
  old="${BEFORE_DIGEST[$svc]}"
  if [ "$new" = "unknown" ]; then
    log "  $svc: chưa thấy image latest sau pull (skip)"
  elif [ "$new" != "$old" ]; then
    log "→ $svc: $old → $new (sẽ recreate)"
    TO_RECREATE+=("$svc")
  else
    log "  $svc: digest không đổi ($new)"
  fi
done

if [ ${#TO_RECREATE[@]} -gt 0 ]; then
  log "Force recreate: ${TO_RECREATE[*]}"
  docker compose $COMPOSE_FLAGS up -d --force-recreate --no-deps "${TO_RECREATE[@]}" 2>&1 | tee -a "$LOG_FILE"
  UP_EXIT=${PIPESTATUS[0]}
  if [ "$UP_EXIT" != "0" ]; then
    log "ERROR: force recreate exit $UP_EXIT"
    exit 1
  fi
else
  log "Không service nào cần recreate — chạy 'up -d' kiểm tra service down/missing..."
  docker compose $COMPOSE_FLAGS up -d 2>&1 | tee -a "$LOG_FILE"
fi

# 4. Đợi API healthy
log "Đợi API healthy..."
HEALTHY=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "$GATEWAY_URL" >/dev/null 2>&1; then
    HEALTHY=1; break
  fi
  sleep 2
done
[ "$HEALTHY" = "1" ] && log "API responsive." || log "WARN: API chưa healthy sau 60s — kiểm tra docker logs coopeditor-api."

# 5. Verify SHA mới
AFTER_SHA="$(curl -fsS --max-time 5 "$GATEWAY_URL" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4)"
AFTER_SHA="${AFTER_SHA:-unknown}"
INDEX_CACHE="$(curl -fsSI --max-time 5 "$WEB_URL" 2>/dev/null | grep -i '^cache-control:' | tr -d '\r')"

if [ ${#TO_RECREATE[@]} -gt 0 ]; then
  log "✓ Update OK — API SHA: ${BEFORE_SHA:0:12} → ${AFTER_SHA:0:12}"
  log "  index.html ${INDEX_CACHE:-(no cache-control)}"
  log "  → Hard-reload trình duyệt (Ctrl+Shift+R / Cmd+Shift+R) để bỏ cache local."
else
  log "Không có image mới — đã ở SHA ${AFTER_SHA:0:12}."
fi

# 6. Dọn image cũ
docker image prune -f >/dev/null 2>&1
log "Xong."
