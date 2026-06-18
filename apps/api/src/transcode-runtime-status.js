import * as store from "./store-index.js";
import { db } from "./db.js";

const WORKER_HEARTBEAT_STALE_MS = 45_000;

export { WORKER_HEARTBEAT_STALE_MS };

function isoOrNull(value) {
  if (!value) return null;
  try { return new Date(value).toISOString(); } catch (_) { return null; }
}

function staleMessage(worker) {
  return "Worker heartbeat đã cũ, có thể container worker vừa dừng hoặc chưa restart lại sau khi đổi cấu hình.";
}

function mountMessage(worker) {
  const detail = String(worker.mountError || "").trim();
  if (detail) return detail;
  return "Worker chưa thấy DSM mount root " + (worker.dsmMountRoot || "/nas") + ".";
}

function buildSummaryFromWorkers(workers) {
  const activeWorkers = workers.filter((worker) => !worker.stale);
  const readyWorkers = activeWorkers.filter((worker) => worker.mountReady);
  const mountIssueWorkers = activeWorkers.filter((worker) => !worker.mountReady);
  const latestWorker = workers[0] || null;

  let status = "unknown";
  let message = "Chưa có heartbeat từ worker.";
  if (activeWorkers.length && readyWorkers.length === activeWorkers.length) {
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

  return {
    backend: store.backend,
    workerHeartbeatPresent: workers.length > 0,
    activeWorkers: activeWorkers.length,
    canTranscode: readyWorkers.length > 0,
    mountReady: readyWorkers.length > 0 ? true : (activeWorkers.length > 0 ? false : null),
    status,
    message,
    workers,
  };
}

export async function getTranscodeRuntimeStatus(nowMs = Date.now()) {
  if (store.backend !== "pg") {
    return {
      backend: store.backend,
      workerHeartbeatPresent: false,
      activeWorkers: 0,
      canTranscode: true,
      mountReady: null,
      status: "memory",
      message: "Runtime transcode status chỉ bật khi dùng Postgres + worker thật.",
      workers: [],
    };
  }
  const { rows } = await db().query(`
    SELECT worker_id, hostname, pid, mode, hwaccel, codec_ladder, dsm_mount_root,
           mount_ready, mount_error, app_data_dir, started_at, updated_at
      FROM worker_runtime_status
     ORDER BY updated_at DESC, worker_id
  `);
  const workers = rows.map((row) => {
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
  return buildSummaryFromWorkers(workers);
}

export async function ensureTranscodeRuntimeReady() {
  const summary = await getTranscodeRuntimeStatus();
  if (summary.backend !== "pg") return summary;
  if (summary.activeWorkers > 0 && !summary.canTranscode) {
    throw new Error(summary.message + " Kiểm tra volume NAS của container worker rồi redeploy project.");
  }
  return summary;
}
