// HTTP client for the Coopeditor API.
//
// SPK (WEB_INLINE=1): the API serves this page, so calls go to same-origin
// /api. Docker: Caddy fronts both under /api. Local dev: web on :3000 talks
// to the API on :4000.

export const API_BASE = (function () {
  const m = document.querySelector('meta[name="api-base"]');
  if (m && m.content) return m.content.replace(/\/+$/, "");
  if (location.port === "3000") return location.protocol + "//" + location.hostname + ":4000";
  return "/api";
})();

export const mediaUrl = (path) => (path ? API_BASE + path : "");

const TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: opts.method || "GET",
      credentials: "include",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw new ApiError("Máy chủ phản hồi quá lâu, thử lại sau", 0);
    throw new ApiError("Không kết nối được tới máy chủ", 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (_) { json = { error: text.slice(0, 200) }; } }
  if (res.status === 401 && !path.startsWith("/auth/") && !opts.quiet401) {
    if (onUnauthorized) onUnauthorized();
  }
  if (!res.ok) {
    const fallback = res.status === 401 ? "Phiên đăng nhập đã hết hạn" : "Lỗi " + res.status;
    throw new ApiError((json && json.error) || fallback, res.status, json);
  }
  return json;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: "POST", body: body || {} });
export const patch = (p, body, o) => api(p, { ...o, method: "PATCH", body: body || {} });
export const del = (p, o) => api(p, { ...o, method: "DELETE" });
export const enc = encodeURIComponent;
