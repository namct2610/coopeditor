import * as store from "./store-index.js";
import { db } from "./db.js";
import { configPath, readRuntimeConfig } from "./runtime-config.js";
import { stat } from "node:fs/promises";

const WORKER_HEARTBEAT_STALE_MS = 45_000;
const DEFAULT_MOUNT_ROOT = "/nas";
const LEGACY_MOUNT_ROOT = process.env.DSM_LEGACY_MOUNT_ROOT || DEFAULT_MOUNT_ROOT;
const MOUNT_ERROR_RE = /(not mounted|cannot read source path|source file not found|khong tim thay|không tìm thấy|khong du quyen|không đủ quyền)/i;

export { WORKER_HEARTBEAT_STALE_MS };

function isoOrNull(value) {
  if (!value) return null;
  try { return new Date(value).toISOString(); } catch (_) { return null; }
}

function staleMessage(worker) {
  return isSpkRuntime()
    ? "Worker heartbeat đã cũ, có thể worker inline trong package Coopeditor vừa dừng hoặc package chưa restart lại sau khi đổi cấu hình."
    : "Worker heartbeat đã cũ, có thể container worker vừa dừng hoặc chưa restart lại sau khi đổi cấu hình.";
}

function mountMessage(worker) {
  const detail = String(worker.mountError || "").trim();
  if (detail) return detail;
  return "Worker chưa thấy DSM mount root " + (worker.dsmMountRoot || "/nas") + ".";
}

function normalizeMountRoot(root) {
  return String(root || "").trim().replace(/\/+$/, "") || DEFAULT_MOUNT_ROOT;
}

function isSpkRuntime(env = process.env) {
  return String(env.WORKER_INLINE || "") === "1"
    || String(env.WEB_INLINE || "") === "1"
    || /^\/var\/packages\/coopeditor\//.test(configPath())
    || /^\/var\/packages\/coopeditor\//.test(String(env.APP_DATA_DIR || ""));
}

function mountRootLooksLikeHostPath(root) {
  return /^\/volume\d+(\/|$)/i.test(normalizeMountRoot(root));
}

function buildMountRootCandidates(root = process.env.DSM_MOUNT_ROOT || DEFAULT_MOUNT_ROOT) {
  const cleaned = normalizeMountRoot(root);
  const candidates = [cleaned];
  if (mountRootLooksLikeHostPath(cleaned)) candidates.push(normalizeMountRoot(LEGACY_MOUNT_ROOT));
  return [...new Set(candidates.filter(Boolean))];
}

async function detectApiMountHealth() {
  const requestedRoot = normalizeMountRoot(process.env.DSM_MOUNT_ROOT || DEFAULT_MOUNT_ROOT);
  const candidates = buildMountRootCandidates(requestedRoot);
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) {
        lastErr = "API thấy DSM mount root " + candidate + " nhưng đây không phải thư mục hợp lệ.";
        continue;
      }
      return {
        mountReady: true,
        dsmMountRoot: candidate,
        mountError: candidate === requestedRoot
          ? ""
          : ("API đang fallback từ DSM mount root cũ " + requestedRoot + " sang " + candidate + "."),
      };
    } catch (err) {
      if (err && err.code === "ENOENT") lastErr = "API chưa thấy DSM mount root " + candidate + ".";
      else if (err && err.code === "EACCES") lastErr = "API không đủ quyền đọc DSM mount root " + candidate + ".";
      else lastErr = "API không kiểm tra được DSM mount root " + candidate + ": " + ((err && err.message) || err);
    }
  }
  return {
    mountReady: false,
    dsmMountRoot: requestedRoot,
    mountError: lastErr || ("API chưa thấy DSM mount root " + requestedRoot + "."),
  };
}

async function loadLatestMountFailure() {
  if (store.backend === "sqlite") {
    const sql = `
      SELECT job.id,
             job.error,
             job.status,
             COALESCE(job.finished_at, job.started_at, job.enqueued_at) AS happened_at,
             r.id AS rendition_id,
             a.id AS asset_id,
             a.title AS asset_title,
             a.nas_path AS asset_nas_path
        FROM transcode_jobs job
        JOIN renditions r ON r.id = job.rendition_id
        JOIN asset_versions v ON v.id = r.asset_version_id
        JOIN assets a ON a.id = v.asset_id
       WHERE job.error IS NOT NULL
         AND job.error <> ''
       ORDER BY (COALESCE(job.finished_at, job.started_at, job.enqueued_at) IS NULL) ASC,
                COALESCE(job.finished_at, job.started_at, job.enqueued_at) DESC,
                job.id DESC
       LIMIT 50
    `;
    const { rows } = await db().query(sql);
    const row = rows.find((item) => MOUNT_ERROR_RE.test(String(item && item.error || "")));
    if (!row) return null;
    return {
      jobId: Number(row.id || 0),
      renditionId: row.rendition_id || "",
      assetId: row.asset_id || "",
      assetTitle: row.asset_title || "",
      assetNasPath: row.asset_nas_path || "",
      status: row.status || "",
      error: row.error || "",
      happenedAt: isoOrNull(row.happened_at),
    };
  }
  const sql = `
    SELECT job.id,
           job.error,
           job.status,
           COALESCE(job.finished_at, job.started_at, job.enqueued_at) AS happened_at,
           r.id AS rendition_id,
           a.id AS asset_id,
           a.title AS asset_title,
           a.nas_path AS asset_nas_path
      FROM transcode_jobs job
      JOIN renditions r ON r.id = job.rendition_id
      JOIN asset_versions v ON v.id = r.asset_version_id
      JOIN assets a ON a.id = v.asset_id
     WHERE job.error IS NOT NULL
       AND job.error <> ''
       AND job.error ~* '(not mounted|cannot read source path|source file not found|khong tim thay|khong du quyen)'
     ORDER BY COALESCE(job.finished_at, job.started_at, job.enqueued_at) DESC NULLS LAST, job.id DESC
     LIMIT 1
  `;
  const { rows } = await db().query(sql);
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: Number(row.id || 0),
    renditionId: row.rendition_id || "",
    assetId: row.asset_id || "",
    assetTitle: row.asset_title || "",
    assetNasPath: row.asset_nas_path || "",
    status: row.status || "",
    error: row.error || "",
    happenedAt: isoOrNull(row.happened_at),
  };
}

export function summarizeTranscodeWorkers(workers, diagnostics = {}) {
  const activeWorkers = workers.filter((worker) => !worker.stale);
  const readyWorkers = activeWorkers.filter((worker) => worker.mountReady);
  const mountIssueWorkers = activeWorkers.filter((worker) => !worker.mountReady);
  const warningWorkers = readyWorkers.filter((worker) => String(worker.mountError || "").trim());
  const latestWorker = workers[0] || null;
  const apiMount = diagnostics.apiMount || null;
  const latestMountFailure = diagnostics.latestMountFailure || null;
  const runtimeConfigPresent = diagnostics.runtimeConfigPresent == null
    ? !!readRuntimeConfig()
    : !!diagnostics.runtimeConfigPresent;
  const spkRuntime = diagnostics.spkRuntime == null ? isSpkRuntime() : !!diagnostics.spkRuntime;

  let status = "offline";
  let message = spkRuntime
    ? "Chưa có worker online. Kiểm tra package Coopeditor đã chạy hoàn tất và worker inline đã gửi heartbeat chưa."
    : "Chưa có worker online. Kiểm tra container coopeditor-worker đã chạy và gửi heartbeat chưa.";
  if (warningWorkers.length) {
    status = "warning";
    message = mountMessage(warningWorkers[0]);
  } else if (activeWorkers.length && readyWorkers.length === activeWorkers.length) {
    status = "ready";
    message = "Worker đang online và nhìn thấy DSM mount root.";
  } else if (activeWorkers.length && readyWorkers.length > 0) {
    status = "degraded";
    message = mountMessage(mountIssueWorkers[0]);
  } else if (activeWorkers.length) {
    status = "mount-error";
    message = mountMessage(mountIssueWorkers[0]);
  } else if (workers.length) {
    status = "stale";
    message = staleMessage(latestWorker);
  }

  if (!activeWorkers.length) {
    if (apiMount && apiMount.mountReady) {
      message += spkRuntime
        ? (" API đang thấy DSM mount root " + (apiMount.dsmMountRoot || DEFAULT_MOUNT_ROOT)
          + ", nên nhiều khả năng worker inline trong package Coopeditor chưa khởi động được hoặc package đang crash trước khi gửi heartbeat.")
        : (" API đang thấy DSM mount root " + (apiMount.dsmMountRoot || DEFAULT_MOUNT_ROOT)
          + ", nên nhiều khả năng container coopeditor-worker chưa được recreate sau khi thêm volume NAS hoặc đang crash trước khi gửi heartbeat.");
    } else if (apiMount && apiMount.mountError) {
      message += " " + apiMount.mountError;
    }
    if (runtimeConfigPresent) {
      message += spkRuntime
        ? (" API đã có runtime config tại " + configPath()
          + ", nên hãy kiểm tra log package Coopeditor và restart package để worker inline đọc lại cấu hình.")
        : (" API đã có runtime config tại " + configPath()
          + ", nên cũng cần kiểm tra container worker có mount cùng app-data volume vào /data hay không.");
    }
    if (latestMountFailure && latestMountFailure.error) {
      message += " Job lỗi gần nhất: " + latestMountFailure.error;
    }
  } else if (!readyWorkers.length && latestMountFailure && latestMountFailure.error) {
    message += " Job lỗi gần nhất: " + latestMountFailure.error;
  }

  return {
    backend: store.backend,
    workerHeartbeatPresent: workers.length > 0,
    activeWorkers: activeWorkers.length,
    canTranscode: readyWorkers.length > 0,
    mountReady: readyWorkers.length > 0 ? true : (activeWorkers.length > 0 ? false : null),
    status,
    message,
    workers,
    diagnostics: {
      apiMount,
      latestMountFailure,
    },
  };
}

export async function getTranscodeRuntimeStatus(nowMs = Date.now()) {
  if (store.backend === "memory") {
    return {
      backend: store.backend,
      workerHeartbeatPresent: false,
      activeWorkers: 0,
      canTranscode: true,
      mountReady: null,
      status: "memory",
      message: "Runtime transcode status chỉ bật khi dùng database thật + worker thật.",
      workers: [],
      diagnostics: {
        apiMount: null,
        latestMountFailure: null,
      },
    };
  }
  const [workerRows, apiMount, latestMountFailure] = await Promise.all([
    db().query(`
    SELECT worker_id, hostname, pid, mode, hwaccel, codec_ladder, dsm_mount_root,
           mount_ready, mount_error, app_data_dir, started_at, updated_at
      FROM worker_runtime_status
     ORDER BY updated_at DESC, worker_id
  `),
    detectApiMountHealth().catch((err) => ({
      mountReady: false,
      dsmMountRoot: normalizeMountRoot(process.env.DSM_MOUNT_ROOT || DEFAULT_MOUNT_ROOT),
      mountError: "API không kiểm tra được DSM mount root: " + ((err && err.message) || err),
    })),
    loadLatestMountFailure().catch(() => null),
  ]);
  const workers = workerRows.rows.map((row) => {
    const updatedAtIso = isoOrNull(row.updated_at);
    const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : 0;
    return {
      workerId: row.worker_id,
      hostname: row.hostname || "",
      pid: Number(row.pid || 0),
      mode: row.mode || "",
      hwaccel: row.hwaccel || "",
      codecLadder: row.codec_ladder || "",
      dsmMountRoot: row.dsm_mount_root || "/nas",
      mountReady: !!row.mount_ready,
      mountError: row.mount_error || "",
      appDataDir: row.app_data_dir || "",
      startedAt: isoOrNull(row.started_at),
      updatedAt: updatedAtIso,
      stale: !updatedAtMs || (nowMs - updatedAtMs > WORKER_HEARTBEAT_STALE_MS),
    };
  });
  return summarizeTranscodeWorkers(workers, { apiMount, latestMountFailure });
}

export async function ensureTranscodeRuntimeReady() {
  const summary = await getTranscodeRuntimeStatus();
  if (summary.backend === "memory") return summary;
  if (!summary.workerHeartbeatPresent || summary.activeWorkers <= 0) {
    throw new Error(summary.message + " Khởi động lại worker hoặc redeploy runtime để nhận cấu hình mới.");
  }
  if (!summary.canTranscode) {
    throw new Error(summary.message + " Kiểm tra DSM mount root rồi khởi động lại worker.");
  }
  return summary;
}
