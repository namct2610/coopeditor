#!/bin/bash
# One-liner SPK installer. Designed to be piped through sudo bash:
#
#   curl -fsSL https://raw.githubusercontent.com/namct2610/coopeditor/main/synology/install-spk.sh \
#     | sudo bash
#
# Defaults:
#   - ARCH=auto  → detect NAS CPU arch automatically
#   - CHANNEL=rc → prefer the newest RC release that contains a matching SPK
#
# Common overrides:
#   ARCH=aarch64 TAG=v1.0.0-spk-rc19 bash install-spk.sh
#   SPK_URL=https://github.com/<owner>/<repo>/releases/download/<tag>/coopeditor-aarch64-1.0.0-spk-rc19.spk bash install-spk.sh
#   SPK_FILE=/volume1/public/coopeditor-aarch64-1.0.0-spk-rc19.spk bash install-spk.sh

set -eu

ARCH="${ARCH:-auto}"
TAG="${TAG:-}"
REPO="${REPO:-namct2610/coopeditor}"
CHANNEL="${CHANNEL:-rc}"
PKG="${PKG:-coopeditor}"
SPK_URL="${SPK_URL:-}"
SPK_FILE="${SPK_FILE:-}"
API_PORT="${API_PORT:-13000}"
TMP_DIR="${TMP_DIR:-/tmp}"

log() {
  echo "==> $*"
}

warn() {
  echo "WARN: $*" >&2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

detect_arch() {
  local machine
  machine="$(uname -m 2>/dev/null || echo unknown)"
  case "$machine" in
    x86_64|amd64) echo "x86_64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *)
      fail "không tự nhận được ARCH từ uname -m='${machine}'. Hãy truyền ARCH=x86_64 hoặc ARCH=aarch64."
      ;;
  esac
}

release_list_json() {
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "User-Agent: coopeditor-install-spk" \
    "https://api.github.com/repos/${REPO}/releases?per_page=30"
}

require_valid_json() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    sys.stderr.write("empty response from GitHub API\n")
    raise SystemExit(1)
try:
    data = json.loads(raw)
except Exception as exc:
    sys.stderr.write(f"invalid JSON from GitHub API: {exc}\n")
    raise SystemExit(1)
if isinstance(data, dict) and data.get("message"):
    sys.stderr.write(str(data.get("message")) + "\n")
    raise SystemExit(1)
'
}

resolve_latest_tag() {
  local json asset_regex selected
  json="$(release_list_json)"
  require_valid_json "$json" || fail "GitHub API trả về dữ liệu không hợp lệ khi đọc danh sách release. Nếu đang bị rate-limit, thử lại sau hoặc truyền TAG=... trực tiếp."
  asset_regex="coopeditor-${ARCH}-[^\"]+\\.spk"
  selected="$(printf '%s' "$json" | python3 -c '
import json, re, sys

channel = sys.argv[1]
asset_regex = re.compile(sys.argv[2])
releases = json.loads(sys.stdin.read())

def wanted(tag: str) -> bool:
    t = (tag or "").lower()
    if channel == "stable":
        return "-spk-rc" not in t and "-rc" not in t
    if channel == "rc":
        return "-spk-rc" in t or "-rc" in t
    return True

for rel in releases:
    tag = rel.get("tag_name") or ""
    if not wanted(tag):
        continue
    assets = rel.get("assets") or []
    if any(asset_regex.search((a.get("name") or "")) for a in assets):
        print(tag)
        break
' "$CHANNEL" "$asset_regex")"
  [ -n "$selected" ] || fail "không tìm thấy release phù hợp cho ARCH=${ARCH}, CHANNEL=${CHANNEL}. Có thể truyền TAG=... hoặc SPK_URL=... trực tiếp."
  printf '%s' "$selected"
}

resolve_asset_url_from_tag() {
  local version json url
  version="${TAG#v}"
  json="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "User-Agent: coopeditor-install-spk" \
    "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
  require_valid_json "$json" || fail "Không đọc được metadata release cho TAG=${TAG}. Kiểm tra tag có tồn tại chưa hoặc truyền SPK_URL trực tiếp."
  url="$(printf '%s' "$json" | python3 -c '
import json, sys

want = sys.argv[1]
release = json.loads(sys.stdin.read())
for asset in release.get("assets") or []:
    if asset.get("name") == want:
        print(asset.get("browser_download_url") or "")
        break
' "coopeditor-${ARCH}-${version}.spk")"
  [ -n "$url" ] || fail "tag ${TAG} tồn tại nhưng không có asset coopeditor-${ARCH}-${version}.spk"
  printf '%s' "$url"
}

wait_for_api() {
  local i
  for i in $(seq 1 20); do
    sleep 2
    if curl -fsS --max-time 1 "http://127.0.0.1:${API_PORT}/api/version" >/dev/null 2>&1; then
      log "API up after ${i} attempt(s)"
      return 0
    fi
  done
  warn "API chưa phản hồi ở cổng ${API_PORT} sau khi start package."
  return 1
}

if [ "$ARCH" = "auto" ]; then
  ARCH="$(detect_arch)"
fi

TMP_SPK=""

if [ -n "$SPK_FILE" ]; then
  [ -f "$SPK_FILE" ] || fail "không tìm thấy SPK_FILE=${SPK_FILE}"
  TMP_SPK="$SPK_FILE"
  log "Using local SPK file"
  echo "    file:   ${TMP_SPK}"
elif [ -n "$SPK_URL" ]; then
  TMP_SPK="${TMP_DIR}/coopeditor-install-${ARCH}-$$.spk"
  log "Downloading explicit SPK_URL"
  echo "    arch:   ${ARCH}"
  echo "    url:    ${SPK_URL}"
  curl -fsSL --retry 3 -o "$TMP_SPK" "$SPK_URL"
else
  if [ -z "$TAG" ]; then
    log "Resolving latest ${CHANNEL} SPK release tag from GitHub …"
    TAG="$(resolve_latest_tag)"
  fi
  SPK_URL="$(resolve_asset_url_from_tag)"
  TMP_SPK="${TMP_DIR}/coopeditor-install-${ARCH}-$$.spk"
  log "Downloading release asset"
  echo "    tag:    ${TAG}"
  echo "    arch:   ${ARCH}"
  echo "    url:    ${SPK_URL}"
  curl -fsSL --retry 3 -o "$TMP_SPK" "$SPK_URL"
fi

[ -s "$TMP_SPK" ] || fail "SPK file rỗng hoặc tải thất bại: ${TMP_SPK}"

echo ""
log "Coopeditor SPK installer"
echo "    package: ${PKG}"
echo "    arch:    ${ARCH}"
echo "    source:  ${TMP_SPK}"
echo ""

if synopkg status "$PKG" >/dev/null 2>&1; then
  log "Stopping existing ${PKG} …"
  synopkg stop "$PKG" >/dev/null 2>&1 || true
fi

log "synopkg install …"
synopkg install "$TMP_SPK"

log "Starting service …"
synopkg start "$PKG" 2>&1 || true
wait_for_api || true

echo ""
log "Smoke test"
STATUS_JSON="$(synopkg status "$PKG" 2>/dev/null || echo '{}')"
echo "    status: $STATUS_JSON"
echo ""
echo "    /api/version:"
curl -fsS "http://127.0.0.1:${API_PORT}/api/version" 2>&1 || echo "    (no response)"
echo ""

log "Tail of service log:"
tail -25 "/var/packages/${PKG}/var/log/${PKG}.log" 2>/dev/null || echo "    (log not yet created)"

echo ""
LAN_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname)"
log "Done. Open http://${LAN_IP}:${API_PORT}/ in a browser."
