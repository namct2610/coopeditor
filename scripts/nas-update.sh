#!/bin/bash
# Coopeditor NAS auto-update — chạy 1 lệnh để pull image mới + rolling restart.
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
# Script idempotent: nếu không có image mới, exit nhanh; có image mới → pull,
# rolling restart, verify, log status. Không bao giờ touch volume data.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.nas-auto.yml}"
LOG_FILE="${LOG_FILE:-/tmp/coopeditor-update.log}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080/api/version}"

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

fail() {
  log "ERROR: $*"
  exit 1
}

# 1. Ghi nhận SHA đang chạy trước khi pull
BEFORE_SHA="$(curl -fsS --max-time 5 "$GATEWAY_URL" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4 || echo unknown)"
log "Bắt đầu update — SHA hiện tại: ${BEFORE_SHA:0:12}"

# 2. Pull image mới từ GHCR. docker compose pull idempotent: không có gì mới → 0 byte.
log "Pull image mới từ ghcr.io..."
docker compose -f "$COMPOSE_FILE" pull --quiet 2>&1 | tee -a "$LOG_FILE" || fail "docker compose pull thất bại"

# 3. Recreate container cho image vừa pull. Compose chỉ restart container nào image đổi.
log "Recreate container có image mới..."
docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tee -a "$LOG_FILE" || fail "docker compose up -d thất bại"

# 4. Đợi API healthy
log "Đợi API healthy..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "$GATEWAY_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# 5. Verify SHA mới
AFTER_SHA="$(curl -fsS --max-time 5 "$GATEWAY_URL" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4 || echo unknown)"
if [ "$AFTER_SHA" = "$BEFORE_SHA" ]; then
  log "Không có image mới — đã ở SHA ${AFTER_SHA:0:12}."
else
  log "✓ Update OK — SHA mới: ${AFTER_SHA:0:12} (cũ: ${BEFORE_SHA:0:12})"
fi

# 6. Dọn image cũ để khỏi đầy disk (tuỳ chọn, an toàn)
docker image prune -f >/dev/null 2>&1 || true

log "Xong."
