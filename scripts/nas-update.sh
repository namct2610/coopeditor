#!/bin/bash
# Coopeditor NAS auto-update — 1 lệnh để pull image mới + force restart.
#
# Cách dùng (bằng tay):
#   bash /volume1/docker/coopeditor/scripts/nas-update.sh
#
# Tự động hoá qua DSM Task Scheduler (gợi ý chạy 03:00 mỗi ngày):
#   Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script
#     User: root
#     Schedule: Daily 03:00
#     Run command: bash /volume1/docker/coopeditor/scripts/nas-update.sh
#
# Khác với "docker compose up -d" trần: script này luôn force-recreate 3
# container app (web/api/worker) nếu image digest đổi, kể cả khi Watchtower
# đã pull image trong nền (compose up không tự restart trong case đó).

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Tự dò compose file. Order ưu tiên: env override → nas-auto → nas-clean → mặc định.
# Người chạy có thể export COMPOSE_FILE="docker-compose.foo.yml" nếu layout khác.
COMPOSE_CANDIDATES=("${COMPOSE_FILE:-}" "docker-compose.nas-auto.yml" "docker-compose.nas-clean.yml" "docker-compose.yml")
COMPOSE_FILE=""
for f in "${COMPOSE_CANDIDATES[@]}"; do
  [ -z "$f" ] && continue
  if [ -f "$ROOT/$f" ]; then COMPOSE_FILE="$f"; break; fi
done

if [ -z "$COMPOSE_FILE" ]; then
  echo "ERROR: Không tìm thấy docker-compose.*.yml trong $ROOT" >&2
  echo "       Đã thử: ${COMPOSE_CANDIDATES[*]}" >&2
  echo "       Khắc phục:" >&2
  echo "         (1) cd vào thư mục có compose file rồi chạy script, HOẶC" >&2
  echo "         (2) COMPOSE_FILE=<tên-file>.yml bash scripts/nas-update.sh, HOẶC" >&2
  echo "         (3) git pull lại repo về $ROOT để có đủ file:" >&2
  echo "             cd $ROOT && git pull" >&2
  exit 1
fi

# Cờ -f cho mọi lệnh compose: luôn nạp override.yml nếu có để các tuỳ
# chỉnh local (iGPU, GHCR PAT, …) không bị bỏ qua khi pass -f explicit.
COMPOSE_FLAGS="-f $COMPOSE_FILE"
[ -f docker-compose.override.yml ] && COMPOSE_FLAGS="$COMPOSE_FLAGS -f docker-compose.override.yml"
LOG_FILE="${LOG_FILE:-/tmp/coopeditor-update.log}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080/api/version}"
WEB_URL="${WEB_URL:-http://127.0.0.1:8080/}"

APP_SERVICES=(web api worker)

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

fail() {
  log "ERROR: $*"
  exit 1
}

image_digest() {
  # In ra digest sha256 ngắn của image đang gắn với container `coopeditor-<svc>`.
  # Nếu container chưa tồn tại → "none".
  local svc="$1"
  local cid
  cid="$(docker compose $COMPOSE_FLAGS ps -q "$svc" 2>/dev/null || true)"
  if [ -z "$cid" ]; then echo "none"; return; fi
  docker inspect --format='{{.Image}}' "$cid" 2>/dev/null | sed 's|sha256:||' | cut -c1-12 || echo unknown
}

# 1. Snapshot SHA + image digest trước khi pull
set +o pipefail
BEFORE_SHA="$(curl -fsS --max-time 5 "$GATEWAY_URL" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4)"
set -o pipefail
BEFORE_SHA="${BEFORE_SHA:-unknown}"
declare -A BEFORE_DIGEST
for svc in "${APP_SERVICES[@]}"; do
  BEFORE_DIGEST[$svc]="$(image_digest "$svc")"
done
log "Compose file: $COMPOSE_FILE"
log "Bắt đầu update — API SHA: ${BEFORE_SHA:0:12} · web=${BEFORE_DIGEST[web]} api=${BEFORE_DIGEST[api]} worker=${BEFORE_DIGEST[worker]}"

# 2. Pull image mới từ GHCR (idempotent).
log "Pull image mới từ ghcr.io..."
docker compose $COMPOSE_FLAGS pull --quiet 2>&1 | tee -a "$LOG_FILE" || fail "docker compose pull thất bại"

# 3. So digest container đang chạy với digest image:latest sau pull. Service
# nào lệch → force recreate. Compose "up -d" trần không làm được điều này
# nếu Watchtower đã pull xong rồi (lúc đó container vẫn ref digest cũ).
#
# QUAN TRỌNG: tạm tắt pipefail trong vòng for — grep không match → exit 1
# → pipefail propagate → set -e kill script âm thầm. Khôi phục pipefail
# ngay sau loop.
set +o pipefail
TO_RECREATE=()
for svc in "${APP_SERVICES[@]}"; do
  # Tên image:latest trên GHCR theo convention. Compose config format JSON
  # không có trên docker compose v1; grep trực tiếp ra image tag trong file.
  IMG="ghcr.io/namct2610/coopeditor-$svc:latest"
  if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    log "  $svc: chưa có image $IMG sau pull (skip)"
    continue
  fi
  LATEST_DIGEST="$(docker image inspect --format='{{.Id}}' "$IMG" 2>/dev/null | sed 's|sha256:||' | cut -c1-12)"
  LATEST_DIGEST="${LATEST_DIGEST:-unknown}"
  if [ "$LATEST_DIGEST" != "${BEFORE_DIGEST[$svc]}" ] && [ "$LATEST_DIGEST" != "unknown" ]; then
    log "→ $svc: ${BEFORE_DIGEST[$svc]} → $LATEST_DIGEST (sẽ recreate)"
    TO_RECREATE+=("$svc")
  else
    log "  $svc: digest không đổi ($LATEST_DIGEST)"
  fi
done
set -o pipefail

if [ ${#TO_RECREATE[@]} -gt 0 ]; then
  log "Force recreate: ${TO_RECREATE[*]}"
  docker compose $COMPOSE_FLAGS up -d --force-recreate --no-deps "${TO_RECREATE[@]}" 2>&1 | tee -a "$LOG_FILE" || fail "force recreate thất bại"
else
  # Vẫn chạy up -d để bắt service nào down hoặc config thay đổi.
  docker compose $COMPOSE_FLAGS up -d 2>&1 | tee -a "$LOG_FILE" || fail "docker compose up -d thất bại"
fi

# 4. Đợi API healthy
log "Đợi API healthy..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "$GATEWAY_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# 5. Verify SHA mới + check index.html không cache stale
set +o pipefail
AFTER_SHA="$(curl -fsS --max-time 5 "$GATEWAY_URL" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4)"
INDEX_CACHE="$(curl -fsSI --max-time 5 "$WEB_URL" 2>/dev/null | grep -i '^cache-control:' | tr -d '\r')"
set -o pipefail
AFTER_SHA="${AFTER_SHA:-unknown}"

if [ "$AFTER_SHA" = "$BEFORE_SHA" ] && [ ${#TO_RECREATE[@]} -eq 0 ]; then
  log "Không có image mới — đã ở SHA ${AFTER_SHA:0:12}."
else
  log "✓ Update OK — SHA mới: ${AFTER_SHA:0:12} (cũ: ${BEFORE_SHA:0:12})"
  log "  index.html ${INDEX_CACHE:-(no cache-control header)}"
  log "  → Hãy hard-reload trình duyệt (Ctrl+Shift+R hoặc Cmd+Shift+R) để bỏ cache local."
fi

# 6. Dọn image cũ để khỏi đầy disk (tuỳ chọn, an toàn)
docker image prune -f >/dev/null 2>&1 || true

log "Xong."
