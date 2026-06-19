import { stat } from "node:fs/promises";

const DEFAULT_MOUNT_ROOT = "/nas";

function legacyMountRoot(env = process.env) {
  return String(env.DSM_LEGACY_MOUNT_ROOT || DEFAULT_MOUNT_ROOT).trim() || DEFAULT_MOUNT_ROOT;
}

export function detectNasMountRoot(env = process.env) {
  return String(env.DSM_MOUNT_ROOT || DEFAULT_MOUNT_ROOT).trim() || DEFAULT_MOUNT_ROOT;
}

function isHostStyleMountRoot(root) {
  return /^\/volume\d+(\/|$)/i.test(String(root || "").trim());
}

export async function detectWorkerMountHealth(env = process.env) {
  const dsmMountRoot = detectNasMountRoot(env);
  const fallbackMountRoot = isHostStyleMountRoot(dsmMountRoot) ? legacyMountRoot(env) : "";
  try {
    const info = await stat(dsmMountRoot);
    if (!info.isDirectory()) {
      return {
        dsmMountRoot,
        mountReady: false,
        mountError: "Worker thấy mount root " + dsmMountRoot + " nhưng đây không phải thư mục NAS hợp lệ.",
      };
    }
    return { dsmMountRoot, mountReady: true, mountError: "" };
  } catch (err) {
    if (fallbackMountRoot && fallbackMountRoot !== dsmMountRoot) {
      try {
        const fallbackInfo = await stat(fallbackMountRoot);
        if (fallbackInfo.isDirectory()) {
          return {
            dsmMountRoot: fallbackMountRoot,
            mountReady: true,
            mountError: "Worker dang fallback tu DSM mount root cu " + dsmMountRoot + " sang " + fallbackMountRoot + ". Nen mo Setup va luu lai dsmMountRoot=/nas de dong bo runtime.",
          };
        }
      } catch (_) {}
    }
    if (err && err.code === "ENOENT") {
      return {
        dsmMountRoot,
        mountReady: false,
        mountError: "Worker chưa thấy DSM mount root " + dsmMountRoot + ". Kiểm tra volume NAS của container worker.",
      };
    }
    if (err && err.code === "EACCES") {
      return {
        dsmMountRoot,
        mountReady: false,
        mountError: "Worker không đủ quyền đọc DSM mount root " + dsmMountRoot + ".",
      };
    }
    return {
      dsmMountRoot,
      mountReady: false,
      mountError: "Worker không kiểm tra được DSM mount root " + dsmMountRoot + ": " + ((err && err.message) || err),
    };
  }
}

export async function ensureWorkerMountReady(env = process.env) {
  const mount = await detectWorkerMountHealth(env);
  if (!mount.mountReady) {
    throw new Error(mount.mountError || ("Worker chưa thấy DSM mount root " + (mount.dsmMountRoot || DEFAULT_MOUNT_ROOT) + "."));
  }
  return mount;
}

export function createWorkerRuntimeReporter(pool, {
  workerId = process.env.WORKER_RUNTIME_ID || process.env.HOSTNAME || ("worker-" + process.pid),
  hostname = process.env.HOSTNAME || "",
  pid = process.pid,
  mode = "",
  hwaccel = "",
  codecLadder = "",
  appDataDir = process.env.APP_DATA_DIR || "/data",
  env = process.env,
  logger = console,
} = {}) {
  let timer = null;

  async function reportOnce() {
    const mount = await detectWorkerMountHealth(env);
    await pool.query(`
      INSERT INTO worker_runtime_status (
        worker_id, hostname, pid, mode, hwaccel, codec_ladder,
        dsm_mount_root, mount_ready, mount_error, app_data_dir, started_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now()
      )
      ON CONFLICT (worker_id) DO UPDATE SET
        hostname = EXCLUDED.hostname,
        pid = EXCLUDED.pid,
        mode = EXCLUDED.mode,
        hwaccel = EXCLUDED.hwaccel,
        codec_ladder = EXCLUDED.codec_ladder,
        dsm_mount_root = EXCLUDED.dsm_mount_root,
        mount_ready = EXCLUDED.mount_ready,
        mount_error = EXCLUDED.mount_error,
        app_data_dir = EXCLUDED.app_data_dir,
        updated_at = now()
    `, [
      workerId,
      hostname,
      pid,
      mode,
      hwaccel,
      codecLadder,
      mount.dsmMountRoot,
      mount.mountReady,
      mount.mountError || null,
      appDataDir,
    ]);
    if (!mount.mountReady) logger.warn("[worker] DSM mount check:", mount.mountError);
    return mount;
  }

  function start(intervalMs = 15_000) {
    if (timer) return timer;
    timer = setInterval(() => {
      reportOnce().catch((err) => logger.warn("[worker] runtime status heartbeat failed:", err && err.message || err));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { reportOnce, start, stop };
}
