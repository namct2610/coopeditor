// Coopeditor transcode worker.
//
// Requires DATABASE_URL. Consumes rows from `transcode_jobs`, runs one of three modes
// per rendition, and reports progress by:
//   1. UPDATE renditions SET status, progress, hls_master_url
//   2. publish a cluster event (Postgres NOTIFY by default, Redis Streams when enabled)
// The API consumes that bus and forwards to SSE.
//
// Modes:
//   - sim  (default): tick progress every ~600ms; no ffmpeg required.
//   - ffmpeg-only:    FFMPEG_PATH set; runs ffmpeg → writes HLS to local OUTPUT_DIR.
//   - full:           FFMPEG_PATH + MINIO_* set; uploads HLS to MinIO.
//
// Env:
//   DATABASE_URL=postgres://...
//   FFMPEG_PATH=/usr/bin/ffmpeg              # optional
//   OUTPUT_DIR=/var/lib/coopeditor/hls     # for ffmpeg-only mode
//   MINIO_ENDPOINT=http://localhost:9000     # optional (enables full mode)
//   MINIO_BUCKET=coopeditor-proxy
//   MINIO_ACCESS_KEY=minio
//   MINIO_SECRET_KEY=minio123
//   MINIO_PUBLIC_URL=http://localhost:9000   # what the browser uses to fetch HLS
//   WORKER_CONCURRENCY=2

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import pg from "pg";
import { publishWorkerEvent, startWorkerEventBus, workerEventBusMode } from "./event-bus.js";
import { isPermanentTranscodeError, shouldAutoRequeueFailedJob } from "./error-policy.js";
import { computeTargetConcurrency, createScalingPolicy, shouldKeepWorkerAlive } from "./scaling.js";
import { resolveSourcePath } from "../../api/src/dsm.js";

if (!process.env.DATABASE_URL) { console.error("[worker] DATABASE_URL required"); process.exit(1); }

const FFMPEG_PATH = process.env.FFMPEG_PATH || "";
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "";
const scalingPolicy = createScalingPolicy(process.env);
const BASE_CONCURRENCY = scalingPolicy.baseConcurrency;
const RUNG_BITRATE = { 720: "3500k", 1080: "8000k" };

// "nvenc" → NVIDIA. "qsv" → Intel QuickSync (libmfx). "vaapi" → generic Linux
// VAAPI (works with Intel iGPU on Alpine where libmfx is missing). "" → CPU.
// We probe at startup with a 0.1s lavfi color clip; failed probes silently
// fall back. We also auto-escalate qsv→vaapi when qsv fails but /dev/dri
// exists — most Alpine ffmpeg builds ship VAAPI but not libmfx, so for Intel
// boxes VAAPI is the path that actually works.
let HW = (process.env.FFMPEG_HWACCEL || "").toLowerCase();
// "h264" (default) — all rungs use h264. "h265" — all rungs h265. "mixed" — 720p h264, 1080p h265.
const CODEC_LADDER = (process.env.FFMPEG_CODEC_LADDER || "h264").toLowerCase();
function codecForHeight(h) {
  if (CODEC_LADDER === "h265") return "h265";
  if (CODEC_LADDER === "mixed") return h >= 1080 ? "h265" : "h264";
  return "h264";
}

async function probeHwEncoder(hw) {
  if (!FFMPEG_PATH || !hw) return false;
  const enc = hw === "nvenc" ? "h264_nvenc" : hw === "qsv" ? "h264_qsv" : hw === "vaapi" ? "h264_vaapi" : null;
  if (!enc) return false;
  let pre, scaleFilter;
  if (hw === "nvenc") {
    pre = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
    scaleFilter = "scale_cuda=-2:240";
  } else if (hw === "qsv") {
    pre = ["-hwaccel", "qsv"];
    scaleFilter = "scale_qsv=-2:240";
  } else { // vaapi
    // For an sw-source probe (lavfi color clip) you must NOT pass
    // -hwaccel vaapi — that flag tells ffmpeg to use VAAPI for the decoder,
    // and there is no decoder for lavfi. The correct minimal probe is
    // just -vaapi_device + hwupload filter + the VAAPI encoder.
    pre = ["-vaapi_device", "/dev/dri/renderD128"];
    scaleFilter = "format=nv12,hwupload,scale_vaapi=-2:240";
  }
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    ...pre,
    "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1",
    "-vf", scaleFilter, "-c:v", enc, "-frames:v", 1,
    "-f", "null", "-",
  ].map(String);
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, args);
    let killed = false;
    const t = setTimeout(() => { killed = true; try { proc.kill("SIGKILL"); } catch (_) {} resolve(false); }, 5000);
    proc.on("error", () => { clearTimeout(t); resolve(false); });
    proc.on("close", (code) => { clearTimeout(t); if (killed) return; resolve(code === 0); });
  });
}

if (HW && FFMPEG_PATH) {
  let ok = await probeHwEncoder(HW);
  // Intel-on-Alpine: libmfx (h264_qsv) is rarely shipped, but VAAPI usually
  // is — auto-promote a failed qsv probe to vaapi before giving up.
  if (!ok && HW === "qsv") {
    console.log("[worker] hwaccel='qsv' probe failed — trying vaapi as fallback (Alpine ffmpeg usually ships VAAPI but not libmfx)…");
    if (await probeHwEncoder("vaapi")) {
      HW = "vaapi";
      ok = true;
      console.log("[worker] hwaccel switched to 'vaapi' — Intel iGPU will be used via VAAPI");
    }
  }
  if (!ok) {
    console.warn("[worker] hwaccel='" + HW + "' probe FAILED — encoder not usable (missing /dev/dri, wrong CPU, or codec libs absent). Falling back to CPU libx264. To silence this warning, unset FFMPEG_HWACCEL.");
    HW = "";
  } else if (HW === process.env.FFMPEG_HWACCEL) {
    console.log("[worker] hwaccel='" + HW + "' probe ok");
  }
}

const mode = FFMPEG_PATH && MINIO_ENDPOINT ? "full" : (FFMPEG_PATH ? "ffmpeg-only" : "sim");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: scalingPolicy.maxConcurrency + 2 });
const listenClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
await listenClient.connect();
await listenClient.query("LISTEN coopeditor_jobs");
listenClient.on("notification", () => wakeUp());

let wakeWaiters = [];
function wakeUp() { wakeWaiters.splice(0).forEach((r) => r()); }
function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); wakeWaiters.push(() => { clearTimeout(t); r(); }); }); }

let activeJobs = 0;
let desiredConcurrency = BASE_CONCURRENCY;
let runningSlots = 0;
let nextSlotId = 0;
let desiredPollInFlight = null;

await startWorkerEventBus().catch((err) => {
  console.error("[worker] event bus bootstrap failed:", err.message);
  process.exit(1);
});

// Auto-requeue at boot: any job that was orphaned mid-run (worker crashed,
// pod restarted, host rebooted) sits in status='running' forever otherwise.
// And jobs in status='failed' from a previous broken config (e.g. qsv on a
// box without /dev/dri) should get one fresh try with the new hwaccel path
// the moment the worker starts. The user shouldn't have to learn psql.
try {
  const r = await pool.query(`
    UPDATE transcode_jobs
       SET status='queued',
           attempts=0,
           error=NULL,
           next_run_at=now(),
           started_at=NULL
     WHERE status='running'
        OR (status='failed' AND (error IS NULL OR error = '' OR error !~* '(ENOENT|EACCES|not mounted|cannot read source path|khong tim thay|khong du quyen|ffmpeg exit 127|spawn .*ffmpeg)'))
        OR (status='queued' AND attempts >= max_attempts AND (error IS NULL OR error = '' OR error !~* '(ENOENT|EACCES|not mounted|cannot read source path|khong tim thay|khong du quyen|ffmpeg exit 127|spawn .*ffmpeg)'))
    RETURNING id
  `);
  if (r.rowCount > 0) {
    console.log("[worker] auto-requeued", r.rowCount, "stale/failed jobs on startup");
  }
} catch (err) {
  console.warn("[worker] auto-requeue at boot failed:", err.message);
}

console.log(
  "[worker] starting mode=" + mode +
  " hwaccel=" + (HW || "none") +
  " codec_ladder=" + CODEC_LADDER +
  " base_concurrency=" + BASE_CONCURRENCY +
  " autoscale_threshold=" + scalingPolicy.threshold +
  " max_concurrency=" + scalingPolicy.maxConcurrency +
  " event_bus=" + workerEventBusMode(),
);

function scaleBitrate(rate, factor) {
  const m = String(rate).match(/^(\d+)([kKmM]?)$/);
  if (!m) return rate;
  return Math.round(Number(m[1]) * factor) + m[2];
}

// --- MinIO (S3) clients (lazy, with georeplication support) ---
// Primary = MINIO_ENDPOINT. Replicas = comma-separated MINIO_REPLICA_ENDPOINTS.
// Each replica gets the same payload async; primary failure → job fails.
let s3Clients = null;
async function getS3Clients() {
  if (s3Clients) return s3Clients;
  const { S3Client } = await import("@aws-sdk/client-s3");
  const creds = { accessKeyId: process.env.MINIO_ACCESS_KEY || "minio", secretAccessKey: process.env.MINIO_SECRET_KEY || "minio123" };
  const mk = (endpoint) => new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: creds });
  const primary = mk(MINIO_ENDPOINT);
  const replicaUrls = (process.env.MINIO_REPLICA_ENDPOINTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const replicas = replicaUrls.map(mk);
  s3Clients = { primary, replicas, replicaUrls };
  if (replicaUrls.length) console.log("[worker] minio georeplication enabled, replicas:", replicaUrls.length);
  return s3Clients;
}
async function uploadFile(bucket, key, body, contentType) {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { primary, replicas, replicaUrls } = await getS3Clients();
  const cmd = () => new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
  // Primary is awaited (failure = job retry). Replicas are best-effort fire-and-forget.
  await primary.send(cmd());
  for (let i = 0; i < replicas.length; i++) {
    const r = replicas[i];
    const url = replicaUrls[i];
    r.send(cmd()).catch((err) => console.warn("[worker] replica upload failed:", url, key, err.message));
  }
}

async function notify(payload) { await publishWorkerEvent(pool, payload); }

async function projectUserIds(projectId) {
  return (await pool.query(`SELECT user_id FROM project_members WHERE project_id = $1 ORDER BY position`, [projectId])).rows.map((row) => row.user_id);
}

async function updateRendition(rid, patch) {
  const sets = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    const col = k === "hlsMasterUrl" ? "hls_master_url" : k;
    sets.push(col + " = $" + i++); vals.push(v);
  }
  vals.push(rid);
  await pool.query(`UPDATE renditions SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  const r = (await pool.query(`
    SELECT r.asset_version_id, a.project_id
      FROM renditions r
      JOIN asset_versions v ON v.id = r.asset_version_id
      JOIN assets a ON a.id = v.asset_id
     WHERE r.id = $1`, [rid])).rows[0];
  if (r) await notify({
    type: "rendition",
    id: rid,
    assetVersionId: r.asset_version_id,
    projectId: r.project_id,
    userIds: await projectUserIds(r.project_id),
    status: patch.status,
    progress: patch.progress,
  });
}

async function loadJob() {
  // claim one queued job whose backoff has expired
  const { rows } = await pool.query(`
    UPDATE transcode_jobs SET status='running', started_at=now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM transcode_jobs
      WHERE status='queued' AND next_run_at <= now()
      ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, rendition_id, attempts, max_attempts`);
  if (!rows.length) return null;
  const job = rows[0];
  const r = (await pool.query(`
    SELECT r.id, r.height, r.label, r.bitrate_kbps, r.asset_version_id, v.asset_id, a.nas_path, a.title
    FROM renditions r JOIN asset_versions v ON v.id = r.asset_version_id JOIN assets a ON a.id = v.asset_id
    WHERE r.id = $1`, [job.rendition_id])).rows[0];
  return { job, rendition: r };
}

async function currentQueueDepth() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS depth
      FROM transcode_jobs
     WHERE status = 'queued' AND next_run_at <= now()
  `);
  return rows[0] ? rows[0].depth : 0;
}

async function refreshDesiredConcurrency() {
  if (desiredPollInFlight) return desiredPollInFlight;
  desiredPollInFlight = (async () => {
    const depth = await currentQueueDepth();
    const next = computeTargetConcurrency(depth, scalingPolicy);
    if (next !== desiredConcurrency) {
      desiredConcurrency = next;
      console.log("[worker] autoscale depth=" + depth + " target_concurrency=" + desiredConcurrency);
    }
    return desiredConcurrency;
  })();
  try {
    return await desiredPollInFlight;
  } finally {
    desiredPollInFlight = null;
  }
}

async function finishJob(jobId, ok, errorMsg = null) {
  await pool.query(`UPDATE transcode_jobs SET status=$1, finished_at=now(), error=$3 WHERE id=$2`,
    [ok ? "done" : "failed", jobId, ok ? null : (errorMsg || null)]);
}

async function rescheduleJob(jobId, attempts, errorMsg) {
  // exponential backoff: 5s, 25s, 125s, ... capped at 10min
  const delaySec = Math.min(600, 5 * Math.pow(5, attempts - 1));
  await pool.query(`
    UPDATE transcode_jobs
    SET status='queued', error=$2, next_run_at = now() + ($3 || ' seconds')::interval, started_at=NULL
    WHERE id=$1`, [jobId, errorMsg || null, String(delaySec)]);
  console.log("[worker] job", jobId, "rescheduled in", delaySec, "s");
}

async function runSim(rid, assetVersionId) {
  let p = 4;
  while (p < 100) {
    p = Math.min(100, p + 6 + Math.floor(Math.random() * 5));
    await updateRendition(rid, { status: p >= 100 ? "ready" : "processing", progress: p, ...(p >= 100 ? { hlsMasterUrl: "/hls/" + rid + "/master.m3u8" } : {}) });
    if (p < 100) await new Promise((r) => setTimeout(r, 500));
  }
}

async function runFfmpeg(rendition) {
  // Source path: rendition.nas_path. Mode "full" uploads to MinIO; "ffmpeg-only" writes locally.
  const localSourcePath = resolveSourcePath(rendition.nas_path) || rendition.nas_path;
  try {
    await fs.stat(localSourcePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error("Source path not mounted in worker: " + localSourcePath + " (stored: " + rendition.nas_path + ")");
    }
    if (err && err.code === "EACCES") {
      throw new Error("Worker cannot read source path: " + localSourcePath + " (stored: " + rendition.nas_path + ")");
    }
    throw err;
  }
  const outDir = mode === "full" ? await fs.mkdtemp(join(tmpdir(), "co-")) : (process.env.OUTPUT_DIR || join(tmpdir(), "co-out", rendition.id));
  await fs.mkdir(outDir, { recursive: true });
  const bitrate = RUNG_BITRATE[rendition.height] || "3500k";
  const codec = codecForHeight(rendition.height);
  // h265 is ~30–40% more efficient; allow a slightly lower bitrate to bank the savings.
  const effectiveBitrate = codec === "h265" ? scaleBitrate(bitrate, 0.65) : bitrate;
  const pre = [];
  let videoArgs;
  if (HW === "nvenc") {
    pre.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
    const enc = codec === "h265" ? "hevc_nvenc" : "h264_nvenc";
    videoArgs = ["-vf", "scale_cuda=-2:" + rendition.height, "-c:v", enc, "-preset", "p4", "-b:v", effectiveBitrate, "-rc", "vbr", "-cq", "23"];
    if (codec === "h265") videoArgs.push("-tag:v", "hvc1");
  } else if (HW === "qsv") {
    pre.push("-hwaccel", "qsv");
    const enc = codec === "h265" ? "hevc_qsv" : "h264_qsv";
    videoArgs = ["-vf", "scale_qsv=-2:" + rendition.height, "-c:v", enc, "-b:v", effectiveBitrate];
    if (codec === "h265") videoArgs.push("-tag:v", "hvc1");
  } else if (HW === "vaapi") {
    // VAAPI on Intel iGPU: software-decode the input, upload frames to GPU,
    // scale + encode in hardware. -vaapi_device wires up /dev/dri/renderD128.
    pre.push("-vaapi_device", "/dev/dri/renderD128");
    const enc = codec === "h265" ? "hevc_vaapi" : "h264_vaapi";
    videoArgs = ["-vf", "format=nv12,hwupload,scale_vaapi=-2:" + rendition.height, "-c:v", enc, "-b:v", effectiveBitrate];
    if (codec === "h265") videoArgs.push("-tag:v", "hvc1");
  } else {
    const enc = codec === "h265" ? "libx265" : "libx264";
    videoArgs = ["-vf", "scale=-2:" + rendition.height, "-c:v", enc, "-preset", codec === "h265" ? "fast" : "veryfast", "-b:v", effectiveBitrate];
    if (codec === "h265") videoArgs.push("-tag:v", "hvc1");
  }
  const args = [
    "-y", ...pre, "-i", localSourcePath,
    ...videoArgs,
    "-c:a", "aac", "-b:a", "128k",
    "-hls_time", "4", "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(outDir, "seg_%04d.ts"),
    join(outDir, "master.m3u8"),
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let durSec = 0;
    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      const dm = s.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (dm) durSec = (+dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]));
      const tm = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (tm && durSec > 0) {
        const t = (+tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]));
        const p = Math.min(99, Math.round((t / durSec) * 100));
        updateRendition(rendition.id, { status: "processing", progress: p }).catch(() => {});
      }
    });
    proc.on("error", reject);
    proc.on("close", async (code) => {
      if (code !== 0) return reject(new Error("ffmpeg exit " + code));
      try {
        if (mode === "full") {
          const bucket = process.env.MINIO_BUCKET || "coopeditor-proxy";
          const keyPrefix = rendition.id + "/";
          for (const f of await fs.readdir(outDir)) {
            const body = await fs.readFile(join(outDir, f));
            const ct = f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
            await uploadFile(bucket, keyPrefix + f, body, ct);
          }
          // Always point at the API proxy so MinIO can stay private behind auth.
          await updateRendition(rendition.id, { status: "ready", progress: 100, hlsMasterUrl: "/hls/" + rendition.id + "/master.m3u8" });
          await fs.rm(outDir, { recursive: true, force: true });
        } else {
          await updateRendition(rendition.id, { status: "ready", progress: 100, hlsMasterUrl: "file://" + join(outDir, "master.m3u8") });
        }
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

async function workOnce() {
  activeJobs++;
  const claimed = await loadJob();
  try {
    if (!claimed) return false;
    const { job, rendition } = claimed;
    console.log("[worker] job", job.id, "rendition", rendition.id, "mode", mode);
    await updateRendition(rendition.id, { status: "processing", progress: 0 });
    if (mode === "sim") await runSim(rendition.id, rendition.asset_version_id);
    else await runFfmpeg(rendition);
    await finishJob(job.id, true, null);
    return true;
  } catch (err) {
    const { job, rendition } = claimed;
    console.error("[worker] job", job.id, "attempt", job.attempts, "/", job.max_attempts, "failed:", err.message);
    if (!isPermanentTranscodeError(err) && job.attempts < job.max_attempts) {
      // keep rendition in 'processing' so the FE shows "đang transcode", just at 0% until next attempt
      await updateRendition(rendition.id, { status: "processing", progress: 0 });
      await rescheduleJob(job.id, job.attempts, err.message);
    } else {
      await updateRendition(rendition.id, { status: "failed", progress: 0 });
      await finishJob(job.id, false, err.message);
    }
    return true;
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

function ensureWorkerSlots() {
  while (runningSlots < desiredConcurrency) {
    spawnSlot(nextSlotId++);
  }
}

async function spawnSlot(slotIndex) {
  runningSlots++;
  console.log("[worker] slot", slotIndex, "online");
  try {
    while (true) {
      await refreshDesiredConcurrency().catch((e) => console.error("[worker] autoscale", e.message));
      const did = await workOnce().catch((e) => { console.error("[worker]", e); return false; });
      if (did) {
        ensureWorkerSlots();
        continue;
      }
      if (!shouldKeepWorkerAlive(slotIndex, desiredConcurrency, activeJobs)) {
        console.log("[worker] slot", slotIndex, "retiring");
        return;
      }
      await sleep(3000);
    }
  } finally {
    runningSlots = Math.max(0, runningSlots - 1);
    ensureWorkerSlots();
  }
}

async function loop() {
  await refreshDesiredConcurrency();
  ensureWorkerSlots();
  while (true) {
    await sleep(10000);
    await refreshDesiredConcurrency().catch((e) => console.error("[worker] autoscale", e.message));
    ensureWorkerSlots();
  }
}

loop().catch((e) => { console.error(e); process.exit(1); });
