// CORS origin allowlist + per-IP login rate limiter.

const DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
const ALLOWED = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

// "*" disables CORS check (dangerous; only for offline demos)
const WILDCARD = ALLOWED.includes("*");

export function isOriginAllowed(origin, sameHost) {
  if (!origin) return true; // same-origin (no Origin header) — fine
  if (WILDCARD) return true;
  if (ALLOWED.includes(origin)) return true;
  // Same-host fallback: when the request comes through a reverse proxy
  // (Caddy/Nginx/Tailscale Funnel), the Origin header matches the Host header
  // the proxy forwarded. Treating that as same-origin avoids the "I set up
  // publicUrl=A but access through URL B → CORS blocks everything" footgun.
  return !!sameHost;
}

function originHostMatchesRequest(req, origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const reqHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
    return reqHost && u.host.toLowerCase() === reqHost;
  } catch (_) { return false; }
}

export function requestOriginMatchesHost(req, origin) {
  return originHostMatchesRequest(req, origin);
}

export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const sameHost = originHostMatchesRequest(req, origin);
  if (!isOriginAllowed(origin, sameHost)) {
    // Don't set credentials/origin headers → browser blocks the request.
    return false;
  }
  res.setHeader("access-control-allow-credentials", "true");
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  return true;
}

// ---- in-memory login rate limiter (per remote IP) ----
const buckets = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
let totalLoginAttempts = 0;
let blockedLoginAttempts = 0;

export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress || "unknown";
}

export function loginRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  totalLoginAttempts++;
  let b = buckets.get(ip);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + WINDOW_MS }; buckets.set(ip, b); }
  b.count++;
  if (b.count > MAX_ATTEMPTS) {
    blockedLoginAttempts++;
    const retryMs = Math.max(0, b.resetAt - now);
    return { ok: false, retryAfter: Math.ceil(retryMs / 1000) };
  }
  return { ok: true };
}

export function loginSuccess(req) {
  // clear the bucket on a real auth so honest users don't get locked out by mistakes
  buckets.delete(clientIp(req));
}

// Periodic GC so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (b.resetAt < now) buckets.delete(ip);
}, WINDOW_MS).unref?.();

export function loginMetrics() {
  return {
    activeBuckets: buckets.size,
    totalAttempts: totalLoginAttempts,
    blockedAttempts: blockedLoginAttempts,
  };
}
