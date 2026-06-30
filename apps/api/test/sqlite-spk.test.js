import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let appDataDir = "";
let outputDir = "";
let dbPath = "";
let store;
let dbMod;
let projectId = "";
let userId = "";
let assetId = "";
let versionId = "";
let renditionId = "";
let workerRuntime;

function spawnAndCollect(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", (d) => process.stderr.write("[sqlite-spk] " + d));
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write("[sqlite-spk!] " + text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(file + " exited " + code + (stderr ? ": " + stderr.trim() : "")));
    });
  });
}

before(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), "coopeditor-spk-store-"));
  outputDir = join(appDataDir, "proxy");
  dbPath = join(appDataDir, "coopeditor.db");
  await mkdir(outputDir, { recursive: true });

  process.env.DATABASE_URL = "sqlite:" + dbPath;
  process.env.APP_DATA_DIR = appDataDir;
  process.env.OUTPUT_DIR = outputDir;

  await spawnAndCollect(fileURLToPath(new URL("../src/migrate.js", import.meta.url)), {
    DATABASE_URL: process.env.DATABASE_URL,
  });

  dbMod = await import("../src/db.js");
  store = await import("../src/store-index.js");
  workerRuntime = await import("../src/worker-runtime.js");
  await dbMod.initDb();

  const user = await store.upsertUserFromDsm({ uid: 1001, name: "minh", email: "minh@example.com" });
  userId = user.id;

  const project = await store.createProject({
    name: "529. Case S400 RT5080",
    client: "Anh Nam",
    ownerUserId: userId,
  });
  projectId = project.id;

  const asset = await store.addAssetFromImport({
    projectId,
    title: "C1967",
    codec: "H.264",
    sizeLabel: "268 MB",
    durationMs: 22000,
    nasPath: "/nas/502. Case G200/C1967.MP4",
    width: 3840,
    height: 2160,
    frameRate: 25,
    resolutionLabel: "4K",
    mimeType: "video/mp4",
  });
  assetId = asset.id;

  const versions = await store.listVersionsForAsset(assetId);
  versionId = versions[0].id;

  const renditions = await store.listRenditionsForVersion(versionId);
  renditionId = renditions.find((item) => item.label === "720p").id;

  await store.setRenditionStatus(renditionId, {
    status: "processing",
    progress: 55,
    hlsMasterUrl: "/hls/" + renditionId + "/master.m3u8",
  });
  await dbMod.db().query(
    `INSERT INTO transcode_jobs (rendition_id, status, enqueued_at, started_at, finished_at, attempts, max_attempts, next_run_at, error)
     VALUES ($1, 'failed', datetime('now', '-10 seconds'), datetime('now', '-8 seconds'), datetime('now', '-3 seconds'), 1, 5, datetime('now'), $2)`,
    [renditionId, "ffmpeg exit 254"],
  );

  await mkdir(join(outputDir, renditionId), { recursive: true });
  await writeFile(join(outputDir, renditionId, "master.m3u8"), "#EXTM3U\n#EXT-X-VERSION:3\n");
  await writeFile(join(outputDir, renditionId, "seg_0001.ts"), "ts");
});

after(async () => {
  await dbMod.close();
  delete process.env.DATABASE_URL;
  delete process.env.APP_DATA_DIR;
  delete process.env.OUTPUT_DIR;
});

test("SPK sqlite store can create projects and memberships", async () => {
  const projects = await store.listProjectsForUser(userId);
  assert.ok(projects.some((project) => project.id === projectId));

  const project = await store.getProject(projectId);
  assert.equal(project.name, "529. Case S400 RT5080");
  assert.equal(project.client, "Anh Nam");
  assert.deepEqual(project.teamUserIds, [userId]);

  const member = await store.getProjectMember(projectId, userId);
  assert.equal(member.role, "owner");
});

test("SPK sqlite store can list assets with derived proxy status", async () => {
  const assets = await store.listAssetsByProject(projectId);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].id, assetId);
  assert.equal(assets[0].status, "processing");
  assert.equal(assets[0].progress, 55);
  assert.equal(assets[0].resolutionLabel, "4K");
  assert.equal(assets[0].versionsCount, 1);
});

test("SPK sqlite store can read rendition job metadata and proxy storage ownership", async () => {
  const rendition = await store.getRendition(renditionId);
  assert.equal(rendition.status, "processing");
  assert.equal(rendition.progress, 55);
  assert.equal(rendition.lastJobStatus, "failed");
  assert.equal(rendition.lastError, "ffmpeg exit 254");

  const listed = await store.listRenditionsForVersion(versionId);
  assert.equal(listed.length, 2);
  const target = listed.find((item) => item.id === renditionId);
  assert.equal(target.lastJobStatus, "failed");

  const meta = await store.listRenditionProxyMeta([renditionId, "ghost_rendition"]);
  assert.equal(meta.length, 2);
  assert.equal(meta[0].renditionId, renditionId);
  assert.equal(meta[0].assetId, assetId);
  assert.equal(meta[0].projectId, projectId);
  assert.equal(meta[1].orphan, true);
});

test("SPK sqlite requestTranscode enqueues a real transcode job instead of simulating progress in API", async () => {
  await dbMod.db().query(`DELETE FROM transcode_jobs WHERE rendition_id = $1`, [renditionId]);
  await store.setRenditionStatus(renditionId, {
    status: "pending",
    progress: 0,
    hlsMasterUrl: null,
  });

  await workerRuntime.requestTranscode(renditionId);

  const refreshed = await store.getRendition(renditionId);
  assert.equal(refreshed.status, "pending");
  assert.equal(refreshed.progress, 0);

  const queued = await dbMod.db().query(
    `SELECT status, attempts, max_attempts FROM transcode_jobs WHERE rendition_id = $1 ORDER BY id DESC LIMIT 1`,
    [renditionId],
  );
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.rows[0].status, "queued");
});
