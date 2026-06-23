#!/bin/bash
# One-liner SPK installer. Designed to be piped through sudo bash:
#
#   curl -fsSL https://raw.githubusercontent.com/namct2610/coopeditor/main/synology/install-spk.sh \
#     | sudo bash
#
# Defaults: x86_64 arch, latest tag from GitHub Releases. Override:
#   ARCH=aarch64 TAG=v1.0.0-spk-rc11 bash install-spk.sh

set -eu

ARCH="${ARCH:-x86_64}"
TAG="${TAG:-}"
REPO="${REPO:-namct2610/coopeditor}"
PKG="coopeditor"

if [ -z "$TAG" ]; then
  echo "==> Resolving latest SPK release tag from GitHub …"
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20" \
    | grep -oE '"tag_name": *"v[0-9]+\.[0-9]+\.[0-9]+-spk-[^"]*"' \
    | head -1 | cut -d'"' -f4)"
  if [ -z "$TAG" ]; then
    echo "ERROR: could not resolve latest tag; pass TAG=v1.0.0-spk-rcN explicitly" >&2
    exit 1
  fi
fi

VERSION="${TAG#v}"
SPK_NAME="coopeditor-${ARCH}-${VERSION}.spk"
SPK_URL="https://github.com/${REPO}/releases/download/${TAG}/${SPK_NAME}"

echo "==> Coopeditor SPK installer"
echo "    tag:    ${TAG}"
echo "    arch:   ${ARCH}"
echo "    url:    ${SPK_URL}"
echo ""

# 1. Stop existing if installed (best-effort).
if synopkg status "$PKG" >/dev/null 2>&1; then
  echo "==> Stopping existing ${PKG} …"
  synopkg stop "$PKG" >/dev/null 2>&1 || true
fi

# 2. Download into /tmp.
echo "==> Downloading ${SPK_NAME} …"
TMP_SPK="/tmp/${SPK_NAME}"
curl -fsSL --retry 3 -o "$TMP_SPK" "$SPK_URL"

# 3. Install (in-place upgrade if already installed; fresh if not).
echo "==> synopkg install …"
synopkg install "$TMP_SPK"

# 4. Start. DSM sometimes auto-starts after upgrade and sometimes doesn't —
# always run start ourselves (it's a no-op if already running).
echo "==> Starting service …"
synopkg start "$PKG" 2>&1 || true
# Wait up to 30s for the API port to bind. Each retry is cheap; the loop
# exits as soon as /api/version responds.
for i in $(seq 1 15); do
  sleep 2
  if curl -fsS --max-time 1 "http://127.0.0.1:4000/api/version" >/dev/null 2>&1; then
    echo "==> API up after ${i} attempt(s)"
    break
  fi
done

# 5. Smoke test.
echo ""
echo "==> Smoke test"
STATUS_JSON="$(synopkg status "$PKG" 2>/dev/null || echo '{}')"
echo "    status: $STATUS_JSON"
echo ""
echo "    /api/version:"
curl -fsS http://127.0.0.1:4000/api/version 2>&1 || echo "    (no response)"
echo ""

echo "==> Tail of service log:"
tail -25 /var/packages/${PKG}/var/log/${PKG}.log 2>/dev/null || echo "    (log not yet created)"

echo ""
# Synology busybox `hostname` doesn't support -I. Try multiple portable fallbacks.
LAN_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname -i 2>/dev/null | awk '{print $1}')"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname)"
echo "==> Done. Open http://${LAN_IP}:4000/ in a browser."
