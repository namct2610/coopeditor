import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "static", "index.html"), "utf8");

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
  res.end(html);
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST || "0.0.0.0";

server.listen(port, host, () => {
  console.log(`Coopeditor web preview listening on http://${host}:${port}`);
});
