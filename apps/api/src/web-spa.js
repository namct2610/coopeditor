// Serves the single-page web SPA from inside the API process. Used by the
// native SPK build so we don't need to ship a separate web container. The
// Docker stack still uses apps/web/src/dev-server.js because Caddy fronts
// both and the FE deploys benefit from being separately recreatable.
//
// Behaviour:
//   * GET /                — returns index.html with BUILD_SHA + BUILT_AT
//                            stamped into a <meta> tag, Cache-Control no-store,
//                            and the same CSP the dev-server uses.
//   * GET /index.html      — same as /.
//   * Any other path       — returns null so handle() can 404 cleanly.
//
// Enabled when WEB_INLINE=1 env is set (or by default in SPK builds where
// the launcher script always sets it).

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate the SPA shell relative to this file. In SPK layout the API and
// web sources sit under /var/packages/coopeditor/target/app/apps/{api,web}.
// In dev / Docker the same path works because pnpm preserves the apps/ tree.
const SPA_INDEX = resolve(__dirname, "..", "..", "web", "src", "static", "index.html");

let _rawHtml = null;
let _renderedHtml = null;

async function loadRawHtml() {
  if (_rawHtml !== null) return _rawHtml;
  try {
    _rawHtml = await readFile(SPA_INDEX, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      _rawHtml = "";
      return _rawHtml;
    }
    throw err;
  }
  return _rawHtml;
}

function renderInjected(raw) {
  const sha = String(process.env.BUILD_SHA || "unknown");
  const builtAt = String(process.env.BUILT_AT || "unknown");
  const inject = `<meta name="coopeditor-build" content="${sha}">\n` +
    `<script>window.__BUILD_SHA=${JSON.stringify(sha)};window.__BUILT_AT=${JSON.stringify(builtAt)};</script>\n`;
  if (raw.includes("</head>")) return raw.replace("</head>", inject + "</head>");
  return inject + raw;
}

export function webInlineEnabled() {
  return process.env.WEB_INLINE === "1" || process.env.WEB_INLINE === "true";
}

export async function spaExists() {
  if (!webInlineEnabled()) return false;
  try { await stat(SPA_INDEX); return true; } catch (_) { return false; }
}

export async function serveSpaIndex(res) {
  const raw = await loadRawHtml();
  if (!raw) { res.statusCode = 404; res.setHeader("content-type", "text/plain"); res.end("SPA not found"); return; }
  if (_renderedHtml === null) _renderedHtml = renderInjected(raw);
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  // Cache: never. Combined with the SHA injection above this lets the FE
  // detect a deploy and refresh, while the browser doesn't pin a stale shell.
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.setHeader("surrogate-control", "no-store");
  // CSP mirrors dev-server.js; relaxed for hls.js' Blob workers + inline FE.
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
      "connect-src 'self' ws: wss:; " +
      "script-src 'self' 'unsafe-inline' blob: https://cdn.jsdelivr.net; " +
      "worker-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "base-uri 'self'; frame-ancestors 'none'",
  );
  res.end(_renderedHtml);
}

// Hook for handle(): returns true if it served the request, false otherwise.
// Callers should invoke this AFTER all API routes have been considered, so
// the SPA shell never shadows a real endpoint.
export async function tryServeSpa(req, res, url) {
  if (!webInlineEnabled()) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const p = url.pathname;
  // Only serve the shell for the root + index.html. Other static assets are
  // inlined inside the shell, so there's nothing else to deliver.
  if (p !== "/" && p !== "/index.html") return false;
  if (!(await spaExists())) return false;
  await serveSpaIndex(res);
  return true;
}
