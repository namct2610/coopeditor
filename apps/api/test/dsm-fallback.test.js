import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("dsmListFolder falls back to mounted NAS when FileStation list_share fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-"));
  await mkdir(join(root, "Projects"));
  await writeFile(join(root, "clip.mov"), "demo");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/";
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?fallback=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.equal(listing.path, "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "Projects"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "clip.mov"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("mounted NAS listing hides non-video files and system folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-filter-"));
  await mkdir(join(root, "@eaDir"));
  await mkdir(join(root, "Clips"));
  await writeFile(join(root, "clip.mp4"), "demo");
  await writeFile(join(root, "notes.odoc"), "doc");
  await writeFile(join(root, "cover.jpg"), "img");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/";
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?filter=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "Clips"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "clip.mp4"));
    assert.ok(!listing.entries.some((entry) => entry.name === "notes.odoc"));
    assert.ok(!listing.entries.some((entry) => entry.name === "cover.jpg"));
    assert.ok(!listing.entries.some((entry) => entry.name === "@eaDir"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("dev login still prefers mounted NAS over demo tree when a real mount is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-dev-mount-"));
  await mkdir(join(root, "PCNgon"));
  await writeFile(join(root, "C1967.MP4"), "demo");

  process.env.DSM_HOST = "";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/";
  process.env.DSM_DEV_LOGIN = "1";

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?dev-mounted=" + Date.now());
    const listing = await mod.dsmListFolder("sid-dev", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "PCNgon"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "C1967.MP4"));
    assert.ok(!listing.entries.some((entry) => entry.name === "Footage"));
  } finally {
    process.env.DSM_DEV_LOGIN = "";
  }
});

test("dev mode with mounted NAS does not silently fall back to demo when real path is broken", async () => {
  process.env.DSM_HOST = "";
  process.env.DSM_MOUNT_ROOT = "/definitely-missing-coopeditor-path";
  process.env.DSM_LIBRARY_ROOT = "/";
  process.env.DSM_DEV_LOGIN = "1";

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?dev-mounted-error=" + Date.now());
    await assert.rejects(
      () => mod.dsmListFolder("sid-dev", "/"),
      /Khong tim thay thu muc NAS da mount|Khong doc duoc thu muc NAS da mount/i,
    );
  } finally {
    process.env.DSM_DEV_LOGIN = "";
  }
});

test("mounted NAS listing can be rooted to a single shared folder via DSM library root", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-library-root-"));
  await mkdir(join(root, "PCNgon", "502. Case G200"), { recursive: true });
  await mkdir(join(root, "AnotherShare"), { recursive: true });
  await writeFile(join(root, "PCNgon", "C1967.MP4"), "demo");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/PCNgon";
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?library-root-listing=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "502. Case G200"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "C1967.MP4"));
    assert.ok(!listing.entries.some((entry) => entry.name === "PCNgon"));
    assert.ok(!listing.entries.some((entry) => entry.name === "AnotherShare"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("mounted NAS listing stays inside the shared folder when mount root already points directly to it", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-library-mounted-directly-"));
  await mkdir(join(root, "502. Case G200"), { recursive: true });
  await writeFile(join(root, "C1967.MP4"), "demo");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/PCNgon";
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?library-root-mounted-directly=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "502. Case G200"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "C1967.MP4"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("ensureVideoThumbnail retries with mjpeg when DSM ffmpeg disables image2 muxer", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-thumb-"));
  const fakeVideo = join(root, "C1967.MP4");
  const fakeFfmpeg = join(root, "fake-ffmpeg.sh");
  await writeFile(fakeVideo, "demo");
  await writeFile(fakeFfmpeg, `#!/bin/sh
set -eu
last=""
want_mjpeg=0
prev=""
mode=""
for arg in "$@"; do
  mode="$arg"
  if [ "$prev" = "-f" ] && [ "$arg" = "mjpeg" ]; then
    want_mjpeg=1
  fi
  prev="$arg"
  last="$arg"
done
if [ "$mode" = "-decoders" ]; then
  cat <<'EOF'
 V..... h264
EOF
  exit 0
fi
if [ "$mode" = "-encoders" ]; then
  cat <<'EOF'
 A..... aac
 V..... libx264
 V..... mjpeg
EOF
  exit 0
fi
if [ "$want_mjpeg" -ne 1 ]; then
  echo "Unable to find a suitable output format for '$last'" >&2
  exit 1
fi
printf 'JPEGDATA' > "$last"
`);
  await chmod(fakeFfmpeg, 0o755);

  process.env.DSM_HOST = "";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/";
  process.env.DSM_DEV_LOGIN = "1";
  process.env.FFMPEG_PATH = fakeFfmpeg;
  process.env.APP_DATA_DIR = join(root, "app-data");
  process.env.COOPEDITOR_FFMPEG_DISABLE_SYSTEM_LOOKUP = "1";

  const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?thumb-fallback=" + Date.now());
  const thumbPath = await mod.ensureVideoThumbnail("/C1967.MP4", "thumb:test", { seekMs: 1000, width: 640 });
  const body = await readFile(thumbPath, "utf8");
  assert.equal(body, "JPEGDATA");
});
