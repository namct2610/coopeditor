#!/bin/bash
# Pack synology/spk-src/ into a .spk file for the given arch. Idempotent —
# safe to run from CI or locally on a Mac/Linux box (no NAS required).
#
# Usage:
#   synology/build-spk.sh <arch> [version]
#
# Where <arch> is one of: x86_64, aarch64
#
# Outputs:
#   synology/build/coopeditor-<arch>-<version>.spk

set -euo pipefail

ARCH="${1:?arch required (x86_64 / aarch64)}"
VERSION="${2:-0.0.0-dev}"
SHA="${BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
BUILT_AT="${BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/synology/spk-src"
OUT_DIR="${ROOT}/synology/build"
STAGE="${OUT_DIR}/stage-${ARCH}"
SPK_OUT="${OUT_DIR}/coopeditor-${ARCH}-${VERSION}.spk"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT_DIR"

# 1. Copy SPK skeleton into stage.
cp -R "${SRC}/conf" "${SRC}/scripts" "${SRC}/WIZARD_UIFILES" "$STAGE/"
chmod 755 "$STAGE"/scripts/*

# 2. Substitute INFO tokens.
sed \
  -e "s|@VERSION@|${VERSION}|g" \
  -e "s|@ARCH@|${ARCH}|g" \
  -e "s|@PACKAGE_ICON@|PACKAGE_ICON.PNG|g" \
  -e "s|@PACKAGE_ICON_256@|PACKAGE_ICON_256.PNG|g" \
  -e "s|@BUILT_AT@|${BUILT_AT}|g" \
  -e "s|@BUILD_SHA@|${SHA}|g" \
  "${SRC}/INFO" > "${STAGE}/INFO"

# 3. Pack the app payload into package.tgz. The wizard + scripts unpack this
# into /var/packages/coopeditor/target/ at install time.
PKG_STAGE="${STAGE}/package"
mkdir -p "${PKG_STAGE}/app/apps" "${PKG_STAGE}/app/packages" "${PKG_STAGE}/lib/node/bin" "${PKG_STAGE}/lib/bin" "${PKG_STAGE}/bin" "${PKG_STAGE}/var"

# Node.js runtime (downloaded by CI from nodejs.org).
if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
  cp "$NODE_BIN" "${PKG_STAGE}/lib/node/bin/node"
else
  echo "WARN: NODE_BIN env not set. The .spk will not run without bundling node."
  echo "      Set NODE_BIN to a static node binary built for ${ARCH} before shipping."
fi

# ffmpeg fallback: bundled binary only if FFMPEG_BIN env points to one. Otherwise
# we rely on DSM's CodecPack/target/bin/ffmpeg at runtime.
if [ -n "${FFMPEG_BIN:-}" ] && [ -x "$FFMPEG_BIN" ]; then
  cp "$FFMPEG_BIN" "${PKG_STAGE}/lib/bin/ffmpeg"
  chmod +x "${PKG_STAGE}/lib/bin/ffmpeg"
fi

# App sources. We copy minimally — apps/api, apps/worker, apps/web/src,
# packages/contracts, package.json + lockfile. Run `pnpm install --prod` later.
rsync -a --exclude node_modules --exclude test --exclude '*.test.js' \
  "${ROOT}/apps/api" "${PKG_STAGE}/app/apps/"
rsync -a --exclude node_modules --exclude test --exclude '*.test.js' \
  "${ROOT}/apps/worker" "${PKG_STAGE}/app/apps/"
mkdir -p "${PKG_STAGE}/app/apps/web/src"
rsync -a "${ROOT}/apps/web/src/static" "${PKG_STAGE}/app/apps/web/src/"
cp "${ROOT}/apps/web/src/dev-server.js" "${PKG_STAGE}/app/apps/web/src/"
rsync -a --exclude node_modules \
  "${ROOT}/packages" "${PKG_STAGE}/app/"
cp "${ROOT}/package.json" "${ROOT}/pnpm-workspace.yaml" "${PKG_STAGE}/app/" 2>/dev/null || true
cp "${ROOT}/release.json" "${PKG_STAGE}/app/" 2>/dev/null || true

# Install production deps inside the staged app dir so the SPK ships
# self-contained node_modules. CI step does this; locally, expect pnpm.
if [ "${SKIP_DEPS:-0}" != "1" ]; then
  echo "Installing production deps into ${PKG_STAGE}/app …"
  (cd "${PKG_STAGE}/app" && pnpm install --prod --no-frozen-lockfile 2>&1 | tail -5) || \
    echo "WARN: pnpm install failed. The SPK will not run without node_modules."
fi

# Tiny launcher shim
cat > "${PKG_STAGE}/bin/coopeditor" <<'EOF'
#!/bin/sh
exec /var/packages/coopeditor/target/lib/node/bin/node /var/packages/coopeditor/target/app/apps/api/src/bootstrap.js "$@"
EOF
chmod +x "${PKG_STAGE}/bin/coopeditor"

# Pack package.tgz (DSM expects gz-tarball at SPK top level).
(cd "$PKG_STAGE" && tar -czf "${STAGE}/package.tgz" .)
rm -rf "$PKG_STAGE"

# 4. Placeholder icons. Replace with real PNGs before GA. SPK build tools
# accept any 72×72 / 256×256 PNG; here we synthesise via ImageMagick if
# present, otherwise drop in an empty placeholder.
for size in 72 256; do
  dest="${STAGE}/PACKAGE_ICON$([ "$size" = "256" ] && echo "_256").PNG"
  if command -v convert >/dev/null 2>&1; then
    convert -size ${size}x${size} xc:'#6c5cf6' -fill white -gravity center -pointsize $((size/3)) -annotate +0+0 'C' "$dest"
  else
    # Minimal valid PNG (1×1 transparent). Replace before release.
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa3M\x1b\xa1\x00\x00\x00\x00IEND\xaeB`\x82' > "$dest"
  fi
done

# 5. Pack the SPK tarball. SPK is a plain tar of INFO + package.tgz + scripts.
(cd "$STAGE" && tar -cf "$SPK_OUT" INFO PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG package.tgz scripts WIZARD_UIFILES conf)
rm -rf "$STAGE"

echo "Built: $SPK_OUT"
ls -lh "$SPK_OUT"
