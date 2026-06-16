import { randomUUID } from "node:crypto";

function createFallbackLogger(bindings = {}) {
  const emit = (level, obj, msg) => {
    const payload = {
      level,
      time: new Date().toISOString(),
      ...bindings,
      ...(obj || {}),
    };
    if (msg) payload.msg = msg;
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else console.log(line);
  };

  return {
    info(obj, msg) { emit("info", obj, msg); },
    warn(obj, msg) { emit("warn", obj, msg); },
    error(obj, msg) { emit("error", obj, msg); },
    child(extra) { return createFallbackLogger({ ...bindings, ...(extra || {}) }); },
  };
}

let rootLogger = createFallbackLogger({ service: "coopeditor-api", logger: "fallback-json" });

try {
  const mod = await import("pino");
  const pino = mod.default || mod;
  rootLogger = pino({
    name: "coopeditor-api",
    level: process.env.LOG_LEVEL || "info",
    base: { service: "coopeditor-api" },
  });
} catch (_) {}

export const logger = rootLogger;

export function createRequestLogger(req, requestId) {
  return logger.child({
    request_id: requestId,
    method: req.method,
    path: req.url,
  });
}

export function newRequestId() {
  return randomUUID();
}
