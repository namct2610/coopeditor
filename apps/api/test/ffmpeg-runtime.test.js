import test from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFfmpegProbeCache, listFfmpegCandidates, resolveUsableFfmpeg } from "../src/ffmpeg-runtime.js";

async function writeFakeFfmpeg(name, { decoders = [], encoders = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "coopeditor-ffmpeg-"));
  const bin = join(dir, name);
  const script = `#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done
case "$last" in
  -decoders)
    cat <<'EOF'
${decoders.map((item) => " V..... " + item).join("\n")}
EOF
    ;;
  -encoders)
    cat <<'EOF'
${encoders.map((item) => " V..... " + item).join("\n").replace(/ V..... aac/g, " A..... aac")}
EOF
    ;;
  *)
    exit 0
    ;;
esac
`;
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

test("resolveUsableFfmpeg accepts a binary with proxy codecs", async () => {
  clearFfmpegProbeCache();
  const bin = await writeFakeFfmpeg("ffmpeg-ok", {
    decoders: ["h264"],
    encoders: ["aac", "libx264", "mjpeg"],
  });
  const resolved = await resolveUsableFfmpeg("proxy", { FFMPEG_PATH: bin });
  assert.equal(resolved.usable, true);
  assert.equal(resolved.path, bin);
});

test("resolveUsableFfmpeg rejects binaries missing h264 decoder for thumbnails", async () => {
  clearFfmpegProbeCache();
  const bin = await writeFakeFfmpeg("ffmpeg-no-h264", {
    decoders: ["mpeg4"],
    encoders: ["mjpeg"],
  });
  const resolved = await resolveUsableFfmpeg("thumbnail", {
    FFMPEG_PATH: bin,
    COOPEDITOR_FFMPEG_DISABLE_SYSTEM_LOOKUP: "1",
  });
  assert.equal(resolved.usable, false);
  assert.match(resolved.reason, /h264/i);
});

test("resolveUsableFfmpeg falls back from broken env binary to bundled binary", async () => {
  clearFfmpegProbeCache();
  const libDir = await mkdtemp(join(tmpdir(), "coopeditor-lib-"));
  const bundledDir = join(libDir, "bin");
  await mkdir(bundledDir, { recursive: true });
  const realBinDir = join(libDir, "bin");
  const bundledBin = await writeFakeFfmpeg("ffmpeg-bundled", {
    decoders: ["h264"],
    encoders: ["aac", "libx264"],
  });
  const targetBundled = join(realBinDir, "ffmpeg");
  await cp(bundledBin, targetBundled);
  await chmod(targetBundled, 0o755);
  const resolved = await resolveUsableFfmpeg("proxy", {
    FFMPEG_PATH: "/definitely-missing-ffmpeg",
    COOPEDITOR_LIB_DIR: libDir,
    COOPEDITOR_FFMPEG_DISABLE_SYSTEM_LOOKUP: "1",
  });
  assert.equal(resolved.usable, true);
  assert.equal(resolved.path, targetBundled);
  assert.equal(listFfmpegCandidates({
    FFMPEG_PATH: "/definitely-missing-ffmpeg",
    COOPEDITOR_LIB_DIR: libDir,
    COOPEDITOR_FFMPEG_DISABLE_SYSTEM_LOOKUP: "1",
  })[1].path, targetBundled);
});
