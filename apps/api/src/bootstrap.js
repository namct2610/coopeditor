// Bootstrap entrypoint. Decides whether we run the full API server, the
// setup wizard (when runtime config is missing), and — for the native SPK
// build — whether to spawn the transcode worker as a child process so the
// whole stack lives under one SPK lifecycle.

import { applyRuntimeEnvFromConfig, isRuntimeConfigured, publicRuntimeSummary } from "./runtime-config.js";

// Worker co-supervision. The SPK build sets WORKER_INLINE=1 so the API
// process owns the worker's lifetime. Docker stacks leave it unset because
// the worker has its own container + supervisor (docker compose restart).
function startInlineWorker() {
  if (process.env.WORKER_INLINE !== "1" && process.env.WORKER_INLINE !== "true") return;
  // Lazy-require child_process so the API doesn't pay the import cost on
  // Docker deployments where we never spawn the worker here.
  Promise.all([
    import("node:child_process"),
    import("node:url"),
    import("node:path"),
  ]).then(([{ spawn }, { fileURLToPath }, { dirname, resolve }]) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const workerEntry = resolve(__dirname, "..", "..", "worker", "src", "bootstrap.js");
    let child = null;
    let restartTimer = null;
    let shuttingDown = false;
    const launch = () => {
      if (shuttingDown) return;
      const env = { ...process.env };
      console.log("[bootstrap] launching inline worker", {
        workerEntry,
        pid: process.pid,
        dsmMountRoot: env.DSM_MOUNT_ROOT || "",
        appDataDir: env.APP_DATA_DIR || "",
      });
      child = spawn(process.execPath, [workerEntry], {
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("spawn", () => {
        console.log(`[bootstrap] inline worker started pid=${child && child.pid || "?"}`);
      });
      child.on("error", (err) => {
        console.error("[bootstrap] inline worker spawn error:", err && err.message || err);
      });
      child.on("exit", (code, signal) => {
        console.error(`[bootstrap] inline worker exited (code=${code} signal=${signal}); restarting in 3s`);
        child = null;
        if (shuttingDown) return;
        // 3s backoff — same pattern as Docker compose restart-on-failure.
        restartTimer = setTimeout(launch, 3000);
        if (typeof restartTimer.unref === "function") restartTimer.unref();
      });
    };
    launch();
    // Forward shutdown signals so SPK's start-stop-status `stop` brings
    // the worker down cleanly with the API.
    const stop = (signal) => () => {
      shuttingDown = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (child) try { child.kill(signal); } catch (_) {}
    };
    process.on("SIGTERM", stop("SIGTERM"));
    process.on("SIGINT", stop("SIGINT"));
  }).catch((err) => {
    console.error("[bootstrap] failed to initialise inline worker supervisor:", err && err.message || err);
  });
}

if (isRuntimeConfigured()) {
  applyRuntimeEnvFromConfig();
  startInlineWorker();
  await import("./server.js");
} else {
  console.log("[bootstrap] runtime config missing, entering setup mode", publicRuntimeSummary());
  await import("./setup-server.js");
}
