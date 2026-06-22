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
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "coopeditor-proxy";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minio";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minio123";

// MinIO buckets are private by default — a bare `fetch(http://minio:9000/bucket/key)`
// from the API gets 403 because there are no S3 credentials on the request.
// Use the AWS S3 SDK (lazy-loaded so the API can boot without MinIO) to sign
// GetObject for each playlist/segment we proxy.
let _s3Client = null;
async function getS3() {
  if (_s3Client) return _s3Client;
  const { S3Client } = await import("@aws-sdk/client-s3");
  _s3Client = new S3Client({
    region: "us-east-1",
    endpoint: MINIO_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
  });
  return _s3Client;
}
async function s3Get(key) {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getS3();
  try {
    return { ok: true, response: await s3.send(new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key })) };
  } catch (err) {
    return { ok: false, status: err.$metadata && err.$metadata.httpStatusCode || 502, err };
  }
}

// List all objects under a prefix + compute total size. Used by the proxy
// storage manager UI so the user can see how much disk each rendition eats.
export async function s3ListPrefix(prefix) {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = await getS3();
  const items = [];
  let cont = undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: prefix,
      ContinuationToken: cont,
    }));
    for (const it of (out.Contents || [])) items.push({ key: it.Key, size: it.Size || 0 });
    cont = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (cont);
  return items;
}

// Delete every object under a prefix in batches of 1000 (S3 API max).
export async function s3DeletePrefix(prefix) {
  const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
  const s3 = await getS3();
  const items = await s3ListPrefix(prefix);
  if (!items.length) return { deleted: 0 };
  let deleted = 0;
  for (let i = 0; i < items.length; i += 1000) {
    const batch = items.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: MINIO_BUCKET,
      Delete: { Objects: batch.map((it) => ({ Key: it.key })) },
    }));
    deleted += batch.length;
  }
  return { deleted, bytes: items.reduce((s, x) => s + x.size, 0) };
}

export function hlsBackendInfo() {
  return {
    backend: MINIO_ENDPOINT ? "minio" : (process.env.OUTPUT_DIR ? "filesystem" : "sim"),
    bucket: MINIO_BUCKET,
    endpoint: MINIO_ENDPOINT,
    outputDir: process.env.OUTPUT_DIR || "",
  };
}

// Filesystem twin of s3ListPrefix — walks OUTPUT_DIR/<renditionId>/* and
// returns the same `{key,size}` shape so buildProxyStorageReport works
// without caring whether the underlying storage is MinIO or local disk.
// Used by the SPK build where no MinIO/S3 is available.
export async function fsListPrefix(prefix = "") {
  const root = process.env.OUTPUT_DIR;
  if (!root) return [];
  const base = root.replace(/\/+$/, "");
  const out = [];
  async function walk(rel) {
    const abs = join(base, rel);
    let entries = [];
    try { entries = await readdir(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const relChild = rel ? `${rel}/${ent.name}` : ent.name;
      if (prefix && !relChild.startsWith(prefix.replace(/\/+$/, ""))) {
        // Only descend into sub-trees that could match the prefix.
        if (ent.isDirectory() && (prefix.startsWith(relChild + "/") || relChild.startsWith(prefix.replace(/\/+$/, "")))) {
          await walk(relChild);
        }
        continue;
      }
      if (ent.isDirectory()) { await walk(relChild); continue; }
      try {
        const st = await stat(join(abs, ent.name));
        out.push({ key: relChild, size: Number(st.size || 0) });
      } catch (_) { /* skip files that vanish mid-walk */ }
    }
  }
  await walk("");
  return out;
}

// Filesystem twin of s3DeletePrefix. Returns same `{deleted, bytes}` shape.
export async function fsDeletePrefix(prefix) {
  const root = process.env.OUTPUT_DIR;
  if (!root || !prefix) return { deleted: 0 };
  const items = await fsListPrefix(prefix);
  if (!items.length) return { deleted: 0 };
  const base = root.replace(/\/+$/, "");
  const cleaned = prefix.replace(/^\/+|\/+$/g, "");
  const target = join(base, cleaned);
  await rm(target, { recursive: true, force: true });
  return { deleted: items.length, bytes: items.reduce((s, x) => s + x.size, 0) };
}
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

async function readObjectText(key) {
  const got = await s3Get(key);
  if (!got.ok) return { ok: false, status: got.status, text: "" };
  return { ok: true, status: 200, text: await got.response.Body.transformToString() };
}

export async function serveHls(req, res, renditionId, file, opts = {}) {
  if (!ALLOWED.test(renditionId) || !ALLOWED.test(file)) { res.statusCode = 400; return res.end("bad path"); }

  const ext = file.split(".").pop().toLowerCase();
  const contentType = ext === "m3u8" ? "application/vnd.apple.mpegurl" : ext === "ts" ? "video/mp2t" : "application/octet-stream";
  const isPlaylist = ext === "m3u8";
  const cacheControl = isPlaylist ? HLS_PLAYLIST_CACHE_CONTROL : (opts.signedPlayback ? HLS_SEGMENT_CACHE_CONTROL : HLS_DIRECT_CACHE_CONTROL);

  // 1. MinIO mode — fetch via S3 SDK with credentials (private bucket).
  if (MINIO_ENDPOINT) {
    const key = renditionId + "/" + file;
    try {
      if (isPlaylist) {
        const up = await readObjectText(key);
        if (!up.ok) { res.statusCode = up.status; return res.end(); }
        res.statusCode = 200;
        res.setHeader("content-type", contentType);
        res.setHeader("cache-control", cacheControl);
        return res.end(rewritePlaylistBody(up.text, renditionId));
      }
      const got = await s3Get(key);
      if (!got.ok) { res.statusCode = got.status; return res.end(); }
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", cacheControl);
      // Body is a Node Readable stream when using @aws-sdk in Node runtime
      return got.response.Body.pipe(res);
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
