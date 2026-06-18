import { setTimeout as sleep } from "node:timers/promises";

import { applyRuntimeEnvFromConfig, isRuntimeConfigured, publicRuntimeSummary } from "../../api/src/runtime-config.js";
import { createRuntimeConfigWatcher } from "./runtime-watch.js";

while (!isRuntimeConfigured()) {
  console.log("[worker-bootstrap] runtime config missing, waiting for setup", publicRuntimeSummary());
  await sleep(10_000);
}

applyRuntimeEnvFromConfig();
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
