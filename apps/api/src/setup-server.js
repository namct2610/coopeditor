import { createServer } from "node:http";

import { createRequestLogger, logger, newRequestId } from "./logger.js";
import { publicRuntimeSummary, writeRuntimeConfig, isRuntimeConfigured } from "./runtime-config.js";
import { requestOriginMatchesHost } from "./security.js";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function applySetupCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && !requestOriginMatchesHost(req, origin)) return false;
  res.setHeader("access-control-allow-credentials", "true");
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  return true;
}

const server = createServer(async (req, res) => {
  const requestId = newRequestId();
  req.log = createRequestLogger(req, requestId);
  res.setHeader("x-request-id", requestId);
  const startedAt = Date.now();
  res.on("finish", () => {
    req.log.info({
      status_code: res.statusCode,
      duration_ms: Date.now() - startedAt,
    }, "setup request completed");
  });

  const url = new URL(req.url || "/", "http://x");
  if (!applySetupCors(req, res)) return send(res, 403, { error: "Origin not allowed", mode: "setup" });
  if ((req.method || "GET") === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204;
    return res.end();
  }

  if (url.pathname === "/health") return send(res, 200, { ok: true, mode: "setup", configured: false });
  if (url.pathname === "/setup/status") return send(res, 200, publicRuntimeSummary());
  if (url.pathname === "/setup/apply" && (req.method || "GET") === "POST") {
    if (isRuntimeConfigured()) return send(res, 409, { error: "App already configured" });
    try {
      const body = await readJson(req);
      writeRuntimeConfig(body);
      send(res, 200, { ok: true, restarting: true });
      setTimeout(() => process.exit(0), 150);
      return;
    } catch (err) {
      return send(res, 400, { error: err.message || "Invalid setup payload" });
    }
  }
  return send(res, 404, { error: "Not found", mode: "setup" });
});

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT ?? 4000);
server.listen(port, host, () => {
  logger.info({ host, port }, "Coopeditor API setup mode listening");
});
