import { applyRuntimeEnvFromConfig, isRuntimeConfigured, publicRuntimeSummary } from "./runtime-config.js";

if (isRuntimeConfigured()) {
  applyRuntimeEnvFromConfig();
  await import("./server.js");
} else {
  console.log("[bootstrap] runtime config missing, entering setup mode", publicRuntimeSummary());
  await import("./setup-server.js");
}
