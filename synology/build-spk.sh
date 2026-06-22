#!/bin/bash
# Pack synology/spk-src/ into a .spk file for the given arch. Runs from CI
# or locally on a Mac/Linux box. Cross-arch native bindings (better-sqlite3)
# are fetched via prebuild-install instead of being compiled here.
#
# Usage:
#   synology/build-spk.sh <arch> [version]
#
# Where <arch> is one of: x86_64, aarch64
#
# Outputs:
#   synology/build/coopeditor-<arch>-<version>.spk
#
# Required env (CI):
#   NODE_BIN          — path to a node binary built for the target arch.
#                       The workflow downloads from nodejs.org/dist.
#
# Optional env:
#   FFMPEG_BIN        — path to a static ffmpeg binary for the target arch.
#                       Without it, the SPK at runtime falls back to DSM's
#                       /var/packages/CodecPack/target/bin/ffmpeg.
#   SKIP_DEPS=1       — skip `npm install` inside the staged dir. Useful for
#                       smoke-testing the packaging logic without the slow
#                       deps install.
#   PNG72 / PNG256    — paths to real package icons. Otherwise placeholders.

set -euo pipefail

ARCH="${1:?arch required (x86_64 / aarch64)}"
VERSION="${2:-0.0.0-dev}"
SHA="${BUILD_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
SHA_SHORT="${SHA:0:7}"
BUILT_AT="${BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# Map our arch label → npm target_arch (for prebuild-install) AND the
# DSM arch list that Package Center matches against. Synology uses CPU
# codenames in INFO's arch= field, NOT GNU triplets — passing "x86_64"
# causes DSM to reject the SPK with "Invalid file format" because no
# Synology model reports that string.
#
# Full lists below cover every 64-bit Synology NAS shipped 2017+ for
# x86_64 (most Plus/FS/DS+ models) and 2018+ for aarch64 (DS124, DS220j,
# RS422+, etc.). Older 32-bit ARM models (armv7) aren't supported because
# better-sqlite3 + Node 22 require 64-bit.
case "$ARCH" in
  x86_64)
    NPM_ARCH=x64
    DSM_ARCH_LIST="apollolake avoton braswell broadwell broadwellnk broadwellnkv2 broadwellntbap bromolow cedarview denverton epyc7002 geminilake geminilakenext grantley kvmx64 purley v1000"
    ;;
  aarch64)
    NPM_ARCH=arm64
    DSM_ARCH_LIST="armadaxp armada37xx armada38x alpine alpine4k rtd1296 rtd1619b monaco"
    ;;
  *) echo "ERROR: unknown arch '$ARCH' (need x86_64 / aarch64)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/synology/spk-src"
OUT_DIR="${ROOT}/synology/build"
STAGE="${OUT_DIR}/stage-${ARCH}"
SPK_OUT="${OUT_DIR}/coopeditor-${ARCH}-${VERSION}.spk"

echo "==> Building Coopeditor SPK"
echo "    arch:    ${ARCH} (npm_arch=${NPM_ARCH})"
echo "    version: ${VERSION}"
echo "    sha:     ${SHA_SHORT}"
echo "    out:     ${SPK_OUT}"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT_DIR"

# ============================================================================
# 1. Copy SPK skeleton (INFO, scripts, conf, WIZARD_UIFILES)
# ============================================================================
cp -R "${SRC}/conf" "${SRC}/scripts" "${SRC}/WIZARD_UIFILES" "$STAGE/"
chmod 755 "$STAGE"/scripts/*

# Substitute INFO tokens.
sed \
  -e "s|@VERSION@|${VERSION}|g" \
  -e "s|@ARCH@|${DSM_ARCH_LIST}|g" \
  -e "s|@PACKAGE_ICON@|PACKAGE_ICON.PNG|g" \
  -e "s|@PACKAGE_ICON_256@|PACKAGE_ICON_256.PNG|g" \
  -e "s|@BUILT_AT@|${BUILT_AT}|g" \
  -e "s|@BUILD_SHA@|${SHA_SHORT}|g" \
  "${SRC}/INFO" > "${STAGE}/INFO"

# ============================================================================
# 2. Build the payload tree under stage/package/
# ============================================================================
PKG_STAGE="${STAGE}/package"
mkdir -p \
  "${PKG_STAGE}/app/apps/api" \
  "${PKG_STAGE}/app/apps/worker" \
  "${PKG_STAGE}/app/apps/web/src" \
  "${PKG_STAGE}/app/packages" \
  "${PKG_STAGE}/lib/node/bin" \
  "${PKG_STAGE}/lib/bin" \
  "${PKG_STAGE}/bin" \
  "${PKG_STAGE}/var"

# 2a. Node.js runtime — must be the binary for the target arch.
if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
  cp "$NODE_BIN" "${PKG_STAGE}/lib/node/bin/node"
  chmod +x "${PKG_STAGE}/lib/node/bin/node"
  echo "==> Bundled Node runtime: $(basename "$NODE_BIN")"
else
  echo "WARN: NODE_BIN env not set. The .spk will install but won't start."
  echo "      For CI: download node-v22.x-linux-${NPM_ARCH}.tar.xz from nodejs.org and"
  echo "      point NODE_BIN at the extracted bin/node before running this script."
fi

# 2b. ffmpeg fallback binary — only embedded when explicitly provided. Most
# DSMs ship CodecPack already.
if [ -n "${FFMPEG_BIN:-}" ] && [ -x "$FFMPEG_BIN" ]; then
  cp "$FFMPEG_BIN" "${PKG_STAGE}/lib/bin/ffmpeg"
  chmod +x "${PKG_STAGE}/lib/bin/ffmpeg"
  echo "==> Bundled ffmpeg: $(basename "$FFMPEG_BIN")"
fi

# 2c. App sources. Trim tests, dev-only files, host node_modules.
rsync -a \
  --exclude node_modules \
  --exclude test \
  --exclude 'test/' \
  --exclude '*.test.js' \
  --exclude '.cache' \
  --exclude '.DS_Store' \
  "${ROOT}/apps/api/" "${PKG_STAGE}/app/apps/api/"

rsync -a \
  --exclude node_modules \
  --exclude test \
  --exclude '*.test.js' \
  "${ROOT}/apps/worker/" "${PKG_STAGE}/app/apps/worker/"

# Web: only the SPA shell — the inline web-spa.js inside api/src serves it,
# so we don't need apps/web/src/dev-server.js in the payload (kept for
# debugging at the cost of a few kB).
rsync -a "${ROOT}/apps/web/src/static/" "${PKG_STAGE}/app/apps/web/src/static/"
cp "${ROOT}/apps/web/src/dev-server.js" "${PKG_STAGE}/app/apps/web/src/" || true
cp "${ROOT}/apps/web/package.json" "${PKG_STAGE}/app/apps/web/" 2>/dev/null || true

# Shared packages (contracts).
rsync -a --exclude node_modules "${ROOT}/packages/" "${PKG_STAGE}/app/packages/"

# Top-level monorepo files needed by pnpm.
cp "${ROOT}/package.json" "${PKG_STAGE}/app/" 2>/dev/null || true
cp "${ROOT}/pnpm-workspace.yaml" "${PKG_STAGE}/app/" 2>/dev/null || true

# Stamp release.json with the commit sha + builtAt — same logic the GHCR
# workflow uses so the update-detection on the FE doesn't false-positive.
if [ -f "${ROOT}/release.json" ]; then
  python3 -c "
import json
with open('${ROOT}/release.json') as f: data = json.load(f)
data['sha'] = '${SHA}'
data['builtAt'] = '${BUILT_AT}'
with open('${PKG_STAGE}/app/release.json', 'w') as f: json.dump(data, f, indent=2, ensure_ascii=False)
"
fi

# 2d. Install production deps for the target arch. We use npm (not pnpm)
# because npm honours npm_config_target_arch for native bindings cleanly,
# whereas pnpm's behaviour around prebuilds across archs is fiddly. The
# resulting tree is a plain node_modules/ layout that better-sqlite3
# resolves from at runtime.
if [ "${SKIP_DEPS:-0}" != "1" ]; then
  echo "==> Installing production deps (target arch: ${NPM_ARCH})"
  pushd "${PKG_STAGE}/app/apps/api" >/dev/null
  # Force prebuild-install to grab the linux-${NPM_ARCH} binary for native
  # modules (currently only better-sqlite3 ships natives in our tree).
  npm_config_target_arch="${NPM_ARCH}" \
  npm_config_target_platform="linux" \
  npm_config_target_libc="glibc" \
  npm_config_build_from_source=false \
  npm install --omit=dev --no-audit --no-fund --no-package-lock 2>&1 | tail -8
  popd >/dev/null
  # Same for worker (no natives currently, fast).
  pushd "${PKG_STAGE}/app/apps/worker" >/dev/null
  npm_config_target_arch="${NPM_ARCH}" \
  npm install --omit=dev --no-audit --no-fund --no-package-lock 2>&1 | tail -5
  popd >/dev/null
fi

# 2e. Tiny launcher shim used by /usr/syno/bin/coopeditor wrappers (rare).
cat > "${PKG_STAGE}/bin/coopeditor" <<'EOF'
#!/bin/sh
exec /var/packages/coopeditor/target/lib/node/bin/node /var/packages/coopeditor/target/app/apps/api/src/bootstrap.js "$@"
EOF
chmod +x "${PKG_STAGE}/bin/coopeditor"

# Pack package.tgz. DSM unpacks this into /var/packages/coopeditor/target/.
echo "==> Packing payload"
(cd "$PKG_STAGE" && tar -czf "${STAGE}/package.tgz" .)
PAYLOAD_BYTES=$(stat -f%z "${STAGE}/package.tgz" 2>/dev/null || stat -c%s "${STAGE}/package.tgz")
echo "    package.tgz: $((PAYLOAD_BYTES / 1024)) KB"
rm -rf "$PKG_STAGE"

# ============================================================================
# 3. Icons — real 72/256 PNGs are committed at synology/spk-src/. CI builds
#    use those directly. Caller can override with PNG72 / PNG256 env vars.
# ============================================================================
if [ -n "${PNG72:-}" ] && [ -f "$PNG72" ]; then
  cp "$PNG72" "${STAGE}/PACKAGE_ICON.PNG"
elif [ -f "${SRC}/PACKAGE_ICON.PNG" ]; then
  cp "${SRC}/PACKAGE_ICON.PNG" "${STAGE}/PACKAGE_ICON.PNG"
else
  echo "ERROR: no PACKAGE_ICON.PNG found at ${SRC}/ and PNG72 not set" >&2
  exit 1
fi
if [ -n "${PNG256:-}" ] && [ -f "$PNG256" ]; then
  cp "$PNG256" "${STAGE}/PACKAGE_ICON_256.PNG"
elif [ -f "${SRC}/PACKAGE_ICON_256.PNG" ]; then
  cp "${SRC}/PACKAGE_ICON_256.PNG" "${STAGE}/PACKAGE_ICON_256.PNG"
else
  cp "${STAGE}/PACKAGE_ICON.PNG" "${STAGE}/PACKAGE_ICON_256.PNG"
fi

# ============================================================================
# 4. Pack the outer SPK tarball. Format: a plain tar (NOT gzipped) of
#    INFO + icons + package.tgz + scripts/ + WIZARD_UIFILES/ + conf/.
#    DSM validates against ustar tar layout — macOS default `tar -cf` uses
#    pax-extended format which DSM (sometimes) refuses. Force --format=ustar
#    plus --no-xattrs / --no-mac-metadata where the host supports it.
# ============================================================================
echo "==> Packing .spk"
TAR_FLAGS="--format=ustar"
# macOS bsdtar accepts --no-mac-metadata; GNU tar doesn't, so probe before
# adding. Both accept --format=ustar.
if tar --no-mac-metadata --version >/dev/null 2>&1; then
  TAR_FLAGS="$TAR_FLAGS --no-mac-metadata"
fi
(cd "$STAGE" && tar -cf "$SPK_OUT" $TAR_FLAGS \
  INFO \
  PACKAGE_ICON.PNG \
  PACKAGE_ICON_256.PNG \
  package.tgz \
  scripts \
  WIZARD_UIFILES \
  conf)
rm -rf "$STAGE"

SPK_BYTES=$(stat -f%z "$SPK_OUT" 2>/dev/null || stat -c%s "$SPK_OUT")
echo ""
echo "==> Built: $SPK_OUT"
echo "    size: $((SPK_BYTES / 1024)) KB"
