import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_HTML = readFileSync(join(__dirname, "static", "index.html"), "utf8");

// Inject the build SHA + built-at into the HTML so the live page knows what
// version it actually loaded. Combined with /api/version polling on the FE,
// this lets us detect when a deploy ships and force the browser to reload
// instead of running stale JS from a kept-alive tab.
const BUILD_SHA = String(process.env.BUILD_SHA || "unknown");
const BUILT_AT = String(process.env.BUILT_AT || "unknown");
function renderHtml() {
  // window.__BUILD_SHA / __BUILT_AT are read by the FE on boot. We also stamp
  // a <meta> tag for tooling/debugging that wants the value before JS runs.
  const inject = `<meta name="coopeditor-build" content="${BUILD_SHA}">\n<script>window.__BUILD_SHA=${JSON.stringify(BUILD_SHA)};window.__BUILT_AT=${JSON.stringify(BUILT_AT)};</script>\n`;
  if (RAW_HTML.includes("</head>")) return RAW_HTML.replace("</head>", inject + "</head>");
  return inject + RAW_HTML;
}
const HTML = renderHtml();

const server = createServer((_, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  // Never let browsers cache the single-page shell. On NAS deployments users
  // often recreate the stack/project, and a stale cached HTML/JS bundle can
  // trap them in an invalid setup/login flow until they manually clear cache.
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.setHeader("surrogate-control", "no-store");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
      "connect-src 'self' ws: wss: http://localhost:4000 http://127.0.0.1:4000; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "base-uri 'self'; frame-ancestors 'none'",
  );
  res.end(HTML);
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST || "0.0.0.0";

server.listen(port, host, () => {
  console.log(`Coopeditor web preview listening on http://${host}:${port}`);
});
