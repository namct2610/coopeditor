import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

import { applyRuntimeEnvFromConfig, isRuntimeConfigured, publicRuntimeSummary } from "../../api/src/runtime-config.js";
import { detectWorkerMountHealth, reportWorkerBootstrapFailure, shouldFailWorkerStartup } from "./runtime-status.js";
import { createRuntimeConfigWatcher } from "./runtime-watch.js";

while (!isRuntimeConfigured()) {
  console.log("[worker-bootstrap] runtime config missing, waiting for setup", publicRuntimeSummary());
  await sleep(10_000);
}

applyRuntimeEnvFromConfig();
const mountStatus = await detectWorkerMountHealth(process.env);
if (!mountStatus.mountReady && shouldFailWorkerStartup(process.env)) {
  if (process.env.DATABASE_URL) {
    try {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      try {
        await reportWorkerBootstrapFailure(pool, {
          mode: "bootstrap-failed",
          hwaccel: (process.env.FFMPEG_HWACCEL || "").toLowerCase() || "none",
          codecLadder: (process.env.FFMPEG_CODEC_LADDER || "h264").toLowerCase(),
          appDataDir: process.env.APP_DATA_DIR || "/data",
        });
      } finally {
        await pool.end().catch(() => {});
      }
    } catch (err) {
      console.warn("[worker-bootstrap] failed to report mount error to worker_runtime_status:", err && err.message || err);
    }
  }
  console.error("[worker-bootstrap] NAS mount not ready:", mountStatus.mountError || ("DSM mount root " + (mountStatus.dsmMountRoot || "/nas") + " not ready"));
  console.error("[worker-bootstrap] Worker will exit now so Docker reports the mount problem instead of accepting transcode jobs in a broken state.");
  process.exit(1);
}
const runtimeWatcher = createRuntimeConfigWatcher({
  intervalMs: 5000,
  onChange: async () => {
    console.log("[worker-bootstrap] runtime config changed, exiting so Docker can restart worker with fresh settings");
    process.exit(0);
  },
});
await runtimeWatcher.prime();
runtimeWatcher.start();
await import("./worker.js");
