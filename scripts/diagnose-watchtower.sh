#!/usr/bin/env bash
# Chẩn đoán vì sao Watchtower không tự update Frame Editor images.
# Chạy trên host (Synology / VPS) — không cần argument.
#
#   bash scripts/diagnose-watchtower.sh

set -u

OWNER="${OWNER:-namct2610}"   # đổi nếu GitHub owner khác
IMAGES=("frame-editor-api" "frame-editor-web" "frame-editor-worker")

ok()   { printf "✓ %s\n" "$*"; }
warn() { printf "⚠ %s\n" "$*"; }
fail() { printf "✗ %s\n" "$*"; }
hr()   { printf -- "─%.0s" {1..60}; echo; }

echo "Frame Editor — Watchtower diagnostic"
hr

# 1. Watchtower container running?
if docker ps --format '{{.Names}}' | grep -q '^frame-editor-watchtower$'; then
  ok "Watchtower container đang chạy"
else
  fail "Watchtower container KHÔNG chạy"
  echo "   → docker compose -f docker-compose.nas-auto.yml up -d watchtower"
fi

# 2. Watchtower log → có poll thật không?
echo; echo "Watchtower log (10 dòng cuối):"
docker logs --tail=10 frame-editor-watchtower 2>&1 | sed 's/^/   /'

# 3. App containers có label enable không?
echo; echo "App containers + Watchtower label:"
for img in "${IMAGES[@]}"; do
  cname="${img}"
  status="$(docker inspect -f '{{.State.Status}}' "$cname" 2>/dev/null || echo "missing")"
  enabled="$(docker inspect -f '{{ index .Config.Labels "com.centurylinklabs.watchtower.enable" }}' "$cname" 2>/dev/null || echo "")"
  if [ "$status" = "missing" ]; then
    fail "${cname}: container không tồn tại"
  elif [ "$enabled" = "true" ]; then
    ok "${cname}: status=$status label=true"
  else
    warn "${cname}: status=$status label=\"$enabled\" (Watchtower sẽ bỏ qua nếu LABEL_ENABLE)"
  fi
done

# 4. Image hiện tại — đang dùng digest nào?
echo; echo "Image digest đang chạy:"
for img in "${IMAGES[@]}"; do
  cname="${img}"
  imgref="$(docker inspect -f '{{.Config.Image}}' "$cname" 2>/dev/null || echo "")"
  digest="$(docker inspect -f '{{ index .RepoDigests 0 }}' "$cname" 2>/dev/null || echo "")"
  echo "   ${cname}: ${imgref:-<none>}"
  echo "       digest: ${digest:-<chưa có RepoDigest — image build local>}"
done

# 5. Test pull manual — nếu fail thì GHCR private hoặc auth thiếu
echo; echo "Thử pull image mới (cần auth cho GHCR private):"
for img in "${IMAGES[@]}"; do
  full="ghcr.io/${OWNER}/${img}:latest"
  if docker pull "$full" >/tmp/pull-${img}.log 2>&1; then
    ok "pull $full"
  else
    fail "pull $full thất bại"
    echo "   → log:"; sed 's/^/      /' /tmp/pull-${img}.log | head -5
    if grep -qi 'denied\|unauthorized\|not authorized' /tmp/pull-${img}.log; then
      echo
      echo "   🔑 Vấn đề: GHCR image private. 2 cách giải:"
      echo "      (a) Vào https://github.com/users/${OWNER}/packages, mở package ${img},"
      echo "          Package settings → Change visibility → Public."
      echo "      (b) Hoặc đăng nhập GHCR trên host:"
      echo "          echo 'YOUR_GITHUB_PAT' | docker login ghcr.io -u ${OWNER} --password-stdin"
      echo "          (PAT cần scope: read:packages)"
    fi
  fi
done

# 6. Latest GHCR commit vs local BUILD_SHA
echo; echo "Phiên bản API đang chạy:"
APIVER="$(docker exec frame-editor-api sh -c 'echo $BUILD_SHA' 2>/dev/null || echo "<container không chạy>")"
echo "   BUILD_SHA = ${APIVER}"
if [ "$APIVER" = "unknown" ] || [ -z "$APIVER" ]; then
  warn "BUILD_SHA không được set — image build cũ trước khi workflow thêm build-args."
  echo "   → đẩy 1 commit mới lên main để CI build lại, hoặc rebuild local."
fi

# 7. Watchtower force run ngay (skip 15 phút poll)
echo; hr
echo "Force update ngay:"
echo "   docker exec frame-editor-watchtower /watchtower --run-once --label-enable"
echo
echo "Xem log Watchtower realtime:"
echo "   docker logs -f frame-editor-watchtower"
hr
