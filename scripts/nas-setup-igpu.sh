#!/bin/bash
# Coopeditor — one-time Intel iGPU setup on Synology / Linux NAS.
#
# Usage: bash scripts/nas-setup-igpu.sh
#
# Tự dò /dev/dri/renderD128, đọc GID đúng, ghi/cập-nhật
# docker-compose.override.yml bằng pure bash (không cần PyYAML — DSM Python
# 3 không có pip package sẵn). Idempotent: chạy lại OK, không duplicate.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log() { echo "[igpu-setup] $*"; }
fail() { echo "[igpu-setup][ERR] $*" >&2; exit 1; }

# 1. Dò /dev/dri
if [ ! -e /dev/dri/renderD128 ]; then
  fail "Không tìm thấy /dev/dri/renderD128 trên host. NAS này không có Intel iGPU hoặc kernel chưa nạp driver i915 — worker sẽ dùng CPU."
fi

GID="$(stat -c '%g' /dev/dri/renderD128 2>/dev/null || stat -f '%g' /dev/dri/renderD128)"
GROUP_NAME="$(getent group "$GID" 2>/dev/null | cut -d: -f1 || true)"
[ -z "$GROUP_NAME" ] && GROUP_NAME="$GID"
log "Phát hiện /dev/dri/renderD128 (GID=$GID, group=$GROUP_NAME)"

# 2. Quản lý docker-compose.override.yml bằng bash thuần.
# Strategy: bỏ khối có marker cũ (nếu có) + dòng "services: {}" rỗng, rồi
# append khối mới. Không đụng vào các block khác (vd GHCR PAT).
OVERRIDE="$ROOT/docker-compose.override.yml"
MARKER_BEGIN="# >>> coopeditor-igpu-auto (do nas-setup-igpu.sh tạo, đừng sửa tay) <<<"
MARKER_END="# <<< coopeditor-igpu-auto >>>"

if [ -f "$OVERRIDE" ]; then
  # Xóa khối cũ giữa 2 marker (idempotent re-run)
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    skip != 1 { print }
  ' "$OVERRIDE" > "$OVERRIDE.tmp"
  # Xóa "services: {}" rỗng (placeholder)
  sed -i.bak '/^services: {}\s*$/d' "$OVERRIDE.tmp"
  rm -f "$OVERRIDE.tmp.bak"
  mv "$OVERRIDE.tmp" "$OVERRIDE"
else
  : > "$OVERRIDE"
fi

# Nếu file đã có "services:" key ở top-level, ta CHỈ thêm worker dưới nó.
# Nếu chưa có, ta thêm cả "services:" + "worker:".
HAS_SERVICES=0
grep -qE '^services:[[:space:]]*$' "$OVERRIDE" && HAS_SERVICES=1

if [ "$HAS_SERVICES" = "1" ]; then
  # Có sẵn `services:` (vd block GHCR PAT cũng dưới services:). Chèn block
  # worker iGPU ngay sau dòng "services:" ở top-level.
  cat >> "$OVERRIDE" <<EOF

$MARKER_BEGIN
# Khối này chèn dưới services: đã có. Nếu services: đã có 'worker:' với
# devices/group_add khác, hãy merge tay — Docker Compose chỉ accept 1
# worker: key dưới services:.
#   worker:
#     devices: ["/dev/dri:/dev/dri"]
#     group_add: ["$GROUP_NAME"]
#     environment: { FFMPEG_HWACCEL: qsv }
$MARKER_END
EOF
  # Thực sự inject worker block (sau dòng services:)
  awk -v group="$GROUP_NAME" '
    /^services:[[:space:]]*$/ && !done {
      print
      print "  worker:"
      print "    devices:"
      print "      - /dev/dri:/dev/dri"
      print "    group_add:"
      print "      - \"" group "\""
      print "    environment:"
      print "      FFMPEG_HWACCEL: qsv"
      done=1
      next
    }
    { print }
  ' "$OVERRIDE" > "$OVERRIDE.tmp" && mv "$OVERRIDE.tmp" "$OVERRIDE"
else
  # Chưa có services: → thêm cả 2 cùng marker
  cat >> "$OVERRIDE" <<EOF
$MARKER_BEGIN
services:
  worker:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "$GROUP_NAME"
    environment:
      FFMPEG_HWACCEL: qsv
$MARKER_END
EOF
fi

log "Đã ghi cấu hình iGPU vào $OVERRIDE"

# 3. Validate YAML qua docker compose config (lỗi sớm còn hơn lỗi runtime)
if ! docker compose -f docker-compose.nas-auto.yml -f "$OVERRIDE" config >/dev/null 2>&1; then
  echo "---" >&2
  docker compose -f docker-compose.nas-auto.yml -f "$OVERRIDE" config 2>&1 | head -10 >&2
  fail "docker compose không parse được override.yml — xem lỗi phía trên. Sửa tay rồi chạy 'docker compose ... up -d worker'."
fi
log "YAML hợp lệ."

# 4. Khởi động lại worker
log "Restart worker container..."
docker compose -f docker-compose.nas-auto.yml up -d worker

# 5. Đợi rồi check probe
log "Đợi 8s rồi check hwaccel..."
sleep 8
docker compose -f docker-compose.nas-auto.yml logs worker --tail=30 | grep -iE "probe|hwaccel|starting" || true

log "Xong. Nếu thấy 'probe ok' hoặc 'switched to vaapi' → iGPU đã hoạt động."
log "Nếu thấy 'probe FAILED' → ffmpeg trong container không build với VAAPI; cần đổi base image worker."
