import { setTimeout as sleep } from "node:timers/promises";

import { applyRuntimeEnvFromConfig, isRuntimeConfigured, publicRuntimeSummary } from "../../api/src/runtime-config.js";

while (!isRuntimeConfigured()) {
  console.log("[worker-bootstrap] runtime config missing, waiting for setup", publicRuntimeSummary());
  await sleep(10_000);
}

applyRuntimeEnvFromConfig();
await import("./worker.js");
