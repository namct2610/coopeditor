#!/bin/bash
# Coopeditor — one-time Intel iGPU setup on Synology / Linux NAS.
#
# Usage: bash scripts/nas-setup-igpu.sh
#
# Tự dò /dev/dri/renderD128, đọc GID đúng, ghi/cập-nhật
# docker-compose.override.yml để worker container có quyền dùng iGPU
# (Intel QuickSync / VAAPI). Giữ nguyên các block khác (vd GHCR PAT) đã có
# trong override.yml.
#
# Script idempotent: chạy lại nhiều lần OK, không nhân đôi cấu hình.

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

# 2. Chuẩn bị override.yml
OVERRIDE="$ROOT/docker-compose.override.yml"
[ -f "$OVERRIDE" ] || { log "Tạo mới $OVERRIDE"; echo "services: {}" > "$OVERRIDE"; }

# 3. Ghi block worker iGPU bằng Python YAML (an toàn hơn sed). Python có sẵn trên DSM.
python3 - "$OVERRIDE" "$GID" "$GROUP_NAME" <<'PY'
import sys, os
override_path, gid, group_name = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    import yaml
except ImportError:
    # Fallback: pip install pyyaml — DSM Python 3 thường có sẵn yaml. Nếu
    # không, dùng trình ghi thủ công đơn giản.
    yaml = None

if yaml is None:
    print("[igpu-setup] PyYAML không có — fallback append text. Vui lòng tự rà cẩn thận.")
    block = f"""
# >>> coopeditor-igpu-auto (do nas-setup-igpu.sh tạo, đừng sửa tay) <<<
services:
  worker:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "{group_name}"
    environment:
      FFMPEG_HWACCEL: qsv
# <<< coopeditor-igpu-auto >>>
"""
    with open(override_path, "a") as f:
        f.write(block)
    sys.exit(0)

with open(override_path) as f:
    doc = yaml.safe_load(f) or {}

if "services" not in doc or doc["services"] is None:
    doc["services"] = {}
worker = doc["services"].get("worker") or {}

worker["devices"] = ["/dev/dri:/dev/dri"]
worker["group_add"] = [group_name]
env = worker.get("environment") or {}
if isinstance(env, list):
    # convert list-form env to dict so we can merge cleanly
    env_dict = {}
    for entry in env:
        if "=" in entry:
            k, v = entry.split("=", 1)
            env_dict[k] = v
    env = env_dict
env["FFMPEG_HWACCEL"] = "qsv"
worker["environment"] = env
doc["services"]["worker"] = worker

with open(override_path, "w") as f:
    yaml.dump(doc, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

print("[igpu-setup] Đã ghi cấu hình iGPU vào", override_path)
PY

# 4. Khởi động lại worker để áp dụng
log "Restart worker container..."
docker compose -f docker-compose.nas-auto.yml up -d worker

# 5. Probe — đợi worker khởi động xong rồi đọc log
log "Đợi 8s rồi check hwaccel..."
sleep 8
docker compose -f docker-compose.nas-auto.yml logs worker --tail=30 | grep -iE "probe|hwaccel|starting" || true

log "Xong. Nếu thấy 'probe ok' hoặc 'switched to vaapi' → iGPU đã hoạt động."
