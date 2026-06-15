// Streams HLS playlist + segments to the browser. The browser never talks to
// MinIO directly — that way the bucket can stay private and access stays
// gated by the API session.
//
// Two modes:
//   - MinIO: GET https://${MINIO_ENDPOINT}/${MINIO_BUCKET}/${renditionId}/${file}
//   - filesystem fallback (worker ffmpeg-only mode): /var/lib/.../hls/...
//
// In sim/memory mode we don't have real files, so the proxy returns a
// well-formed empty playlist so the browser tolerates the request.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "frame-proxy";
const HLS_CDN_PUBLIC_URL = (process.env.HLS_CDN_PUBLIC_URL || "").replace(/\/+$/, "");
const HLS_CDN_SIGNING_SECRET = process.env.HLS_CDN_SIGNING_SECRET || "";
const HLS_CDN_TOKEN_TTL_SECONDS = Math.max(30, Number.parseInt(process.env.HLS_CDN_TOKEN_TTL_SECONDS || "300", 10) || 300);
const HLS_PLAYLIST_CACHE_CONTROL = process.env.HLS_PLAYLIST_CACHE_CONTROL || "private, no-store";
const HLS_SEGMENT_CACHE_CONTROL = process.env.HLS_SEGMENT_CACHE_CONTROL || "public, max-age=31536000, immutable";
const HLS_DIRECT_CACHE_CONTROL = process.env.HLS_DIRECT_CACHE_CONTROL || "private, max-age=60";

const ALLOWED = /^[A-Za-z0-9_.-]+$/;

function signableValue(renditionId, file, exp) {
  return `${renditionId}:${file}:${exp}`;
}

export function createSignedPlaybackToken(renditionId, file, secret, exp) {
  return createHmac("sha256", secret).update(signableValue(renditionId, file, exp)).digest("hex");
}

export function hasValidSignedPlaybackToken(renditionId, file, searchParams, nowMs = Date.now()) {
  if (!HLS_CDN_SIGNING_SECRET) return false;
  const exp = searchParams.get("exp");
  const sig = searchParams.get("sig");
  if (!exp || !sig) return false;
  const expiry = Number.parseInt(exp, 10);
  if (!Number.isFinite(expiry) || expiry * 1000 < nowMs) return false;
  const expected = createSignedPlaybackToken(renditionId, file, HLS_CDN_SIGNING_SECRET, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function buildSignedPlaybackUrl(renditionId, file, nowMs = Date.now()) {
  const base = HLS_CDN_PUBLIC_URL ? `${HLS_CDN_PUBLIC_URL}/${renditionId}/${file}` : null;
  if (!base) return null;
  if (!HLS_CDN_SIGNING_SECRET) return null;
  const exp = String(Math.floor(nowMs / 1000) + HLS_CDN_TOKEN_TTL_SECONDS);
  const sig = createSignedPlaybackToken(renditionId, file, HLS_CDN_SIGNING_SECRET, exp);
  return `${base}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
}

export function rewritePlaylistBody(body, renditionId) {
  if (!HLS_CDN_PUBLIC_URL || !HLS_CDN_SIGNING_SECRET) return body;
  return body.split("\n").map((line) => {
    if (!line || line.startsWith("#EXT-X-ENDLIST") || line.startsWith("#EXTM3U")) return line;
    if (line.startsWith("#EXT-X-MAP:")) {
      return line.replace(/URI="([^"]+)"/, (_, file) => {
        if (!ALLOWED.test(file)) return `URI="${file}"`;
        return `URI="${buildSignedPlaybackUrl(renditionId, file) || file}"`;
      });
    }
    if (line.startsWith("#")) return line;
    if (!ALLOWED.test(line)) return line;
    return buildSignedPlaybackUrl(renditionId, line) || line;
  }).join("\n");
}

async function readUpstreamText(url) {
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status, text: "" };
  return { ok: true, status: 200, text: await res.text() };
}

export async function serveHls(req, res, renditionId, file, opts = {}) {
  if (!ALLOWED.test(renditionId) || !ALLOWED.test(file)) { res.statusCode = 400; return res.end("bad path"); }

  const ext = file.split(".").pop().toLowerCase();
  const contentType = ext === "m3u8" ? "application/vnd.apple.mpegurl" : ext === "ts" ? "video/mp2t" : "application/octet-stream";
  const isPlaylist = ext === "m3u8";
  const cacheControl = isPlaylist ? HLS_PLAYLIST_CACHE_CONTROL : (opts.signedPlayback ? HLS_SEGMENT_CACHE_CONTROL : HLS_DIRECT_CACHE_CONTROL);

  // 1. MinIO mode
  if (MINIO_ENDPOINT) {
    const upstream = MINIO_ENDPOINT.replace(/\/+$/, "") + "/" + MINIO_BUCKET + "/" + renditionId + "/" + file;
    try {
      if (isPlaylist) {
        const up = await readUpstreamText(upstream);
        if (!up.ok) { res.statusCode = up.status; return res.end(); }
        res.statusCode = 200;
        res.setHeader("content-type", contentType);
        res.setHeader("cache-control", cacheControl);
        return res.end(rewritePlaylistBody(up.text, renditionId));
      }
      const up = await fetch(upstream);
      if (!up.ok) { res.statusCode = up.status; return res.end(); }
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", cacheControl);
      const reader = up.body.getReader();
      const pump = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      return pump();
    } catch (err) {
      res.statusCode = 502; res.setHeader("content-type", "text/plain"); return res.end("upstream fetch failed: " + err.message);
    }
  }

  // 2. Filesystem fallback (worker ffmpeg-only mode wrote OUTPUT_DIR/<renditionId>/master.m3u8)
  const base = process.env.OUTPUT_DIR;
  if (base) {
    const p = base.replace(/\/+$/, "") + "/" + renditionId + "/" + file;
    try { await stat(p); }
    catch (_) { res.statusCode = 404; return res.end(); }
    if (isPlaylist) {
      const body = await readFile(p, "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", cacheControl);
      return res.end(rewritePlaylistBody(body, renditionId));
    }
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", cacheControl);
    return createReadStream(p).pipe(res);
  }

  // 3. Sim mode: synthesize an empty VOD playlist so <video> with hls.js doesn't 404 loudly.
  if (file === "master.m3u8") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/vnd.apple.mpegurl");
    res.setHeader("cache-control", cacheControl);
    return res.end(rewritePlaylistBody("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n", renditionId));
  }
  res.statusCode = 404; res.end();
}
