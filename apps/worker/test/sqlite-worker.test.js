import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const workerEntry = fileURLToPath(new URL("../src/worker.js", import.meta.url));
const migrateEntry = fileURLToPath(new URL("../../api/src/migrate.js", import.meta.url));

function spawnAndWait(file, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      reject(new Error(file + " timed out\nSTDOUT:\n" + stdout + "\nSTDERR:\n" + stderr));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(file + " exited " + code + "\nSTDOUT:\n" + stdout + "\nSTDERR:\n" + stderr));
    });
  });
}

test("sqlite worker claims queued jobs concurrently without transaction conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-worker-sqlite-"));
  const appDataDir = join(root, "data");
  const mountRoot = join(root, "nas");
  const outputDir = join(appDataDir, "proxy");
  const dbPath = join(appDataDir, "coopeditor.db");
  const ffmpegStub = join(root, "fake-ffmpeg.sh");
  await mkdir(appDataDir, { recursive: true });
  await mkdir(mountRoot, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(mountRoot, "clip.mp4"), "fake video");
  await writeFile(ffmpegStub, `#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done
mkdir -p "$(dirname "$last")"
printf '#EXTM3U\n#EXT-X-VERSION:3\n' > "$last"
printf 'ts' > "$(dirname "$last")/seg_0001.ts"
exit 0
`);
  await chmod(ffmpegStub, 0o755);

  const baseEnv = {
    DATABASE_URL: "sqlite:" + dbPath,
    APP_DATA_DIR: appDataDir,
    OUTPUT_DIR: outputDir,
    DSM_MOUNT_ROOT: mountRoot,
    DSM_LIBRARY_ROOT: "/",
    FFMPEG_PATH: ffmpegStub,
    EVENT_BUS_DRIVER: "none",
    WORKER_CONCURRENCY: "2",
    WORKER_AUTOSCALE_THRESHOLD: "5",
    WORKER_AUTOSCALE_STEP: "1",
    WORKER_MAX_CONCURRENCY: "2",
  };
  Object.assign(process.env, baseEnv);

  await spawnAndWait(migrateEntry, baseEnv);

  const dbMod = await import("../../api/src/db.js");
  await dbMod.initDb();
  const store = await import("../../api/src/store-index.js");

  const user = await store.upsertUserFromDsm({ uid: 1001, name: "Minh", email: "minh@example.com" });
  const project = await store.createProject({ name: "Proxy test", client: "Anh Nam", ownerUserId: user.id });
  const asset = await store.addAssetFromImport({
    projectId: project.id,
    title: "C1967",
    codec: "H.264",
    sizeLabel: "268 MB",
    durationMs: 22000,
    nasPath: "/clip.mp4",
    width: 3840,
    height: 2160,
    frameRate: 25,
    resolutionLabel: "4K",
    mimeType: "video/mp4",
  });
  const versions = await store.listVersionsForAsset(asset.id);
  const renditions = await store.listRenditionsForVersion(versions[0].id);
  const targetRenditions = renditions.filter((item) => item.height === 720 || item.height === 1080);
  assert.equal(targetRenditions.length, 2, "expected seeded 720p + 1080p renditions");
  for (const rendition of targetRenditions) {
    await store.enqueueTranscode(rendition.id);
  }

  const child = spawn(process.execPath, [workerEntry], {
    env: { ...process.env, ...baseEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const startedBothJobs = targetRenditions.every((rendition) => logs.includes("rendition " + rendition.id + " mode ffmpeg-only"));
      const noSqliteConflict = !/cannot start a transaction within a transaction|cannot commit - no transaction is active/i.test(logs);
      if (startedBothJobs && noSqliteConflict) {
        assert.doesNotMatch(logs, /cannot start a transaction within a transaction|cannot commit - no transaction is active/i);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("worker did not claim sqlite transcode jobs cleanly\n" + logs);
  } finally {
    try { child.kill("SIGTERM"); } catch (_) {}
    await dbMod.close();
    for (const key of Object.keys(baseEnv)) delete process.env[key];
  }
});

test("sqlite worker resolves ffmpeg-only output dir per rendition", async () => {
  const { resolveFfmpegOutputDir } = await import("../src/output-paths.js");
  assert.equal(
    resolveFfmpegOutputDir("/var/packages/coopeditor/var/proxy", "imp_56234c96_v1_720p"),
    join("/var/packages/coopeditor/var/proxy", "imp_56234c96_v1_720p"),
  );
  assert.equal(
    resolveFfmpegOutputDir("", "imp_56234c96_v1_1080p"),
    join(tmpdir(), "co-out", "imp_56234c96_v1_1080p"),
  );
});
