import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat, statfs, mkdir, writeFile, unlink, rename, truncate, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Reusable random buffer for /speedtest/segment — generated once at startup and
// written repeatedly. 256 KiB is small enough to fit in CPU cache yet large
// enough that the per-chunk write overhead doesn't dominate at gigabit speeds.
const SPEEDTEST_NOISE = randomBytes(256 * 1024);
const APP_DATA_DIR = process.env.APP_DATA_DIR || "/data";
// Local .spk mirror for Package Center updates — only in the SPK runtime
// (COOPEDITOR_LIB_DIR is exported by its start script), never in dev/tests.
const SPK_MIRROR_DIR = process.env.COOPEDITOR_LIB_DIR ? join(APP_DATA_DIR, "spk-mirror") : null;
const PROJECT_THUMB_DIR = join(APP_DATA_DIR, "system", "project-thumbs");
const ANNOTATION_IMAGE_DIR = join(APP_DATA_DIR, "system", "annotation-images");
const SCRIPT_IMAGE_DIR = join(APP_DATA_DIR, "system", "script-images");
const PROXY_STORAGE_SNAPSHOT_PATH = join(APP_DATA_DIR, "system", "proxy-storage-cache.json");
const MAX_PROJECT_THUMB_BYTES = 2 * 1024 * 1024;
const ALLOWED_PROJECT_THUMB_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_COMMENT_CONTENT_CHARS = 4000;

import * as store from "./store-index.js";
import { db, initPg, initDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import * as dsm from "./dsm.js";
import { subscribe as sseSubscribe, subscriberCount, bindWsPublish } from "./events.js";
import { attachWebSocket, publish as wsPublish, subscriberCount as wsCount } from "./ws.js";
import { eventBusMode, publishEvent, startEventBus } from "./event-bus.js";
import { hasValidSignedPlaybackToken, serveHls, s3ListPrefix, s3DeletePrefix, fsListPrefix, fsDeletePrefix, hlsBackendInfo } from "./hls-proxy.js";
import { tryServeSpa } from "./web-spa.js";
import { applyCors, attachmentDisposition, isTrustedMutationRequest, loginMetrics, loginRateLimit, loginSuccess, shareCommentRateLimit } from "./security.js";
import * as presence from "./presence.js";
import {
  COOKIE_NAME, createSession, getSession, destroySession,
  parseCookies, cookieSetHeader, cookieClearHeader, isSecureRequest,
} from "./sessions.js";
import { pendingTranscodeCount, startWorker, requestTranscode } from "./worker-runtime.js";
import { createRequestLogger, logger, newRequestId } from "./logger.js";
import * as audit from "./audit.js";
import * as mailer from "./mailer.js";
import * as webhooks from "./webhooks.js";
import * as shareLinks from "./share-links.js";
import * as oidc from "./oidc.js";
import { startRetention } from "./retention.js";
import { buildProxyStorageReport } from "./proxy-storage.js";
import { DEFAULT_UPDATE_FEED_URL, applyRuntimeEnvFromConfig, publicRuntimeSummary, readRuntimeConfig, resolveUpdaterConfig, writeRuntimeConfig } from "./runtime-config.js";
import { buildSpkCatalog, mirrorPath, packageFeedStatus, warmSpkMirror } from "./spk-feed.js";
import { ANNOTATION_IMAGE_ID, validateAnnotation } from "./annotation.js";
import { writeZip, zipLength } from "./zip-stream.js";
import { buildLocalReleaseMeta, hasRemoteUpdate, normalizeRemoteReleaseMeta } from "./release-meta.js";
import { ensureTranscodeRuntimeReady, getTranscodeRuntimeStatus } from "./transcode-runtime-status.js";

// ---------- helpers ----------
const PROXY_STORAGE_CACHE_TTL_MS = 15_000;
let _proxyStorageCache = null;
let _proxyStorageLastGood = null;

function normalizeProxyStoragePayloadShape(payload) {
  if (!payload || typeof payload !== "object") return null;
  const renditions = Array.isArray(payload.renditions)
    ? payload.renditions.map((item) => ({
      renditionId: String(item && item.renditionId || ""),
      bytes: Number(item && item.bytes || 0),
      fileCount: Number(item && item.fileCount || 0),
      orphan: !!(item && item.orphan),
      label: item && item.label ? String(item.label) : null,
      status: item && item.status ? String(item.status) : null,
      height: Number(item && item.height || 0) || null,
      assetId: item && item.assetId ? String(item.assetId) : null,
      assetTitle: item && item.assetTitle ? String(item.assetTitle) : null,
      projectId: item && item.projectId ? String(item.projectId) : null,
      projectName: item && item.projectName ? String(item.projectName) : null,
    })).filter((item) => item.renditionId)
    : [];
  return {
    backend: payload.backend ? String(payload.backend) : "",
    bucket: payload.bucket ? String(payload.bucket) : null,
    totalBytes: Number(payload.totalBytes || 0),
    orphanBytes: Number(payload.orphanBytes || 0),
    orphanCount: Number(payload.orphanCount || 0),
    renditionCount: Number(payload.renditionCount || renditions.length),
    renditions,
    note: payload.note ? String(payload.note) : "",
    stale: !!payload.stale,
    savedAt: payload.savedAt ? String(payload.savedAt) : null,
  };
}

async function loadProxyStorageSnapshotFromDisk() {
  try {
    const raw = await readFile(PROXY_STORAGE_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const snapshot = normalizeProxyStoragePayloadShape(parsed);
    return snapshot && snapshot.backend ? snapshot : null;
  } catch (_) {
    return null;
  }
}

async function persistProxyStorageSnapshot(payload) {
  const snapshot = normalizeProxyStoragePayloadShape(payload);
  if (!snapshot || !snapshot.backend) return;
  await mkdir(join(APP_DATA_DIR, "system"), { recursive: true });
  await writeFile(PROXY_STORAGE_SNAPSHOT_PATH, JSON.stringify({
    ...snapshot,
    stale: false,
    savedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

function send(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function bad(res, msg, status = 400) { send(res, status, { error: msg }); }

function sendBinary(res, status, body, contentType, extraHeaders) {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "private, max-age=300");
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(body);
}

function buildThumbPlaceholderSvg(label = "Video") {
  const text = String(label || "Video").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#0b1220"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" rx="28" fill="url(#bg)"/>
  <rect x="216" y="98" width="208" height="124" rx="22" fill="rgba(59,130,246,0.18)" stroke="#3ba0ff" stroke-width="4"/>
  <polygon points="286,124 286,196 354,160" fill="#ecf6ff"/>
  <text x="320" y="286" text-anchor="middle" fill="#d6deea" font-family="Arial, sans-serif" font-size="28" font-weight="700">${text}</text>
</svg>`;
}

function sendThumbPlaceholder(res, label, extraHeaders) {
  return sendBinary(res, 200, Buffer.from(buildThumbPlaceholderSvg(label), "utf8"), "image/svg+xml; charset=utf-8", extraHeaders);
}

function pickProjectThumbAsset(projectId, assets) {
  const candidates = (assets || []).filter((asset) => asset && asset.nasPath);
  if (!candidates.length) return null;
  const seed = String(projectId || "").split("").reduce((acc, ch) => ((acc * 33) + ch.charCodeAt(0)) >>> 0, 5381);
  return candidates[seed % candidates.length];
}

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'",
  );
}

// The body arrives in network-sized pieces. They are joined as bytes and
// decoded once: decoding each piece on its own turned a letter whose UTF-8
// bytes straddled two pieces ("ệ" is 3 bytes) into "�" — it showed up in
// long scripts saved from the editor.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("Body too large")); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, maxBytes = 1_000_000) {
  const data = await readBody(req, maxBytes);
  return data ? JSON.parse(data) : {};
}

function mimeFromPath(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  if (lower.endsWith(".mxf")) return "application/mxf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function projectThumbRecordPath(projectId) {
  return join(PROJECT_THUMB_DIR, projectId + ".txt");
}

function parseProjectThumbDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Project thumbnail phải là data URL base64 hợp lệ");
  const contentType = String(match[1] || "").trim().toLowerCase();
  if (!ALLOWED_PROJECT_THUMB_TYPES.has(contentType)) {
    throw new Error("Project thumbnail chỉ hỗ trợ PNG, JPEG hoặc WebP");
  }
  let body = null;
  try {
    body = Buffer.from(match[2], "base64");
  } catch (_) {
    throw new Error("Project thumbnail base64 không hợp lệ");
  }
  if (!body || !body.length) throw new Error("Project thumbnail rỗng");
  if (body.length > MAX_PROJECT_THUMB_BYTES) {
    throw new Error("Project thumbnail vượt quá 2 MB");
  }
  return { contentType, body };
}

function normalizeCommentContent(raw, { suffix = "" } = {}) {
  if (typeof raw !== "string") throw new Error("content required");
  const content = raw.trim();
  if (!content) throw new Error("content required");
  const normalizedSuffix = String(suffix || "");
  if ((content + normalizedSuffix).length > MAX_COMMENT_CONTENT_CHARS) {
    throw new Error("Comment vượt quá " + MAX_COMMENT_CONTENT_CHARS + " ký tự");
  }
  return content + normalizedSuffix;
}

// Images placed on the frame by the sketch editor (logos, references). The
// browser re-encodes them (≤1600 px) before upload; we only check the bytes
// really are PNG/JPEG/WebP so the file can be served same-origin safely.
const MAX_ANNOTATION_IMAGE_BYTES = 3 * 1024 * 1024;
const ANNOTATION_IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
function sniffImageExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}
const safeDirName = (s) => /^[A-Za-z0-9_-]{1,80}$/.test(String(s || ""));

// Sketch images and images in a script share these: the body is { dataUrl },
// the file lands in `dir` under a random name whose extension comes from the bytes.
async function saveImageUpload(req, res, dir) {
  const body = await readJson(req, Math.ceil(MAX_ANNOTATION_IMAGE_BYTES * 1.4)).catch(() => null);
  const match = body && typeof body.dataUrl === "string" && body.dataUrl.match(/^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return bad(res, "Ảnh không hợp lệ hoặc lớn hơn 3 MB");
  const buf = Buffer.from(match[1], "base64");
  const ext = sniffImageExt(buf);
  if (!ext) return bad(res, "Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP");
  if (buf.length > MAX_ANNOTATION_IMAGE_BYTES) return bad(res, "Ảnh lớn hơn 3 MB");
  const id = randomBytes(12).toString("hex") + "." + ext;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), buf);
  return send(res, 201, { id, bytes: buf.length });
}
async function serveStoredImage(res, dir, imageId) {
  if (!ANNOTATION_IMAGE_ID.test(imageId)) return bad(res, "Not found", 404);
  const file = join(dir, imageId);
  let info;
  try { info = await stat(file); } catch (_) { return bad(res, "Not found", 404); }
  res.writeHead(200, { "content-type": ANNOTATION_IMAGE_TYPES[imageId.split(".").pop()], "content-length": info.size, "cache-control": "private, max-age=31536000, immutable" });
  createReadStream(file).pipe(res);
}

async function saveProjectThumbDataUrl(projectId, dataUrl) {
  const parsed = parseProjectThumbDataUrl(dataUrl);
  await mkdir(PROJECT_THUMB_DIR, { recursive: true });
  await writeFile(projectThumbRecordPath(projectId), "data:" + parsed.contentType + ";base64," + parsed.body.toString("base64"), "utf8");
}

async function clearProjectThumb(projectId) {
  try { await unlink(projectThumbRecordPath(projectId)); } catch (_) {}
}

async function loadProjectThumb(projectId) {
  try {
    const raw = String(await readFile(projectThumbRecordPath(projectId), "utf8") || "").trim();
    return parseProjectThumbDataUrl(raw);
  } catch (_) {
    return null;
  }
}

// ponytail: global cap so a few 30GB ZIPs can't starve the disks for review
// playback/transcode; per-user limits if this ever gets contended.
const MAX_ZIP_DOWNLOADS = 2;
let activeZipDownloads = 0;
// Stored paths may be posix (/volume1/…) or UNC (\\NAS\share\…).
const nasFileName = (p) => String(p).split(/[\\/]/).pop() || "video";

async function streamLocalMedia(req, res, filePath, contentType, downloadName) {
  const info = await stat(filePath);
  const total = info.size;
  if (downloadName) res.setHeader("content-disposition", attachmentDisposition(downloadName));
  const range = req.headers.range;
  if (range) {
    const match = String(range).match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.statusCode = 416;
      res.setHeader("content-range", "bytes */" + total);
      return res.end();
    }
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.statusCode = 416;
      res.setHeader("content-range", "bytes */" + total);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-range", `bytes ${start}-${end}/${total}`);
    res.setHeader("content-length", String(end - start + 1));
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "private, max-age=60");
    return createReadStream(filePath, { start, end }).pipe(res);
  }
  res.statusCode = 200;
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-length", String(total));
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "private, max-age=60");
  return createReadStream(filePath).pipe(res);
}

async function requireSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  const sess = await getSession(cookies[COOKIE_NAME]);
  if (!sess) { bad(res, "Unauthorized", 401); return null; }
  req.authUserId = sess.userId;
  return sess;
}

async function requireProjectAccess(res, projectId, userId, allowedRoles = null) {
  const member = await store.getProjectMember(projectId, userId);
  if (!member) { bad(res, "Forbidden", 403); return null; }
  if (allowedRoles && !allowedRoles.includes(member.role)) { bad(res, "Forbidden", 403); return null; }
  return member;
}

async function ensureProjectHasAnotherOwner(projectId, userId) {
  const members = await store.listProjectMembers(projectId);
  return members.some((member) => member.userId !== userId && member.role === "owner");
}

async function canManageUpdates(userId) {
  const members = await store.listProjectMembersForUser(userId).catch(() => []);
  return !!(members && members.some((member) => member.role === "owner"));
}

async function canBrowseNasLibrary(userId) {
  const members = await store.listProjectMembersForUser(userId).catch(() => []);
  return !!(members && members.some((member) => member.role === "owner" || member.role === "editor"));
}

// Kịch bản is for the team, not clients. A "client" is a global client account,
// or someone whose every project membership is the client role (DSM accounts
// invited only to review). Staff with no projects yet still get access.
async function canUseScripts(userId) {
  const [user, members] = await Promise.all([
    store.getUser(userId),
    store.listProjectMembersForUser(userId).catch(() => []),
  ]);
  if (!user || user.role === "client") return false;
  return !(members && members.length && members.every((m) => m.role === "client"));
}

const SCRIPT_STATUSES = ["draft", "review", "approved"];
// Project status (v2 UI): Đang dựng → Chờ duyệt → Cần sửa → Đã duyệt → Đã
// lên sóng, stored on the project's final video (see projectStatusOf).
// Independent from the proxy transcode `status`.
const REVIEW_STATUSES = ["edit", "wait", "fix", "ok", "air"];
const PREF_THEMES = ["dark", "light", "system"];
const PREF_VIEWS = ["grid", "list"];

// "48.2 GB" / "910 MB" → bytes, for the project's total size on the NAS.
function parseSizeLabel(label) {
  const m = String(label || "").trim().match(/^([\d.,]+)\s*(TB|GB|MB|KB|B)$/i);
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()];
  return Number.isFinite(n) ? n * mult : 0;
}
function formatBytesLabel(bytes) {
  if (!bytes) return "0 GB";
  if (bytes >= 1024 ** 4) return (bytes / 1024 ** 4).toFixed(1) + " TB";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  return Math.max(1, Math.round(bytes / 1024 ** 2)) + " MB";
}

function sanitizePrefs(current, body) {
  const next = { ...(current || {}) };
  if ("theme" in body && PREF_THEMES.includes(body.theme)) next.theme = body.theme;
  if ("hue" in body) {
    const h = Number(body.hue);
    if (Number.isFinite(h) && h >= 0 && h < 360) next.hue = Math.round(h);
  }
  if ("defaultView" in body && PREF_VIEWS.includes(body.defaultView)) next.defaultView = body.defaultView;
  return next;
}
const MAX_SCRIPT_BODY = 512 * 1024;

async function decorateScripts(list) {
  const [projects, users] = await Promise.all([store.listProjects(), store.listUsers()]);
  const pName = new Map(projects.map((p) => [p.id, p.name]));
  const uName = new Map(users.map((u) => [u.id, u.name]));
  return list.map(({ excerpt, ...s }) => ({
    ...s,
    projectName: s.projectId ? pName.get(s.projectId) || null : null,
    updatedByName: uName.get(s.updatedBy) || null,
    ...(excerpt !== undefined ? { previewLines: scriptPreviewLines(excerpt) } : {}),
  }));
}

// First few text lines of a script's HTML body, for the "page" thumbnail in
// the Kịch bản list. Block ends become line breaks; tags and entities go.
function scriptPreviewLines(htmlBody, max = 6) {
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  return String(htmlBody || "")
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k) => ENT[k])
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)
    .slice(0, max).map((l) => l.slice(0, 160));
}

async function decorateScriptComments(list) {
  const users = new Map((await store.listUsers()).map((u) => [u.id, u]));
  return list.map((c) => ({
    ...c,
    authorName: (users.get(c.authorUserId) || {}).name || "?",
    authorColor: (users.get(c.authorUserId) || {}).color || null,
    resolvedByName: c.resolvedBy ? (users.get(c.resolvedBy) || {}).name || null : null,
  }));
}

async function listVisibleUsersForUser(userId) {
  if (await canBrowseNasLibrary(userId)) return await store.listUsers();
  const self = await store.getUser(userId);
  return self ? [self] : [];
}

async function requireCommentWriteAccess(res, commentId, projectId, userId) {
  const [member, comment] = await Promise.all([
    store.getProjectMember(projectId, userId),
    store.getComment(commentId),
  ]);
  if (!member || !comment) {
    bad(res, "Forbidden", 403);
    return null;
  }
  if (["owner", "editor"].includes(member.role) || comment.authorUserId === userId) return comment;
  bad(res, "Forbidden", 403);
  return null;
}

// Size of the volume holding filesystem proxies (SPK: the package's var dir
// on the NAS), for the Cài đặt → Proxy cache meter. Absent for MinIO/sim.
async function proxyDiskUsage() {
  const info = hlsBackendInfo();
  if (info.backend !== "filesystem" || !info.outputDir) return {};
  try {
    const st = await statfs(info.outputDir);
    return { diskTotalBytes: st.blocks * st.bsize, diskFreeBytes: st.bavail * st.bsize };
  } catch (_) { return {}; }
}

async function buildProxyStoragePayload() {
  if (_proxyStorageCache && (Date.now() - _proxyStorageCache.at) < PROXY_STORAGE_CACHE_TTL_MS) {
    return _proxyStorageCache.data;
  }
  if (!_proxyStorageLastGood) {
    _proxyStorageLastGood = await loadProxyStorageSnapshotFromDisk();
  }
  const info = hlsBackendInfo();
  if (info.backend === "sim") {
    const data = { backend: info.backend, renditions: [], renditionCount: 0, totalBytes: 0, note: "Proxy storage chưa được cấu hình — chế độ sim không lưu file." };
    _proxyStorageCache = { at: Date.now(), data };
    _proxyStorageLastGood = data;
    return data;
  }
  try {
    // Both backends expose `{key,size}[]` from their list helper, so the
    // proxy report logic stays driver-agnostic. SPK builds use the
    // filesystem path; Docker stacks with MinIO keep the S3 path.
    const items = info.backend === "minio"
      ? await s3ListPrefix("")
      : await fsListPrefix("");
    const renditionIds = [...new Set(items
      .map((it) => String(it && it.key || ""))
      .map((key) => key.split("/")[0])
      .filter(Boolean))];
    const meta = await store.listRenditionProxyMeta(renditionIds);
    const report = buildProxyStorageReport(items, meta);
    const data = {
      backend: info.backend,
      bucket: info.backend === "minio" ? info.bucket : undefined,
      outputDir: info.backend === "filesystem" ? info.outputDir : undefined,
      renditionCount: report.renditions.length,
      stale: false,
      ...report,
    };
    _proxyStorageCache = { at: Date.now(), data };
    _proxyStorageLastGood = data;
    persistProxyStorageSnapshot(data).catch(() => {});
    return data;
  } catch (err) {
    const fallbackSource = _proxyStorageLastGood || await loadProxyStorageSnapshotFromDisk();
    if (fallbackSource) {
      _proxyStorageLastGood = fallbackSource;
      const fallback = {
        ...fallbackSource,
        stale: true,
        note: (fallbackSource.note ? (fallbackSource.note + " · ") : "")
          + "Đang hiển thị snapshot proxy gần nhất vì MinIO chưa phản hồi hoặc API vừa restart.",
      };
      _proxyStorageCache = { at: Date.now(), data: fallback };
      return fallback;
    }
    throw err;
  }
}

function invalidateProxyStorageCache() {
  _proxyStorageCache = null;
}

async function publishProjectEvent(projectId, event) {
  const userIds = await store.listProjectMemberUserIds(projectId);
  publishEvent({ ...event, projectId, userIds });
}

function guestCommentProfile(comment) {
  if (!comment || !comment.guestLabel) return null;
  return {
    name: comment.guestLabel,
    initial: comment.guestInitial || String(comment.guestLabel || "?").trim().charAt(0).toUpperCase() || "?",
    color: comment.guestColor || "#2bbe6e",
  };
}

function displayAuthorProfile(comment, fallbackUser) {
  const guest = guestCommentProfile(comment);
  if (guest) return guest;
  return {
    name: fallbackUser && fallbackUser.name || "Someone",
    initial: fallbackUser && fallbackUser.initial || "S",
    color: fallbackUser && fallbackUser.color || "#6c5cf6",
  };
}

async function notifyCommentWebhook({ comment, projectId, authorUserId }) {
  const [project, version, author] = await Promise.all([store.getProject(projectId), store.getVersion(comment.assetVersionId), store.getUser(authorUserId)]);
  const asset = version ? await store.getAsset(version.assetId) : null;
  const profile = displayAuthorProfile(comment, author);
  webhooks.notifyCommentCreated({
    projectName: project ? project.name : "Project",
    sourceTitle: asset ? asset.title : "(source)",
    authorName: profile.name,
    content: comment.content,
    projectId,
    timestampMs: comment.timestampMs || 0,
  });
}

async function notifyCommentByEmail({ comment, projectId, authorUserId }) {
  const [project, version, author, memberIds] = await Promise.all([
    store.getProject(projectId),
    store.getVersion(comment.assetVersionId),
    store.getUser(authorUserId),
    store.listProjectMemberUserIds(projectId),
  ]);
  const asset = version ? await store.getAsset(version.assetId) : null;
  const recipients = [];
  for (const uid of memberIds) {
    if (uid === authorUserId) continue;
    const u = await store.getUser(uid);
    if (u && u.email) recipients.push(u.email);
  }
  const profile = displayAuthorProfile(comment, author);
  mailer.notifyComment({
    recipients,
    projectName: project ? project.name : "Project",
    sourceTitle: asset ? asset.title : "(source)",
    authorName: profile.name,
    content: comment.content,
    projectId,
    timestampMs: comment.timestampMs || 0,
  });
}

function colorFromGuestLabel(label) {
  const palette = ["#2bbe6e", "#2da8e2", "#f5a623", "#a07bff", "#ef4d57", "#d9a45b"];
  const text = String(label || "").trim();
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function buildGuestIdentity(guestLabel) {
  const label = String(guestLabel || "").trim() || "Khách";
  return {
    guestLabel: label,
    guestInitial: label.charAt(0).toUpperCase() || "K",
    guestColor: colorFromGuestLabel(label),
  };
}

// ---------- routes ----------

async function handle(req, res, url) {
  const m = req.method || "GET";
  // In Docker stack, Caddy strips `/api/` before proxying to this process,
  // so routes below match `/health`, `/version`, `/projects`, etc. In SPK
  // mode (WEB_INLINE=1) the API serves the SPA and API on the same port —
  // no proxy, so the FE's `/api/foo` arrives here unstripped. Normalise
  // here so routes don't need two variants. /hls/ + /assets/ keep their
  // original path because those are public asset endpoints with their
  // own prefix conventions.
  let p = url.pathname;
  if (p.startsWith("/api/")) p = p.slice(4);
  else if (p === "/api") p = "/";
  const isMutation = m === "POST" || m === "PATCH" || m === "DELETE";

  if (!applyCors(req, res)) {
    res.statusCode = 403; res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Origin not allowed" }));
  }
  if (m === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204; return res.end();
  }

  if (isMutation && !isTrustedMutationRequest(req)) {
    return bad(res, "Cross-site mutation blocked", 403);
  }

  setSecurityHeaders(res);

  // Serve the SPA shell at "/" + "/index.html" BEFORE the auth gate further
  // down — the FE itself runs the DSM login flow against /api/auth/* so
  // requiring a session to load the shell would create a chicken-and-egg
  // unauthenticated loop. Only active when WEB_INLINE=1 (SPK build).
  if (await tryServeSpa(req, res, url)) return;

  if (p === "/health" && m === "GET") return send(res, 200, { ok: true, dsmConfigured: !dsm.isDevMode(), backend: store.backend });
  if (p === "/setup/status" && m === "GET") {
    // When server.js is running, runtime IS configured (via env or config file).
    // Force `configured: true` so the FE doesn't render the setup wizard.
    return send(res, 200, { ...publicRuntimeSummary(), configured: true });
  }
  if (p === "/version" && m === "GET") {
    return send(res, 200, buildLocalReleaseMeta());
  }
  // Synology Package Center "package source" — DSM polls this (GET on source
  // validation, form-encoded POST with arch codename on refresh) and gets a
  // catalog pointing at the newest GitHub release .spk. Public by design:
  // Package Center has no way to carry a session.
  if (p === "/spkserver" && (m === "GET" || m === "POST")) {
    let arch = url.searchParams.get("arch") || "";
    if (m === "POST") {
      const raw = await readBody(req, 65536).catch(() => "");
      arch = new URLSearchParams(raw).get("arch") || arch;
    }
    // Link DSM back to this same origin (and /api prefix) it just reached.
    const baseUrl = (isSecureRequest(req) ? "https" : "http") + "://" + String(req.headers.host || "") + (url.pathname.startsWith("/api/") ? "/api" : "");
    try { return send(res, 200, await buildSpkCatalog(arch, { mirrorDir: SPK_MIRROR_DIR, baseUrl })); }
    catch (err) { return send(res, 200, { packages: [], error: String(err && err.message || err) }); }
  }
  // The mirrored .spk (see spk-feed.js). Public like the GitHub asset it copies;
  // the name is allowlisted and must already be a verified file in the mirror.
  const spkMatch = p.match(/^\/spkserver\/spk\/([^/]+)$/);
  if (spkMatch && (m === "GET" || m === "HEAD")) {
    let name = "";
    try { name = decodeURIComponent(spkMatch[1]); } catch (_) {}
    const file = await mirrorPath(SPK_MIRROR_DIR, name);
    if (!file) return bad(res, "Not found", 404);
    return streamLocalMedia(req, res, file, "application/octet-stream");
  }
  if (p === "/metrics" && m === "GET") return sendMetrics(res);
  if (p === "/auth/dsm/login" && m === "POST") return handleLogin(req, res);
  if (p === "/auth/logout" && m === "POST") return handleLogout(req, res);
  if (p === "/auth/oidc/enabled" && m === "GET") return send(res, 200, { enabled: oidc.enabled() });
  if (p === "/auth/oidc/start" && m === "GET") return handleOidcStart(req, res);
  if (p === "/auth/oidc/callback" && m === "GET") return handleOidcCallback(req, res, url);

  // Public share endpoints (no DSM session required — anonymous reviewers).
  let _mat;
  if ((_mat = p.match(/^\/shared\/([^/]+)$/)) && m === "GET") return handleSharedRead(req, res, _mat[1]);
  if ((_mat = p.match(/^\/shared\/([^/]+)\/comments$/)) && m === "POST") return handleSharedComment(req, res, _mat[1]);

  let mat;
  // HLS proxy — session gated by default, but can also be accessed through a short-lived signed URL for CDN cache fills.
  if ((mat = p.match(/^\/hls\/([^/]+)\/([^/]+)$/)) && m === "GET") {
    const renditionId = mat[1];
    const file = mat[2];
    const signedPlayback = hasValidSignedPlaybackToken(renditionId, file, url.searchParams);
    if (!signedPlayback) {
      const sess = await requireSession(req, res);
      if (!sess) return;
      const projectId = await store.findProjectIdForRendition(renditionId);
      if (!projectId) { req.log.warn({ renditionId }, "hls: rendition lookup returned null"); return bad(res, "Rendition not found", 404); }
      const member = await store.getProjectMember(projectId, sess.userId);
      if (!member) { req.log.warn({ renditionId, projectId, userId: sess.userId }, "hls: getProjectMember returned null"); return bad(res, "Forbidden", 403); }
      req.log.info({ renditionId, projectId, userId: sess.userId, role: member.role }, "hls: auth ok");
    }
    return serveHls(req, res, renditionId, file, { signedPlayback });
  }

  const sess = await requireSession(req, res);
  if (!sess) return;

  // Speedtest is auth-gated so it can't be abused as a DDoS amplifier.
  // Cap raised to 128 MiB to support gigabit-class links: anything smaller
  // finishes too fast to overcome TCP slow-start + HTTP overhead, masking the
  // true throughput. Stream a reused 256 KiB random buffer instead of
  // allocating one huge Buffer (would spike RSS on every request).
  if (p === "/speedtest/segment" && m === "GET") {
    const sizeStr = url.searchParams.get("size") || "8388608";
    const size = Math.min(Math.max(parseInt(sizeStr, 10) || 8388608, 64 * 1024), 128 * 1024 * 1024);
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-length", String(size));
    const CHUNK = SPEEDTEST_NOISE; // 256 KiB
    let remaining = size;
    const writeMore = () => {
      while (remaining > 0) {
        const n = Math.min(CHUNK.length, remaining);
        const slice = n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n);
        const ok = res.write(slice);
        remaining -= n;
        if (!ok) { res.once("drain", writeMore); return; }
      }
      res.end();
    };
    writeMore();
    return;
  }

  if (p === "/me" && m === "GET") {
    const user = await store.getUser(sess.userId);
    return send(res, 200, {
      user: user && { ...user, prefs: user.prefs || {} },
      canUseScripts: await canUseScripts(sess.userId),
      canManageWorkspace: await canManageUpdates(sess.userId),
      canBrowseNas: await canBrowseNasLibrary(sess.userId),
    });
  }
  // Cài đặt → Giao diện: theme / accent hue / default list view, per account.
  if (p === "/me/prefs" && m === "PATCH") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object") return bad(res, "Invalid body");
    const user = await store.getUser(sess.userId);
    if (!user) return bad(res, "User not found", 404);
    const updated = await store.setUserPrefs(sess.userId, sanitizePrefs(user.prefs, body));
    return send(res, 200, { prefs: (updated && updated.prefs) || {} });
  }
  if (p === "/scripts" || p.startsWith("/scripts/") || p.startsWith("/script-comments/")) {
    if (!(await canUseScripts(sess.userId))) return bad(res, "Forbidden", 403);
    if (p === "/scripts" && m === "GET") return send(res, 200, await decorateScripts(await store.listScripts()));
    // A linked project must be one the caller can see, so a script can't be
    // pinned onto (and leak the name of) someone else's project.
    const checkProject = async (projectId) => {
      if (projectId === null) return true;
      if (typeof projectId !== "string" || !(await store.getProject(projectId))) { bad(res, "Project not found", 404); return false; }
      return !!(await requireProjectAccess(res, projectId, sess.userId));
    };
    if (p === "/scripts" && m === "POST") {
      const body = await readJson(req).catch(() => null);
      const title = body && typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
      if (!title) return bad(res, "title required");
      const projectId = body.projectId || null;
      if (!(await checkProject(projectId))) return;
      const s = await store.createScript({ title, projectId, userId: sess.userId });
      await audit.record({ actorUserId: sess.userId, action: "script.created", resourceType: "script", resourceId: s.id, projectId: projectId || undefined, payload: { title } });
      return send(res, 201, (await decorateScripts([s]))[0]);
    }
    if ((mat = p.match(/^\/scripts\/([^/]+)$/))) {
      const id = mat[1];
      const current = await store.getScript(id);
      if (!current) return bad(res, "Script not found", 404);
      if (m === "GET") {
        const [[decorated], comments] = await Promise.all([decorateScripts([current]), store.listScriptComments(id)]);
        return send(res, 200, { ...decorated, comments: await decorateScriptComments(comments) });
      }
      if (m === "PATCH") {
        const body = await readJson(req).catch(() => null);
        if (!body) return bad(res, "Invalid body");
        const patch = {};
        if ("title" in body) {
          const t = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
          if (!t) return bad(res, "title required");
          patch.title = t;
        }
        if ("body" in body) {
          if (typeof body.body !== "string" || body.body.length > MAX_SCRIPT_BODY) return bad(res, "body must be a string up to 512KB");
          patch.body = body.body;
        }
        if ("status" in body) {
          if (!SCRIPT_STATUSES.includes(body.status)) return bad(res, "invalid status");
          patch.status = body.status;
        }
        if ("projectId" in body) {
          patch.projectId = body.projectId || null;
          if (!(await checkProject(patch.projectId))) return;
        }
        if (("title" in patch || "body" in patch) && !Number.isInteger(body.baseVersion)) return bad(res, "baseVersion required");
        const r = await store.updateScript(id, patch, { baseVersion: body.baseVersion, userId: sess.userId });
        if (!r) return bad(res, "Script not found", 404);
        const [decorated] = await decorateScripts([r.script]);
        if (r.conflict) return send(res, 409, { error: "Kịch bản vừa được người khác sửa", script: decorated });
        if ("status" in patch && patch.status !== current.status) {
          await audit.record({ actorUserId: sess.userId, action: "script.status_changed", resourceType: "script", resourceId: id, payload: { from: current.status, to: patch.status } });
        }
        return send(res, 200, decorated);
      }
      if (m === "DELETE") {
        await store.deleteScript(id);
        if (safeDirName(id)) await rm(join(SCRIPT_IMAGE_DIR, id), { recursive: true, force: true }).catch(() => {});
        await audit.record({ actorUserId: sess.userId, action: "script.deleted", resourceType: "script", resourceId: id, payload: { title: current.title } });
        return send(res, 200, { ok: true });
      }
    }
    // Images in the text: stored beside the script, the body only names them
    // (<img data-image-id>), so the HTML stays small and works from any address.
    if ((mat = p.match(/^\/scripts\/([^/]+)\/images(?:\/([^/]+))?$/))) {
      const id = mat[1], imageId = mat[2];
      if (!safeDirName(id) || !(await store.getScript(id))) return bad(res, "Script not found", 404);
      if (m === "GET" && imageId) return serveStoredImage(res, join(SCRIPT_IMAGE_DIR, id), imageId);
      if (m === "POST" && !imageId) return saveImageUpload(req, res, join(SCRIPT_IMAGE_DIR, id));
      return bad(res, "Method not allowed", 405);
    }
    if ((mat = p.match(/^\/scripts\/([^/]+)\/comments$/)) && m === "POST") {
      if (!(await store.getScript(mat[1]))) return bad(res, "Script not found", 404);
      const body = await readJson(req).catch(() => null);
      const content = body && typeof body.content === "string" ? body.content.trim().slice(0, 4000) : "";
      if (!content) return bad(res, "content required");
      // Replies always hang off the thread root (no nesting), like Docs.
      let parentId = null;
      if (body.parentId) {
        const parent = await store.getScriptComment(String(body.parentId));
        if (!parent || parent.scriptId !== mat[1]) return bad(res, "Parent comment not found", 404);
        parentId = parent.parentId || parent.id;
      }
      const quote = !parentId && typeof body.quote === "string" && body.quote.trim() ? body.quote.trim().slice(0, 500) : null;
      const c = await store.addScriptComment({ scriptId: mat[1], userId: sess.userId, content, quote, parentId });
      return send(res, 201, (await decorateScriptComments([c]))[0]);
    }
    if ((mat = p.match(/^\/script-comments\/([^/]+)$/)) && (m === "PATCH" || m === "DELETE")) {
      const c = await store.getScriptComment(mat[1]);
      if (!c) return bad(res, "Comment not found", 404);
      if (m === "DELETE") {
        if (c.authorUserId !== sess.userId) return bad(res, "Forbidden", 403);
        await store.deleteScriptComment(c.id);
        return send(res, 200, { ok: true });
      }
      const body = await readJson(req).catch(() => null);
      if (!body) return bad(res, "Invalid body");
      const patch = {};
      if ("content" in body) {
        // only the author rewrites their words; anyone on the team may resolve
        if (c.authorUserId !== sess.userId) return bad(res, "Forbidden", 403);
        const content = typeof body.content === "string" ? body.content.trim().slice(0, 4000) : "";
        if (!content) return bad(res, "content required");
        patch.content = content;
      }
      if ("resolved" in body) {
        if (c.parentId) return bad(res, "Only a thread can be resolved");
        patch.resolved = !!body.resolved;
        patch.resolvedBy = sess.userId;
      }
      const updated = await store.updateScriptComment(c.id, patch);
      return send(res, 200, (await decorateScriptComments([updated]))[0]);
    }
    return bad(res, "Not found", 404);
  }

  if (p === "/nas/thumb" && m === "GET") {
    const path = url.searchParams.get("path") || "";
    if (!path) return bad(res, "path required");
    try {
      const file = await dsm.getFileMeta(sess.dsmSid, path);
      if (!file || !file.isVideo || !file.path) return bad(res, "Video not found", 404);
      const seekMs = Math.min(Math.max(1000, Math.round((file.durationMs || 0) * 0.1)), Math.max(1000, (file.durationMs || 0) - 1000));
      const thumbPath = await dsm.ensureVideoThumbnail(file.path, path + ":" + (file.durationMs || 0), { seekMs });
      return sendBinary(res, 200, await readFile(thumbPath), "image/jpeg");
    } catch (err) {
      req.log.warn({ err: String(err && err.message || err), path }, "nas thumb fallback placeholder");
      return sendThumbPlaceholder(res, "NAS video");
    }
  }

  if (p === "/events" && m === "GET") {
    return sseSubscribe(req, res, sess.userId);
  }

  if (p === "/projects" && m === "GET") {
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const list = await store.listProjectsForUser(sess.userId, { includeArchived });
    const decorated = await Promise.all(list.map((project) => decorateProject(project, sess.userId)));
    return send(res, 200, decorated);
  }
  // Workspace calendar: every airing (video with an air date) the user can see,
  // within [from, to] ISO dates. Aggregates across all accessible projects so
  // the Lịch view shows the whole studio's broadcast schedule in one place.
  if (p === "/calendar" && m === "GET") {
    const from = String(url.searchParams.get("from") || "").slice(0, 10);
    const to = String(url.searchParams.get("to") || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return bad(res, "from and to (YYYY-MM-DD) required");
    }
    const projects = await store.listProjectsForUser(sess.userId, { includeArchived: false });
    const items = [];
    for (const project of projects) {
      if (project.archivedAt) continue;
      const d = project.airDate;
      if (!d || d < from || d > to) continue;
      const all = await store.listAssetsByProject(project.id);
      const assets = all.filter((a) => !isFinal(a));
      const finals = finalsOf(all);
      const cur = finals[finals.length - 1];
      items.push({
        projectId: project.id,
        projectName: project.name,
        airDate: d,
        videoCount: assets.length,
        confirmed: !!project.airConfirmedAt,
        finalStatus: cur ? cur.reviewStatus : null,
        finalRound: finals.length,
        paletteA: project.paletteA || (assets[0] && assets[0].paletteA) || "#15171c",
        paletteB: project.paletteB || (assets[0] && assets[0].paletteB) || "#3a4453",
      });
    }
    items.sort((x, y) => x.airDate.localeCompare(y.airDate) || x.projectName.localeCompare(y.projectName));
    return send(res, 200, items);
  }
  // "Chờ bạn review": every video in the caller's active projects that an
  // editor has moved to Chờ review, newest first.
  if (p === "/review-queue" && m === "GET") {
    const projects = await store.listProjectsForUser(sess.userId, { includeArchived: false });
    const items = [];
    const names = new Map();
    const userName = async (id) => {
      if (!id) return "";
      if (!names.has(id)) { const u = await store.getUser(id); names.set(id, u ? u.name : ""); }
      return names.get(id);
    };
    for (const project of projects) {
      if (project.archivedAt) continue;
      for (const a of await store.listAssetsByProject(project.id)) {
        if (!isFinal(a) || a.reviewStatus !== "wait") continue;
        items.push({
          projectId: project.id, projectName: project.name, client: project.client || "",
          assetId: a.id, kind: a.kind || "source", title: a.title, durationMs: a.durationMs || 0, versionsCount: a.versionsCount || 1,
          openCommentsCount: a.openCommentsCount || 0, paletteA: a.paletteA, paletteB: a.paletteB,
          posterUrl: "/assets/" + a.id + "/poster",
          sentBy: await userName(a.reviewStatusBy), sentAt: a.reviewStatusAt || null,
        });
      }
    }
    items.sort((x, y) => String(y.sentAt || "").localeCompare(String(x.sentAt || "")));
    return send(res, 200, items);
  }
  // Cài đặt → Thành viên & quyền. Roles are per project; this view lists the
  // people the caller can see and their role across the projects the caller
  // owns. Setting a role applies it to every such project they belong to.
  if (p === "/workspace/members" && m === "GET") {
    const users = await listVisibleUsersForUser(sess.userId);
    const mine = (await store.listProjectMembersForUser(sess.userId)).filter((x) => x.role === "owner").map((x) => x.projectId);
    const out = [];
    for (const u of users) {
      const roles = {};
      let projects = 0;
      for (const pid of mine) {
        const mem = await store.getProjectMember(pid, u.id);
        if (!mem) continue;
        projects++;
        roles[mem.role] = (roles[mem.role] || 0) + 1;
      }
      const top = Object.entries(roles).sort((a, b) => b[1] - a[1])[0];
      out.push({ user: u, isMe: u.id === sess.userId, projects, role: top ? top[0] : null, mixed: Object.keys(roles).length > 1, roles });
    }
    return send(res, 200, { ownedProjects: mine.length, members: out });
  }
  if ((mat = p.match(/^\/workspace\/members\/([^/]+)$/)) && m === "PATCH") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    const targetUserId = decodeURIComponent(mat[1]);
    if (targetUserId === sess.userId) return bad(res, "Không đổi quyền của chính bạn", 409);
    const body = await readJson(req).catch(() => null);
    if (!body || !["editor", "reviewer", "client"].includes(body.role)) return bad(res, "valid role required");
    const mine = (await store.listProjectMembersForUser(sess.userId)).filter((x) => x.role === "owner").map((x) => x.projectId);
    let changed = 0;
    for (const pid of mine) {
      const mem = await store.getProjectMember(pid, targetUserId);
      if (!mem || mem.role === body.role) continue;
      if (mem.role === "owner" && !(await ensureProjectHasAnotherOwner(pid, targetUserId))) continue;
      await store.setProjectMemberRole(pid, targetUserId, body.role);
      await audit.record({ actorUserId: sess.userId, action: "project.member_role_changed", resourceType: "project_member", resourceId: targetUserId, projectId: pid, payload: { role: body.role, via: "workspace" } });
      changed++;
    }
    return send(res, 200, { ok: true, changed });
  }
  // Cài đặt → Proxy: renditions the worker is encoding right now.
  if (p === "/transcode-queue" && m === "GET") {
    const running = await store.listProcessingRenditions();
    const meta = running.length ? await store.listRenditionProxyMeta(running.map((r) => r.id)) : [];
    const byId = new Map(meta.map((x) => [x.renditionId, x]));
    return send(res, 200, running.map((r) => {
      const x = byId.get(r.id) || {};
      return { renditionId: r.id, label: r.label, height: r.height, progress: r.progress || 0, assetId: x.assetId || null, assetTitle: x.assetTitle || "", projectName: x.projectName || "" };
    }));
  }
  // Cài đặt → Proxy: HLS segment length + rungs queued on import. Persisted to
  // runtime-config.json when the box was set up through it (SPK); otherwise
  // (env-configured dev/Docker) applied to this process only.
  if (p === "/admin/proxy-settings" && (m === "GET" || m === "PATCH")) {
    if (m === "PATCH") {
      if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
      const body = await readJson(req).catch(() => null);
      if (!body || typeof body !== "object") return bad(res, "Invalid body");
      const cfg = readRuntimeConfig();
      const cur = currentProxySettings();
      const next = {
        hlsSegmentSeconds: "hlsSegmentSeconds" in body ? body.hlsSegmentSeconds : cur.hlsSegmentSeconds,
        autoRungs: "autoRungs" in body ? body.autoRungs : cur.autoRungs,
      };
      try {
        if (cfg) {
          const written = writeRuntimeConfig({ ...cfg, transcode: { ...(cfg.transcode || {}), ...next } });
          applyRuntimeEnvFromConfig(written);
        } else {
          process.env.HLS_SEGMENT_SECONDS = String(Number(next.hlsSegmentSeconds) === 6 ? 6 : 4);
          process.env.PROXY_AUTO_RUNGS = (Array.isArray(next.autoRungs) ? next.autoRungs : []).map(Number).filter((h) => h === 720 || h === 1080).join(",");
        }
      } catch (err) {
        return bad(res, "Không lưu được cấu hình proxy: " + ((err && err.message) || "lỗi"), 400);
      }
      await audit.record({ actorUserId: sess.userId, action: "runtime.proxy_settings_updated", resourceType: "runtime_config", resourceId: "proxy", payload: currentProxySettings() });
    }
    return send(res, 200, { ...currentProxySettings(), persisted: !!readRuntimeConfig() });
  }
  if (p === "/project-templates" && m === "GET") {
    return send(res, 200, await store.listProjectTemplates());
  }
  if (p === "/project-templates" && m === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body.name !== "string" || !body.name.trim()) return bad(res, "name required");
    const sourceProjectId = body.sourceProjectId && typeof body.sourceProjectId === "string" ? body.sourceProjectId : null;
    if (sourceProjectId && !(await requireProjectAccess(res, sourceProjectId, sess.userId))) return;
    const template = await store.createProjectTemplate({
      name: body.name.trim(),
      description: body.description && typeof body.description === "string" ? body.description.trim() : "",
      sourceProjectId,
      defaultClient: body.defaultClient && typeof body.defaultClient === "string" ? body.defaultClient.trim() : "",
      createdByUserId: sess.userId,
    });
    await audit.record({ actorUserId: sess.userId, action: "project_template.created", resourceType: "project_template", resourceId: template.id, projectId: sourceProjectId, payload: { name: template.name, sourceProjectId } });
    return send(res, 201, template);
  }
  if (p === "/projects" && m === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body.name !== "string" || !body.name.trim()) return bad(res, "name required");
    const proj = await store.createProject({ name: body.name.trim(), client: (body.client || "").trim(), ownerUserId: sess.userId });
    await audit.record({ actorUserId: sess.userId, action: "project.created", resourceType: "project", resourceId: proj.id, projectId: proj.id, payload: { name: proj.name, client: proj.client } });
    return send(res, 201, await decorateProject(proj, sess.userId));
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/duplicate$/)) && m === "POST") {
    const sourceId = mat[1];
    if (!(await requireProjectAccess(res, sourceId, sess.userId))) return;
    const body = await readJson(req).catch(() => null);
    const proj = await store.duplicateProject(sourceId, { newName: body && typeof body.name === "string" ? body.name.trim() : null, ownerUserId: sess.userId });
    if (!proj) return bad(res, "Source project not found", 404);
    await audit.record({ actorUserId: sess.userId, action: "project.duplicated", resourceType: "project", resourceId: proj.id, projectId: proj.id, payload: { sourceProjectId: sourceId, name: proj.name } });
    return send(res, 201, await decorateProject(proj, sess.userId));
  }
  if ((mat = p.match(/^\/project-templates\/([^/]+)\/create$/)) && m === "POST") {
    const templateId = mat[1];
    const template = await store.getProjectTemplate(templateId);
    if (!template) return bad(res, "Template not found", 404);
    if (template.sourceProjectId && !(await requireProjectAccess(res, template.sourceProjectId, sess.userId))) return;
    const body = await readJson(req).catch(() => null);
    const proj = await store.createProjectFromTemplate(templateId, {
      name: body && typeof body.name === "string" ? body.name.trim() : "",
      client: body && typeof body.client === "string" ? body.client.trim() : "",
      ownerUserId: sess.userId,
    });
    if (!proj) return bad(res, "Template could not be instantiated", 404);
    await audit.record({ actorUserId: sess.userId, action: "project.created_from_template", resourceType: "project", resourceId: proj.id, projectId: proj.id, payload: { templateId, templateName: template.name } });
    return send(res, 201, await decorateProject(proj, sess.userId));
  }
  if ((mat = p.match(/^\/projects\/([^/]+)$/))) {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (m === "GET") {
      const proj = await store.getProject(projectId);
      if (!proj) return bad(res, "Project not found", 404);
      return send(res, 200, await decorateProject(proj, sess.userId));
    }
    if (m === "PATCH") {
      if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
      const body = await readJson(req).catch(() => null);
      if (!body) return bad(res, "Invalid body");
      if (Object.prototype.hasOwnProperty.call(body, "thumbDataUrl")) {
        const thumbDataUrl = typeof body.thumbDataUrl === "string" ? body.thumbDataUrl.trim() : "";
        try {
          if (thumbDataUrl) await saveProjectThumbDataUrl(projectId, thumbDataUrl);
          else await clearProjectThumb(projectId);
        } catch (err) {
          return bad(res, (err && err.message) || "Project thumbnail không hợp lệ");
        }
      }
      if ("airDate" in body && body.airDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.airDate))) {
        return bad(res, "airDate must be YYYY-MM-DD or null");
      }
      const patch = { ...body };
      delete patch.thumbDataUrl;
      // The confirmation only comes from approving the final; a manager who
      // isn't the owner moving the date turns it back into a plan.
      delete patch.airConfirmedAt; delete patch.airConfirmedBy;
      if ("airDate" in patch) {
        const member = await store.getProjectMember(projectId, sess.userId);
        const before = await store.getProject(projectId);
        if (before && before.airConfirmedAt && patch.airDate !== before.airDate && (!member || member.role !== "owner")) patch.airConfirmedAt = null;
      }
      const updated = await store.patchProject(projectId, patch);
      if (!updated) return bad(res, "Project not found", 404);
      await audit.record({ actorUserId: sess.userId, action: "project.update", resourceType: "project", resourceId: projectId, projectId, payload: body });
      return send(res, 200, await decorateProject(updated, sess.userId));
    }
    if (m === "DELETE") {
      if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
      const project = await store.getProject(projectId);
      if (!project) return bad(res, "Project not found", 404);
      const deleted = await store.deleteProject(projectId);
      if (!deleted) return bad(res, "Project not found", 404);
      await audit.record({ actorUserId: sess.userId, action: "project.deleted", resourceType: "project", resourceId: projectId, projectId, payload: { name: project.name } });
      return send(res, 200, { ok: true, projectId });
    }
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/thumb$/)) && m === "GET") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const customThumb = await loadProjectThumb(projectId);
    if (customThumb) return sendBinary(res, 200, customThumb.body, customThumb.contentType);
    const assets = await store.listAssetsByProject(projectId);
    const firstAsset = pickProjectThumbAsset(projectId, assets);
    if (!firstAsset || !firstAsset.nasPath) return bad(res, "Project thumb not found", 404);
    try {
      const seekMs = Math.min(Math.max(1000, Math.round((firstAsset.durationMs || 0) * 0.1)), Math.max(1000, (firstAsset.durationMs || 0) - 1000));
      const thumbPath = await dsm.ensureVideoThumbnail(firstAsset.nasPath, "project:" + projectId + ":" + firstAsset.id + ":" + (firstAsset.durationMs || 0), { seekMs });
      return sendBinary(res, 200, await readFile(thumbPath), "image/jpeg");
    } catch (err) {
      req.log.warn({ err: String(err && err.message || err), projectId, assetId: firstAsset.id }, "project thumb fallback placeholder");
      // ?fallback=none: the v2 UI paints its own gradient instead of the SVG.
      if (url.searchParams.get("fallback") === "none") return bad(res, "Thumb unavailable", 404);
      return sendThumbPlaceholder(res, firstAsset.title || "Project");
    }
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/audit$/)) && m === "GET") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    return send(res, 200, await audit.listForProject(projectId, limit));
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/audit\.csv$/)) && m === "GET") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
    const entries = await audit.listForProject(projectId, 5000);
    res.statusCode = 200;
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="audit-${projectId}-${Date.now()}.csv"`);
    const csvCell = (v) => { const s = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.write("created_at,actor_user_id,action,resource_type,resource_id,payload\n");
    for (const e of entries) {
      res.write([e.createdAt, e.actorUserId, e.action, e.resourceType, e.resourceId, e.payload].map(csvCell).join(",") + "\n");
    }
    return res.end();
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/archive$/)) && m === "POST") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
    const archived = await store.archiveProject(projectId);
    if (!archived) return bad(res, "Project not found or already archived", 404);
    await audit.record({ actorUserId: sess.userId, action: "project.archived", resourceType: "project", resourceId: projectId, projectId });
    if (webhooks.enabled()) {
      const actor = await store.getUser(sess.userId);
      webhooks.notifyProjectArchived({ projectName: archived.name, actorName: actor ? actor.name : "Someone", projectId });
    }
    return send(res, 200, await decorateProject(archived, sess.userId));
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/restore$/)) && m === "POST") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
    const restored = await store.restoreProject(projectId);
    if (!restored) return bad(res, "Project not found or not archived", 404);
    await audit.record({ actorUserId: sess.userId, action: "project.restored", resourceType: "project", resourceId: projectId, projectId });
    return send(res, 200, await decorateProject(restored, sess.userId));
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/members$/))) {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (m === "GET") {
      const members = await store.listProjectMembers(projectId);
      const enriched = await Promise.all(members.map(async (member) => ({ ...member, user: await store.getUser(member.userId) })));
      return send(res, 200, enriched);
    }
    if (m === "POST") {
      if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
      const body = await readJson(req).catch(() => null);
      if (!body || !["owner", "editor", "reviewer", "client"].includes(body.role)) {
        return bad(res, "valid role required");
      }
      // Two paths:
      // 1) body.userId — existing user in our DB (dropdown picker case)
      // 2) body.dsmUsername — pre-create a placeholder user record now; when
      //    that DSM user first logs in, upsertUserFromDsm reconciles by name.
      let user = null;
      if (typeof body.userId === "string" && body.userId.trim()) {
        user = await store.getUser(body.userId);
        if (!user) return bad(res, "User not found", 404);
      } else if (typeof body.dsmUsername === "string" && body.dsmUsername.trim()) {
        const dsmName = body.dsmUsername.trim();
        // Hash username to a stable numeric pseudo-uid so upsertUserFromDsm
        // can generate a deterministic id. Real DSM uid will replace this on
        // first login (upsertUserFromDsm matches on dsm_uid OR name alias).
        let hash = 0;
        for (let i = 0; i < dsmName.length; i++) hash = (hash * 31 + dsmName.charCodeAt(i)) >>> 0;
        const pseudoUid = (hash % 1000000) + 100000; // keep out of low-range DSM uids
        user = await store.upsertUserFromDsm({ uid: pseudoUid, name: dsmName, email: body.dsmEmail || null });
      } else {
        return bad(res, "userId hoặc dsmUsername là bắt buộc");
      }
      const member = await store.upsertProjectMember(projectId, user.id, body.role);
      const project = await store.getProject(projectId);
      await audit.record({ actorUserId: sess.userId, action: "project.member_added", resourceType: "project_member", resourceId: user.id, projectId, payload: { role: body.role, userName: user.name } });
      return send(res, 201, { ...member, user, teamUserIds: project && project.teamUserIds });
    }
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/members\/([^/]+)$/)) && m === "PATCH") {
    const projectId = mat[1];
    const targetUserId = mat[2];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
    const body = await readJson(req).catch(() => null);
    if (!body || !["owner", "editor", "reviewer", "client"].includes(body.role)) return bad(res, "valid role required");
    const current = await store.getProjectMember(projectId, targetUserId);
    if (!current) return bad(res, "Member not found", 404);
    if (current.role === "owner" && body.role !== "owner") {
      const hasAnotherOwner = await ensureProjectHasAnotherOwner(projectId, targetUserId);
      if (!hasAnotherOwner) return bad(res, "Project must keep at least one owner", 409);
    }
    const member = await store.setProjectMemberRole(projectId, targetUserId, body.role);
    if (!member) return bad(res, "Member not found", 404);
    await audit.record({ actorUserId: sess.userId, action: "project.member_role_changed", resourceType: "project_member", resourceId: targetUserId, projectId, payload: { role: body.role } });
    return send(res, 200, { ...member, user: await store.getUser(targetUserId) });
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/members\/([^/]+)$/)) && m === "DELETE") {
    const projectId = mat[1];
    const targetUserId = mat[2];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
    const current = await store.getProjectMember(projectId, targetUserId);
    if (!current) return bad(res, "Member not found", 404);
    if (current.role === "owner") {
      const hasAnotherOwner = await ensureProjectHasAnotherOwner(projectId, targetUserId);
      if (!hasAnotherOwner) return bad(res, "Project must keep at least one owner", 409);
    }
    const removed = await store.removeProjectMember(projectId, targetUserId);
    if (!removed) return bad(res, "Member not found", 404);
    await audit.record({ actorUserId: sess.userId, action: "project.member_removed", resourceType: "project_member", resourceId: targetUserId, projectId });
    return send(res, 200, { ok: true, removed });
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/sources$/)) && m === "GET") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (!(await store.getProject(projectId))) return bad(res, "Project not found", 404);
    let assets = await store.listAssetsByProject(projectId);
    // Backfill duration/dimensions for assets imported before ffprobe worked on
    // this box (they were stored with durationMs=0). The probe is header-only and
    // cached, so this runs once per asset; afterwards the values are non-zero and
    // this loop is skipped. Best-effort — a probe failure leaves the 0 in place.
    const stale = assets.filter((a) => a && a.nasPath && !(Number(a.durationMs) > 0));
    if (stale.length) {
      await Promise.allSettled(stale.map(async (a) => {
        const meta = await dsm.getFileMeta(sess.dsmSid, a.nasPath).catch(() => null);
        if (meta && Number(meta.durationMs) > 0) {
          await store.patchAsset(a.id, {
            durationMs: meta.durationMs,
            frameRate: meta.frameRate || 0,
            width: meta.width || 0,
            height: meta.height || 0,
            resolutionLabel: meta.resolutionLabel || "",
            codec: meta.codec || a.codec,
          }).catch(() => {});
        }
      }));
      assets = await store.listAssetsByProject(projectId);
    }
    return send(res, 200, assets);
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/download\.zip$/)) && m === "GET") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const project = await store.getProject(projectId);
    if (!project) return bad(res, "Project not found", 404);
    const entries = [], missing = [], used = new Set();
    for (const a of await store.listAssetsByProject(projectId)) {
      const localPath = a.nasPath ? await dsm.assertReadableSourcePath(a.nasPath, { actor: "api" }).catch(() => null) : null;
      const info = localPath ? await stat(localPath).catch(() => null) : null;
      if (!info || !info.isFile()) { missing.push(a.title); continue; }
      // Same file name from two NAS folders → "x (2).mp4"
      const base = nasFileName(a.nasPath), dot = base.lastIndexOf(".");
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
      used.add(name.toLowerCase());
      entries.push({ name, path: localPath, size: info.size, mtime: info.mtime });
    }
    const bytes = zipLength(entries);
    // The FE asks first (?check=1) so a 404/429 becomes a toast instead of the
    // browser navigating to this JSON.
    if (url.searchParams.get("check") === "1") return send(res, 200, { files: entries.length, bytes, missing, busy: activeZipDownloads >= MAX_ZIP_DOWNLOADS });
    if (!entries.length) return bad(res, "Không có file gốc nào trên NAS", 404);
    if (activeZipDownloads >= MAX_ZIP_DOWNLOADS) return bad(res, "Đang có quá nhiều lượt tải ZIP, thử lại sau", 429);
    activeZipDownloads++;
    res.once("close", () => { activeZipDownloads--; });
    await audit.record({ actorUserId: sess.userId, action: "project.downloaded", resourceType: "project", resourceId: projectId, projectId, payload: { files: entries.length, bytes } });
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-length", String(bytes));
    res.setHeader("content-disposition", attachmentDisposition((project.name || "coopeditor").replace(/[\\/:*?"<>|]/g, "_") + ".zip"));
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no"); // DSM's nginx: stream, don't spool to disk
    try { await writeZip(res, entries); res.end(); }
    catch (err) { req.log.warn({ err: String(err && err.message || err), projectId }, "zip download aborted"); res.destroy(); }
    return;
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/sources\/reorder$/)) && m === "PATCH") {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
    if (!(await store.getProject(projectId))) return bad(res, "Project not found", 404);
    const body = await readJson(req).catch(() => null);
    if (!body || !Array.isArray(body.orderedAssetIds)) return bad(res, "orderedAssetIds required");
    await store.reorderAssets(projectId, body.orderedAssetIds);
    return send(res, 200, await store.listAssetsByProject(projectId));
  }
  if ((mat = p.match(/^\/assets\/([^/]+)$/))) {
    const assetId = mat[1];
    const projectId = await store.findProjectIdForAsset(assetId);
    if (!projectId) return bad(res, "Asset not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (m === "PATCH") {
      if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
      const body = await readJson(req).catch(() => null);
      if (!body) return bad(res, "Invalid body");
      // air date must be a plain ISO day or null (clear) — reject anything else
      // at the trust boundary so a bad value can't land in the DB.
      if ("airDate" in body && body.airDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.airDate))) {
        return bad(res, "airDate must be YYYY-MM-DD or null");
      }
      delete body.reviewStatusBy;
      if ("reviewStatus" in body) {
        if (!REVIEW_STATUSES.includes(body.reviewStatus)) return bad(res, "reviewStatus must be one of " + REVIEW_STATUSES.join("|"));
        const current = await store.getAsset(assetId);
        // Status belongs to the project and follows its final; source videos have none.
        if (!isFinal(current)) return bad(res, "Video nguồn không có trạng thái riêng — trạng thái nằm ở dự án, theo video Final");
        if (["ok", "fix", "air"].includes(body.reviewStatus)) {
          if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner"]))) return;
        }
        body.reviewStatusBy = sess.userId;
      }
      const updated = await store.patchAsset(assetId, body);
      if (!updated) return bad(res, "Asset not found", 404);
      await audit.record({ actorUserId: sess.userId, action: "asset.updated", resourceType: "asset", resourceId: assetId, projectId, payload: body });
      await publishProjectEvent(projectId, { type: "asset", action: "updated", assetId });
      return send(res, 200, updated);
    }
    if (m === "DELETE") {
      if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
      const asset = await store.getAsset(assetId);
      if (!asset) return bad(res, "Asset not found", 404);
      const deleted = await store.deleteAsset(assetId);
      if (!deleted) return bad(res, "Asset not found", 404);
      await audit.record({ actorUserId: sess.userId, action: "asset.deleted", resourceType: "asset", resourceId: assetId, projectId, payload: { title: asset.title } });
      await publishProjectEvent(projectId, { type: "asset", action: "deleted", assetId });
      return send(res, 200, { ok: true, assetId });
    }
  }
  if ((mat = p.match(/^\/assets\/([^/]+)\/poster$/)) && m === "GET") {
    const assetId = mat[1];
    const projectId = await store.findProjectIdForAsset(assetId);
    if (!projectId) return bad(res, "Asset not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const asset = await store.getAsset(assetId);
    if (!asset || !asset.nasPath) return bad(res, "Asset not found", 404);
    try {
      const seekMs = Math.min(Math.max(1000, Math.round((asset.durationMs || 0) * 0.1)), Math.max(1000, (asset.durationMs || 0) - 1000));
      const thumbPath = await dsm.ensureVideoThumbnail(asset.nasPath, "asset:" + asset.id + ":" + (asset.durationMs || 0), { seekMs });
      return sendBinary(res, 200, await readFile(thumbPath), "image/jpeg");
    } catch (err) {
      req.log.warn({ err: String(err && err.message || err), assetId, nasPath: asset.nasPath }, "asset poster fallback placeholder");
      if (url.searchParams.get("fallback") === "none") return bad(res, "Poster unavailable", 404);
      return sendThumbPlaceholder(res, asset.title || "Video");
    }
  }
  // Review filmstrip: frame i of n evenly spaced through the video, small JPEG.
  // Cached on disk per (asset, slot, duration) like posters; at most
  // FRAME_CONCURRENCY ffmpeg runs at once so opening a long 4K source doesn't
  // flood the NAS CPU.
  if ((mat = p.match(/^\/assets\/([^/]+)\/frame$/)) && m === "GET") {
    const assetId = mat[1];
    const projectId = await store.findProjectIdForAsset(assetId);
    if (!projectId) return bad(res, "Asset not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const asset = await store.getAsset(assetId);
    if (!asset || !asset.nasPath) return bad(res, "Asset not found", 404);
    const n = Math.min(48, Math.max(1, parseInt(url.searchParams.get("n") || "18", 10) || 18));
    const i = Math.min(n - 1, Math.max(0, parseInt(url.searchParams.get("i") || "0", 10) || 0));
    const dur = Number(asset.durationMs) || 0;
    const seekMs = dur > 0 ? Math.round((dur * (i + 0.5)) / n) : 1000;
    try {
      const thumbPath = await withFrameSlot(() => dsm.ensureVideoThumbnail(asset.nasPath, "frame:" + asset.id + ":" + n + ":" + i + ":" + dur, { seekMs, width: 240 }));
      res.setHeader("cache-control", "private, max-age=86400");
      return sendBinary(res, 200, await readFile(thumbPath), "image/jpeg");
    } catch (err) {
      return bad(res, "Frame unavailable", 404);
    }
  }
  if ((mat = p.match(/^\/assets\/([^/]+)\/source$/)) && m === "GET") {
    const assetId = mat[1];
    const projectId = await store.findProjectIdForAsset(assetId);
    if (!projectId) return bad(res, "Asset not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const asset = await store.getAsset(assetId);
    if (!asset || !asset.nasPath) return bad(res, "Asset not found", 404);
    try {
      const localPath = await dsm.assertReadableSourcePath(asset.nasPath, { actor: "api" });
      const download = url.searchParams.get("download") === "1";
      if (download) await audit.record({ actorUserId: sess.userId, action: "asset.downloaded", resourceType: "asset", resourceId: assetId, projectId });
      return await streamLocalMedia(req, res, localPath, asset.mimeType || mimeFromPath(asset.nasPath), download ? nasFileName(asset.nasPath) : null);
    } catch (err) {
      return bad(res, "Khong mo duoc source video: " + (err && err.message), 404);
    }
  }
  // ---- Final: deliver from NAS, upload from the browser, approve / send back
  if ((mat = p.match(/^\/projects\/([^/]+)\/final$/)) && m === "POST") {
    const pid = mat[1];
    if (!(await requireProjectAccess(res, pid, sess.userId, ["owner", "editor"]))) return;
    if (!(await store.getProject(pid))) return bad(res, "Project not found", 404);
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body.nasPath !== "string") return bad(res, "nasPath required");
    const file = await dsm.getFileMeta(sess.dsmSid, body.nasPath);
    if (!file || file.type !== "file" || !file.isVideo) return bad(res, "Chỉ chọn được file video");
    const a = await addFinalRound({ projectId: pid, entry: file, nasPath: file.path || body.nasPath, userId: sess.userId, log: req.log });
    return send(res, 201, a);
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/final\/(approve|reject)$/)) && m === "POST") {
    const pid = mat[1], verdict = mat[2];
    if (!(await requireProjectAccess(res, pid, sess.userId, ["owner"]))) return;
    const project = await store.getProject(pid);
    if (!project) return bad(res, "Project not found", 404);
    const finals = finalsOf(await store.listAssetsByProject(pid));
    const cur = finals[finals.length - 1];
    if (!cur) return bad(res, "Dự án chưa có video Final", 404);
    const body = await readJson(req).catch(() => null) || {};
    if (verdict === "approve") {
      const airDate = body.airDate === undefined ? project.airDate : body.airDate;
      if (!airDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(airDate))) return bad(res, "Chọn ngày lên sóng (YYYY-MM-DD) để chốt lịch");
      await store.patchAsset(cur.id, { reviewStatus: "ok", reviewStatusBy: sess.userId });
      await store.patchProject(pid, { airDate, airConfirmedAt: new Date().toISOString(), airConfirmedBy: sess.userId });
    } else {
      await store.patchAsset(cur.id, { reviewStatus: "fix", reviewStatusBy: sess.userId });
      await store.patchProject(pid, { airConfirmedAt: null });
    }
    await audit.record({ actorUserId: sess.userId, action: "final." + (verdict === "approve" ? "approved" : "rejected"), resourceType: "asset", resourceId: cur.id, projectId: pid, payload: { round: finals.length, airDate: body.airDate || null } });
    await publishProjectEvent(pid, { type: "asset", action: "updated", assetId: cur.id });
    return send(res, 200, await decorateProject(await store.getProject(pid), sess.userId));
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/final-uploads$/)) && m === "POST") {
    const pid = mat[1];
    if (!(await requireProjectAccess(res, pid, sess.userId, ["owner", "editor"]))) return;
    const project = await store.getProject(pid);
    if (!project) return bad(res, "Project not found", 404);
    const body = await readJson(req).catch(() => null);
    const name = body && typeof body.name === "string" ? dsm.safeFolderName(body.name.split(/[\\/]/).pop(), "") : "";
    const size = body ? Number(body.size) : 0;
    if (!name || !dsm.isVideoFileName(name)) return bad(res, "Chỉ upload được file video (mp4, mov, mxf…)");
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FINAL_BYTES) return bad(res, "Kích thước file không hợp lệ");
    let dest;
    try { dest = await dsm.finalUploadDir(project.name); } catch (err) { return bad(res, "Không tạo được thư mục lưu Final: " + (err && err.message), 500); }
    if ((await freeBytes(dest.localDir)) < size + 512 * 1024 * 1024) return bad(res, "NAS không đủ dung lượng trống cho file này", 507);
    const id = randomBytes(12).toString("hex");
    const u = { id, projectId: pid, userId: sess.userId, name, size, localDir: dest.localDir, storedDir: dest.storedDir, onShare: dest.onShare, part: join(dest.localDir, ".coopeditor-" + id + ".part"), createdAt: new Date().toISOString() };
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(uploadMetaPath(id), JSON.stringify(u));
    await writeFile(u.part, "");
    return send(res, 201, { id, offset: 0, size, chunkSize: UPLOAD_CHUNK_BYTES, folder: dest.onShare ? dest.storedDir : null });
  }
  if ((mat = p.match(/^\/final-uploads\/([^/]+)(?:\/(chunk|complete))?$/))) {
    const u = await readUpload(mat[1]);
    const action = mat[2] || "";
    if (!u || u.userId !== sess.userId) return bad(res, "Upload not found", 404);
    if (!(await requireProjectAccess(res, u.projectId, sess.userId, ["owner", "editor"]))) return;
    const offset = await uploadOffset(u);
    if (!action && m === "GET") return send(res, 200, { id: u.id, offset, size: u.size, name: u.name, chunkSize: UPLOAD_CHUNK_BYTES });
    if (!action && m === "DELETE") {
      await unlink(u.part).catch(() => {});
      await unlink(uploadMetaPath(u.id)).catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (action === "chunk" && m === "POST") {
      const at = Number(url.searchParams.get("offset"));
      if (at !== offset) return send(res, 409, { error: "offset mismatch", offset });
      try {
        await appendChunk(req, u.part, offset, Math.min(MAX_UPLOAD_CHUNK_BYTES, u.size - offset));
      } catch (err) {
        return send(res, 400, { error: String(err && err.message || err), offset: await uploadOffset(u) });
      }
      return send(res, 200, { offset: await uploadOffset(u), size: u.size });
    }
    if (action === "complete" && m === "POST") {
      if (offset !== u.size) return send(res, 409, { error: "upload incomplete", offset });
      const fileName = await uniqueFileName(u.localDir, u.name);
      const finalPath = join(u.localDir, fileName);
      await rename(u.part, finalPath);
      await unlink(uploadMetaPath(u.id)).catch(() => {});
      const nasPath = u.onShare ? u.storedDir + "/" + fileName : finalPath;
      let entry = null;
      try { entry = await dsm.probeLocalVideo(fileName, nasPath, finalPath); } catch (_) {}
      if (!entry) return bad(res, "File đã lên NAS nhưng không đọc được hình — kiểm tra lại file video");
      const a = await addFinalRound({ projectId: u.projectId, entry, nasPath, userId: sess.userId, log: req.log });
      return send(res, 201, { asset: a, path: u.onShare ? nasPath : null });
    }
    return bad(res, "Method not allowed", 405);
  }
  if ((mat = p.match(/^\/projects\/([^/]+)\/import$/)) && m === "POST") {
    const pid = mat[1];
    if (!(await requireProjectAccess(res, pid, sess.userId, ["owner", "editor"]))) return;
    if (!(await store.getProject(pid))) return bad(res, "Project not found", 404);
    const body = await readJson(req).catch(() => null);
    if (!body || !Array.isArray(body.nasPaths)) return bad(res, "nasPaths required");
    const created = [];
    for (const path of body.nasPaths) {
      const file = await dsm.getFileMeta(sess.dsmSid, path);
      if (!file || file.type !== "file" || !file.isVideo) continue;
      const a = await store.addAssetFromImport({
        projectId: pid, title: file.name.replace(/\.[^.]+$/, ""), codec: file.codec || "unknown",
        sizeLabel: file.sizeLabel || "—",
        durationMs: file.durationMs || 0,
        nasPath: file.path || path,
        width: file.width || 0,
        height: file.height || 0,
        frameRate: file.frameRate || 0,
        resolutionLabel: file.resolutionLabel || "",
        mimeType: file.mimeType || mimeFromPath(file.name),
      });
      created.push(a);
      const versions = await store.listVersionsForAsset(a.id);
      await autoQueueProxies(versions, req.log);
      await audit.record({
        actorUserId: sess.userId,
        action: "asset.imported",
        resourceType: "asset",
        resourceId: a.id,
        projectId: pid,
        payload: { title: a.title, dsmPath: path, sourcePath: a.nasPath },
      });
    }
    return send(res, 200, { imported: created });
  }

  if ((mat = p.match(/^\/assets\/([^/]+)\/versions$/)) && m === "GET") {
    const projectId = await store.findProjectIdForAsset(mat[1]);
    if (!projectId) return bad(res, "Asset not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    return send(res, 200, await store.listVersionsForAsset(mat[1]));
  }

  if ((mat = p.match(/^\/asset-versions\/([^/]+)$/)) && m === "GET") {
    const projectId = await store.findProjectIdForVersion(mat[1]);
    if (!projectId) return bad(res, "Version not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const v = await store.getVersion(mat[1]);
    if (!v) return bad(res, "Version not found", 404);
    return send(res, 200, { ...v, renditions: await store.listRenditionsForVersion(v.id) });
  }
  if ((mat = p.match(/^\/asset-versions\/([^/]+)\/renditions$/))) {
    const vid = mat[1];
    const projectId = await store.findProjectIdForVersion(vid);
    if (!projectId) return bad(res, "Version not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (!(await store.getVersion(vid))) return bad(res, "Version not found", 404);
    if (m === "GET") return send(res, 200, await store.listRenditionsForVersion(vid));
    if (m === "POST") {
      if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
      const body = await readJson(req).catch(() => null);
      if (!body || ![720, 1080].includes(body.height)) return bad(res, "height must be 720|1080");
      const r = (await store.listRenditionsForVersion(vid)).find((x) => x.height === body.height);
      if (!r) return bad(res, "Rendition not found", 404);
      if (r.status === "ready") return send(res, 200, r);
      const version = await store.getVersion(vid);
      const asset = version ? await store.getAsset(version.assetId) : null;
      if (!asset) return bad(res, "Asset not found", 404);
      if (!dsm.isDevMode()) {
        try {
          await dsm.assertReadableSourcePath(asset.nasPath, { actor: "api" });
        } catch (err) {
          return bad(res, "Nguon video tren NAS chua san sang cho transcode: " + ((err && err.message) || "khong doc duoc source"), 409);
        }
      }
      try {
        await ensureTranscodeRuntimeReady();
      } catch (err) {
        return bad(res, "Worker chua san sang de transcode: " + ((err && err.message) || "worker mount chua san sang"), 409);
      }
      await requestTranscode(r.id);
      const refreshed = await store.getRendition(r.id);
      return send(res, 202, refreshed);
    }
  }
  if ((mat = p.match(/^\/asset-versions\/([^/]+)\/annotation-images(?:\/([^/]+))?$/))) {
    const vid = mat[1], imageId = mat[2];
    if (!safeDirName(vid)) return bad(res, "Version not found", 404);
    const projectId = await store.findProjectIdForVersion(vid);
    if (!projectId) return bad(res, "Version not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (m === "GET" && imageId) return serveStoredImage(res, join(ANNOTATION_IMAGE_DIR, vid), imageId);
    if (m === "POST" && !imageId) return saveImageUpload(req, res, join(ANNOTATION_IMAGE_DIR, vid));
    return bad(res, "Method not allowed", 405);
  }
  if ((mat = p.match(/^\/asset-versions\/([^/]+)\/comments$/))) {
    const vid = mat[1];
    const projectId = await store.findProjectIdForVersion(vid);
    if (!projectId) return bad(res, "Version not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    if (!(await store.getVersion(vid))) return bad(res, "Version not found", 404);
    if (m === "GET") {
      const includeDeleted = url.searchParams.get("include") === "deleted";
      if (includeDeleted) {
        const member = await store.getProjectMember(projectId, sess.userId);
        if (!member || !["owner", "editor"].includes(member.role)) return bad(res, "Forbidden", 403);
      }
      return send(res, 200, await store.listCommentsForVersion(vid, { includeDeleted }));
    }
    if (m === "POST") {
      const body = await readJson(req).catch(() => null);
      if (!body || typeof body.content !== "string" || typeof body.timestampMs !== "number") return bad(res, "content and timestampMs required");
      let content = "";
      try {
        content = normalizeCommentContent(body.content);
      } catch (err) {
        return bad(res, err.message || "content required");
      }
      const annotation = validateAnnotation(body.annotation);
      const c = await store.addComment({ assetVersionId: vid, authorUserId: sess.userId, content, timestampMs: body.timestampMs, frameNumber: body.frameNumber, parentId: body.parentId, annotation });
      await publishProjectEvent(projectId, { type: "comment", action: "created", comment: c });
      await audit.record({ actorUserId: sess.userId, action: "comment.created", resourceType: "comment", resourceId: c.id, projectId, payload: { timestampMs: c.timestampMs, parentId: c.parentId, hasAnnotation: !!annotation, snippet: c.content.slice(0, 120) } });
      if (mailer.enabled()) notifyCommentByEmail({ comment: c, projectId, authorUserId: sess.userId }).catch((err) => req.log.error({ err: err.message }, "comment mail enqueue failed"));
      if (webhooks.enabled()) notifyCommentWebhook({ comment: c, projectId, authorUserId: sess.userId }).catch((err) => req.log.error({ err: err.message }, "comment webhook failed"));
      return send(res, 201, c);
    }
  }
  if ((mat = p.match(/^\/comments\/([^/]+)$/)) && m === "PATCH") {
    const projectId = await store.findProjectIdForComment(mat[1]);
    if (!projectId) return bad(res, "Comment not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const writableComment = await requireCommentWriteAccess(res, mat[1], projectId, sess.userId);
    if (!writableComment) return;
    const body = await readJson(req).catch(() => null);
    if (!body) return bad(res, "Invalid body");
    if (Object.prototype.hasOwnProperty.call(body, "annotation")) {
      // Sketch edited after posting (draft editor → "Lưu phác thảo"). null clears it.
      const annotation = body.annotation === null ? null : validateAnnotation(body.annotation);
      if (body.annotation !== null && !annotation) return bad(res, "Invalid annotation");
      const c = await store.setCommentAnnotation(mat[1], annotation);
      if (!c) return bad(res, "Comment not found", 404);
      await publishProjectEvent(projectId, { type: "comment", action: "updated", comment: c });
      await audit.record({ actorUserId: sess.userId, action: "comment.sketch_edited", resourceType: "comment", resourceId: c.id, projectId, payload: { items: annotation && annotation.items ? annotation.items.length : 0 } });
      return send(res, 200, c);
    }
    if (typeof body.content === "string") {
      let content = "";
      try {
        content = normalizeCommentContent(body.content);
      } catch (err) {
        return bad(res, err.message || "content required");
      }
      const c = await store.setCommentContent(mat[1], content);
      if (!c) return bad(res, "Comment not found", 404);
      await publishProjectEvent(projectId, { type: "comment", action: "updated", comment: c });
      await audit.record({ actorUserId: sess.userId, action: "comment.edited", resourceType: "comment", resourceId: c.id, projectId, payload: { snippet: c.content.slice(0, 120) } });
      return send(res, 200, c);
    }
    if (typeof body.resolved === "boolean") {
      const c = await store.setCommentResolved(mat[1], body.resolved);
      if (!c) return bad(res, "Comment not found", 404);
      await publishProjectEvent(projectId, { type: "comment", action: "updated", comment: c });
      await audit.record({ actorUserId: sess.userId, action: body.resolved ? "comment.resolved" : "comment.reopened", resourceType: "comment", resourceId: c.id, projectId });
      if (body.resolved && webhooks.enabled()) {
        const [project, version, resolver] = await Promise.all([store.getProject(projectId), store.getVersion(c.assetVersionId), store.getUser(sess.userId)]);
        const asset = version ? await store.getAsset(version.assetId) : null;
        webhooks.notifyCommentResolved({ projectName: project ? project.name : "Project", sourceTitle: asset ? asset.title : "(source)", resolverName: resolver ? resolver.name : "Someone", projectId });
      }
      return send(res, 200, c);
    }
    return bad(res, "Nothing to update");
  }
  if ((mat = p.match(/^\/comments\/([^/]+)$/)) && m === "DELETE") {
    const projectId = await store.findProjectIdForComment(mat[1]);
    if (!projectId) return bad(res, "Comment not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
    const writableComment = await requireCommentWriteAccess(res, mat[1], projectId, sess.userId);
    if (!writableComment) return;
    const deleted = await store.deleteComment(mat[1]);
    if (!deleted) return bad(res, "Comment not found or already deleted", 404);
    await publishProjectEvent(projectId, { type: "comment", action: "deleted", comment: deleted });
    await audit.record({ actorUserId: sess.userId, action: "comment.deleted", resourceType: "comment", resourceId: deleted.id, projectId });
    return send(res, 200, { ok: true, comment: deleted });
  }
  if ((mat = p.match(/^\/comments\/([^/]+)\/restore$/)) && m === "POST") {
    const projectId = await store.findProjectIdForComment(mat[1]);
    if (!projectId) return bad(res, "Comment not found", 404);
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
    const restored = await store.restoreComment(mat[1]);
    if (!restored) return bad(res, "Comment not found or not deleted", 404);
    await publishProjectEvent(projectId, { type: "comment", action: "restored", comment: restored });
    await audit.record({ actorUserId: sess.userId, action: "comment.restored", resourceType: "comment", resourceId: restored.id, projectId });
    return send(res, 200, restored);
  }

  if (p === "/nas/ls" && m === "GET") {
    const path = url.searchParams.get("path") || "/";
    if (!(await canBrowseNasLibrary(sess.userId))) return bad(res, "Forbidden", 403);
    try { return send(res, 200, await dsm.dsmListFolder(sess.dsmSid, path)); }
    catch (err) { return bad(res, "Khong doc duoc danh sach thu muc NAS: " + (err && err.message), 502); }
  }

  if (p === "/users" && m === "GET") return send(res, 200, await listVisibleUsersForUser(sess.userId));

  if (p === "/admin/update-status" && m === "GET") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    const force = url.searchParams.get("refresh") === "1";
    const [status, packageFeed] = await Promise.all([checkUpdateStatus({ force }), packageFeedStatus(SPK_MIRROR_DIR, { force })]);
    return send(res, 200, { ...status, packageFeed });
  }

  // Settings page: read the full runtime-config.json (owner-only). The
  // /setup/status response is a sanitized summary; this endpoint returns the
  // raw JSON so edit forms can populate fields. Secrets are masked.
  if (p === "/admin/runtime-config" && m === "GET") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    const cfg = readRuntimeConfig() || {};
    // Mask secret-shaped fields so a leaked GET response never reveals them.
    const masked = JSON.parse(JSON.stringify(cfg));
    const maskField = (obj, key) => { if (obj && typeof obj[key] === "string" && obj[key]) obj[key] = "***"; };
    if (masked.oidc) { maskField(masked.oidc, "clientSecret"); }
    if (masked.smtp) {
      // smtp.url often carries "smtps://user:password@host" — strip credentials
      if (typeof masked.smtp.url === "string" && masked.smtp.url) {
        try { const u = new URL(masked.smtp.url); if (u.username || u.password) { u.username = "***"; u.password = "***"; masked.smtp.url = u.toString(); } } catch (_) {}
      }
    }
    if (masked.hls) { maskField(masked.hls, "cdnSigningSecret"); }
    return send(res, 200, { config: masked, configPath: readRuntimeConfig() ? undefined : null });
  }

  // Owner edits a subset of runtime config from the Settings UI. Server-side
  // merges patch into current config, validates via normalizeRuntimeConfig,
  // writes JSON to disk, and re-applies env so the change is live without
  // restarting the api container.
  if (p === "/admin/runtime-config" && m === "PATCH") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object") return bad(res, "Invalid body");
    const current = readRuntimeConfig() || {};
    // Deep-merge: top-level fields replace, nested objects (oidc/smtp/…) merge
    // shallowly so partial updates keep untouched keys.
    const merged = { ...current };
    for (const [k, v] of Object.entries(body)) {
      if (v && typeof v === "object" && !Array.isArray(v) && current[k] && typeof current[k] === "object") {
        merged[k] = { ...current[k], ...v };
        // "***" sentinel = "keep existing value" (don't overwrite a secret we masked in GET)
        for (const sk of Object.keys(v)) if (v[sk] === "***") merged[k][sk] = current[k][sk];
      } else {
        merged[k] = v;
      }
    }
    try {
      const written = writeRuntimeConfig(merged);
      applyRuntimeEnvFromConfig(written);
      await audit.record({ actorUserId: sess.userId, action: "runtime.config_updated", resourceType: "runtime_config", resourceId: "runtime", payload: { keys: Object.keys(body) } });
      return send(res, 200, { ok: true, summary: publicRuntimeSummary() });
    } catch (err) {
      return bad(res, "Sửa cấu hình thất bại: " + (err && err.message || "lỗi không xác định"), 400);
    }
  }

  if (p === "/proxy-storage-summary" && m === "GET") {
    try {
      if (url.searchParams.get("refresh") === "1") invalidateProxyStorageCache();
      const payload = await buildProxyStoragePayload();
      return send(res, 200, {
        backend: payload.backend,
        bucket: payload.bucket || null,
        stale: !!payload.stale,
        savedAt: payload.savedAt || null,
        totalBytes: payload.totalBytes || 0,
        orphanCount: payload.orphanCount || 0,
        orphanBytes: payload.orphanBytes || 0,
        renditionCount: payload.renditionCount || 0,
        renditions: [],
        note: payload.note || "",
        ...(await proxyDiskUsage()),
      });
    } catch (err) {
      req.log.error({ err: err.message }, "proxy-storage summary failed");
      return bad(res, "Không đọc được proxy storage summary: " + err.message, 502);
    }
  }

  if (p === "/admin/proxy-storage" && m === "GET") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    try {
      if (url.searchParams.get("refresh") === "1") invalidateProxyStorageCache();
      return send(res, 200, await buildProxyStoragePayload());
    } catch (err) {
      req.log.error({ err: err.message }, "proxy-storage list failed");
      return bad(res, "Không đọc được danh sách MinIO: " + err.message, 502);
    }
  }

  if (p === "/transcode-runtime" && m === "GET") {
    try {
      return send(res, 200, await getTranscodeRuntimeStatus());
    } catch (err) {
      req.log.error({ err: err.message }, "transcode-runtime failed");
      return bad(res, "Khong doc duoc transcode runtime status: " + err.message, 502);
    }
  }

  if ((mat = p.match(/^\/renditions\/([^/]+)\/proxy$/)) && m === "DELETE") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    const rid = mat[1];
    // Wipe stored proxy under <rid>/ prefix and reset rendition row so the FE
    // shows it as "Tạo proxy" again. Worker won't auto-retranscode unless the
    // user explicitly requests it from the quality menu. Branches on backend:
    // MinIO bucket vs filesystem OUTPUT_DIR for SPK deploys.
    try {
      const info = hlsBackendInfo();
      const wipe = info.backend === "minio"
        ? await s3DeletePrefix(rid + "/")
        : info.backend === "filesystem"
          ? await fsDeletePrefix(rid + "/")
          : { deleted: 0 };
      invalidateProxyStorageCache();
      await store.setRenditionStatus(rid, { status: "pending", progress: 0, hlsMasterUrl: null }).catch(() => {});
      await audit.record({ actorUserId: sess.userId, action: "rendition.proxy_deleted", resourceType: "rendition", resourceId: rid, payload: { deleted: wipe.deleted, bytes: wipe.bytes } });
      return send(res, 200, { ok: true, ...wipe });
    } catch (err) {
      req.log.error({ err: err.message, rid }, "delete-rendition-proxy failed");
      return bad(res, "Không xóa được proxy: " + err.message, 502);
    }
  }

  if ((mat = p.match(/^\/projects\/([^/]+)\/shares$/))) {
    const projectId = mat[1];
    if (!(await requireProjectAccess(res, projectId, sess.userId, ["owner", "editor"]))) return;
    if (m === "GET") return send(res, 200, await shareLinks.listForProject(projectId));
    if (m === "POST") {
      const body = await readJson(req).catch(() => null) || {};
      const accessLevel = ["review", "comment"].includes(body.accessLevel) ? body.accessLevel : "review";
      const ttlHours = Math.min(720, Math.max(1, parseInt(body.ttlHours, 10) || 168));
      const link = await shareLinks.create({ projectId, assetId: body.assetId || null, accessLevel, createdBy: sess.userId, ttlHours, guestLabel: body.guestLabel || null });
      await audit.record({ actorUserId: sess.userId, action: "share.created", resourceType: "share_link", resourceId: link.token, projectId, payload: { accessLevel, assetId: link.assetId, ttlHours } });
      return send(res, 201, link);
    }
  }
  if ((mat = p.match(/^\/shares\/([^/]+)$/)) && m === "DELETE") {
    const link = await shareLinks.get(mat[1]);
    if (!link) return bad(res, "Share not found", 404);
    if (!(await requireProjectAccess(res, link.projectId, sess.userId, ["owner", "editor"]))) return;
    const revoked = await shareLinks.revoke(mat[1]);
    if (!revoked) return bad(res, "Already revoked", 409);
    await audit.record({ actorUserId: sess.userId, action: "share.revoked", resourceType: "share_link", resourceId: mat[1], projectId: link.projectId });
    return send(res, 200, revoked);
  }

  if (p === "/presence" && m === "GET") return send(res, 200, presence.snapshot());
  if (p === "/presence" && m === "POST") {
    const body = await readJson(req).catch(() => null);
    const user = await store.getUser(sess.userId);
    if (!user) return bad(res, "User not found", 404);
    presence.touch(user, body && body.focus ? body.focus : null);
    return send(res, 200, { ok: true });
  }
  if (p === "/presence" && m === "DELETE") { presence.leave(sess.userId); return send(res, 200, { ok: true }); }

  // Fallback: SPA shell when WEB_INLINE=1 (SPK build) and path is "/" or
  // /index.html. Other paths still 404. Keeping this AFTER the route table
  // means a real endpoint never gets shadowed by the SPA.
  if (await tryServeSpa(req, res, url)) return;

  return bad(res, "Not found", 404);
}

const FRAME_CONCURRENCY = 2;
let framesRunning = 0;
const frameWaiters = [];
async function withFrameSlot(fn) {
  if (framesRunning >= FRAME_CONCURRENCY) await new Promise((resolve) => frameWaiters.push(resolve));
  framesRunning++;
  try { return await fn(); }
  finally { framesRunning--; const next = frameWaiters.shift(); if (next) next(); }
}

function currentProxySettings() {
  const seg = Number(process.env.HLS_SEGMENT_SECONDS) === 6 ? 6 : 4;
  const rungs = String(process.env.PROXY_AUTO_RUNGS || "").split(",").map(Number).filter((h) => h === 720 || h === 1080);
  return { hlsSegmentSeconds: seg, autoRungs: [...new Set(rungs)].sort((a, b) => a - b), availableRungs: [720, 1080] };
}

// Queue the rungs picked in Cài đặt → Proxy for a freshly imported source.
// Best effort: a worker that isn't ready just leaves them pending, exactly as
// before this setting existed.
async function autoQueueProxies(versions, log) {
  const { autoRungs } = currentProxySettings();
  const current = (versions || []).slice(-1)[0];
  if (!autoRungs.length || !current) return;
  try { await ensureTranscodeRuntimeReady(); } catch (_) { return; }
  for (const r of await store.listRenditionsForVersion(current.id)) {
    if (!autoRungs.includes(r.height) || r.status === "ready" || r.status === "processing") continue;
    try { await requestTranscode(r.id); } catch (err) { log && log.warn({ err: String(err && err.message || err), renditionId: r.id }, "auto proxy enqueue failed"); }
  }
}

// ---- Final video ------------------------------------------------------------
// Every delivery of the assembled cut is its own asset (kind "final", titled
// "Final vN"); the newest one is the project's current final. Delivering one
// puts it in Chờ duyệt and un-confirms the air date; the project owner then
// approves it (confirming the air date) or sends it back (Cần sửa).
const isFinal = (a) => a && a.kind === "final";
const finalsOf = (assets) => assets.filter(isFinal).sort((a, b) => a.position - b.position || String(a.createdAt).localeCompare(String(b.createdAt)));

async function addFinalRound({ projectId, entry, nasPath, userId, log }) {
  const finals = finalsOf(await store.listAssetsByProject(projectId));
  const round = finals.length + 1;
  const a = await store.addAssetFromImport({
    projectId, kind: "final", title: "Final v" + round, codec: entry.codec || "unknown",
    sizeLabel: entry.sizeLabel || "—", durationMs: entry.durationMs || 0, nasPath,
    width: entry.width || 0, height: entry.height || 0, frameRate: entry.frameRate || 0,
    resolutionLabel: entry.resolutionLabel || "", mimeType: entry.mimeType || mimeFromPath(entry.name),
  });
  const updated = await store.patchAsset(a.id, { reviewStatus: "wait", reviewStatusBy: userId });
  await store.patchProject(projectId, { airConfirmedAt: null });
  // A final is watched start to end in the browser: always queue its 720p proxy.
  try {
    await ensureTranscodeRuntimeReady();
    const versions = await store.listVersionsForAsset(a.id);
    const r720 = versions.length ? (await store.listRenditionsForVersion(versions[versions.length - 1].id)).find((r) => r.height === 720) : null;
    if (r720) await requestTranscode(r720.id);
  } catch (err) { log && log.warn({ err: String(err && err.message || err), assetId: a.id }, "final proxy enqueue failed"); }
  await audit.record({ actorUserId: userId, action: "final.delivered", resourceType: "asset", resourceId: a.id, projectId, payload: { round, sourcePath: nasPath } });
  await publishProjectEvent(projectId, { type: "asset", action: "created", assetId: a.id });
  return updated || a;
}

// Resumable browser upload of a final: the file is written in chunks straight
// into its destination folder as a hidden .part, then renamed and probed.
const UPLOAD_DIR = join(APP_DATA_DIR, "system", "final-uploads");
const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_FINAL_BYTES = 1024 ** 4; // 1 TB
const uploadMetaPath = (id) => join(UPLOAD_DIR, id + ".json");
async function readUpload(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id || ""))) return null;
  try { return JSON.parse(await readFile(uploadMetaPath(id), "utf8")); } catch (_) { return null; }
}
async function uploadOffset(u) { try { return (await stat(u.part)).size; } catch (_) { return 0; } }
async function freeBytes(dir) { try { const st = await statfs(dir); return Number(st.bavail) * Number(st.bsize); } catch (_) { return Infinity; } }
async function uniqueFileName(dir, name) {
  const taken = new Set(await readdir(dir).catch(() => []));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  return base + "-" + Date.now() + ext;
}
// Append the request body at `offset`. Anything past the declared size or
// the chunk cap aborts and rolls the file back to where it was.
function appendChunk(req, file, offset, maxBytes) {
  return new Promise((resolve, reject) => {
    let n = 0, failed = null, settled = false;
    const out = createWriteStream(file, { flags: offset === 0 ? "w" : "r+", start: offset });
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) truncate(file, offset).catch(() => {}).finally(() => reject(err));
      else resolve(n);
    };
    // Over the limit: stop writing but keep draining the body so the client
    // still gets an answer (with the offset to resume from) instead of a reset.
    const fail = (err) => {
      if (failed) return;
      failed = err;
      req.unpipe(out);
      out.destroy();
      req.resume();
    };
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) fail(new Error("chunk past the declared file size"));
      if (n > maxBytes + MAX_UPLOAD_CHUNK_BYTES) req.destroy();
    });
    req.on("end", () => { if (failed) done(failed); });
    req.on("error", (err) => done(err));
    req.on("aborted", () => done(new Error("upload aborted")));
    out.on("error", (err) => { if (!failed) { fail(err); } });
    out.on("finish", () => { if (!failed) done(null); });
    req.pipe(out);
  });
}

// The project's one status, from its final: none yet → Đang dựng; otherwise
// the final's verdict, and an approved final whose confirmed air date has
// come counts as Đã lên sóng.
function localIsoDay(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function projectStatusOf(p, final) {
  if (!final) return "edit";
  const st = REVIEW_STATUSES.includes(final.reviewStatus) ? final.reviewStatus : "wait";
  if (st === "ok" && p.airConfirmedAt && p.airDate && p.airDate <= localIsoDay()) return "air";
  return st;
}

async function decorateProject(p, userId) {
  const everything = await store.listAssetsByProject(p.id);
  const assets = everything.filter((a) => !isFinal(a));
  const finals = finalsOf(everything);
  const cur = finals[finals.length - 1] || null;
  const ready = assets.filter((a) => a.status === "ready").length;
  const commentsCount = assets.reduce((a, x) => a + (x.commentsCount || 0), 0);
  const team = [];
  for (const uid of (p.teamUserIds || [])) { const u = await store.getUser(uid); if (u) team.push(u); }
  const member = userId ? await store.getProjectMember(p.id, userId) : null;
  let thumbUrl = "";
  try {
    if ((await loadProjectThumb(p.id)) || pickProjectThumbAsset(p.id, assets)) thumbUrl = "/projects/" + p.id + "/thumb";
  } catch (_) {}
  const openCommentsCount = assets.reduce((n, a) => n + (a.openCommentsCount || 0), 0);
  // Every scheduled airing for the timeline: the project's own date plus any
  // per-video dates, de-duplicated and sorted.
  const airDates = [...new Set([p.airDate, ...assets.map((a) => a.airDate)].filter(Boolean))].sort();
  const totalSizeLabel = formatBytesLabel(everything.reduce((n, a) => n + parseSizeLabel(a.sizeLabel), 0));
  const final = cur ? {
    assetId: cur.id, round: finals.length, title: cur.title, reviewStatus: cur.reviewStatus || "wait",
    reviewStatusBy: cur.reviewStatusBy || null, reviewStatusAt: cur.reviewStatusAt || null, createdAt: cur.createdAt,
    durationMs: cur.durationMs || 0, sizeLabel: cur.sizeLabel, status: cur.status, progress: cur.progress,
    openCommentsCount: cur.openCommentsCount || 0, paletteA: cur.paletteA, paletteB: cur.paletteB,
  } : null;
  return {
    ...p, myRole: p.myRole || (member && member.role) || undefined, sourcesCount: assets.length, readyCount: ready, commentsCount, team, thumbUrl,
    reviewStatus: projectStatusOf(p, final), openCommentsCount: openCommentsCount + (final ? final.openCommentsCount : 0),
    airDates, totalSizeLabel, final, airConfirmed: !!p.airConfirmedAt,
  };
}

async function handleLogin(req, res) {
  const limit = loginRateLimit(req);
  if (!limit.ok) {
    res.setHeader("retry-after", String(limit.retryAfter));
    return bad(res, "Too many attempts; try again in " + limit.retryAfter + "s", 429);
  }
  const body = await readJson(req).catch(() => null);
  if (!body || !body.account || !body.passwd) return bad(res, "account and passwd required");
  let r;
  try { r = await dsm.dsmLogin(body); }
  catch (err) { return bad(res, "DSM error: " + (err && err.message), 502); }
  if (r && r.needsOtp) return send(res, 200, { needsOtp: true, otpInvalid: !!r.otpInvalid, error: r.error || null });
  if (!r || !r.ok) return bad(res, (r && r.error) || "Login failed", 401);
  const user = await store.upsertUserFromDsm({ uid: r.uid, name: r.name, email: r.email });
  const token = await createSession({ userId: user.id, dsmSid: r.sid });
  loginSuccess(req);
  await audit.record({ actorUserId: user.id, action: "auth.login", resourceType: "session", payload: { dsmUid: r.uid } });
  send(res, 200, { user, canUseScripts: await canUseScripts(user.id) }, { "set-cookie": cookieSetHeader(token, 12 * 3600, isSecureRequest(req)) });
}

async function handleOidcStart(req, res) {
  if (!oidc.enabled()) return bad(res, "OIDC not configured", 404);
  try {
    const url = await oidc.startUrl();
    res.statusCode = 302; res.setHeader("location", url); res.end();
  } catch (err) { bad(res, "OIDC start failed: " + err.message, 502); }
}

async function handleOidcCallback(req, res, url) {
  if (!oidc.enabled()) return bad(res, "OIDC not configured", 404);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return bad(res, "OIDC IdP error: " + error, 400);
  if (!code || !state) return bad(res, "Missing code/state", 400);
  try {
    const identity = await oidc.exchange(code, state);
    const user = await store.upsertUserFromOidc({
      issuer: identity.issuer, sub: identity.sub, name: identity.name, email: identity.email,
    });
    const token = await createSession({ userId: user.id, dsmSid: "" });
    await audit.record({ actorUserId: user.id, action: "auth.login", resourceType: "session", payload: { via: "oidc", issuer: identity.issuer } });
    res.statusCode = 302;
    res.setHeader("set-cookie", cookieSetHeader(token, 12 * 3600, isSecureRequest(req)));
    res.setHeader("location", oidc.callbackUrl());
    res.end();
  } catch (err) {
    req.log.error({ err: err.message }, "OIDC callback failed");
    bad(res, "OIDC callback failed: " + err.message, 502);
  }
}

// Update check: compare BUILD_SHA with the latest commit on the remote.
// UPDATE_FEED_URL = a URL that returns { sha, builtAt? } as JSON.
//   - GitHub: https://api.github.com/repos/<owner>/<repo>/commits/main → use .sha
//   - GitLab: https://gitlab.com/api/v4/projects/<id>/repository/commits/main → .id
//   - Self-hosted: any endpoint returning { sha } JSON
//
// If UPDATE_FEED_URL is unset, we can't check remote — return "unknown".
let _updateCache = null;

function fetchTimeoutSignal(ms) {
  if (AbortSignal && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("timeout")), ms).unref?.();
  return controller.signal;
}

async function checkUpdateStatus({ force = false } = {}) {
  const local = buildLocalReleaseMeta();
  const runtimeConfig = readRuntimeConfig();
  let updater = null;
  try {
    updater = resolveUpdaterConfig(runtimeConfig);
  } catch (err) {
    return {
      local,
      remote: null,
      updateAvailable: false,
      checkAvailable: false,
      triggerAvailable: false,
      pollIntervalSeconds: clampPositiveInt(process.env.UPDATE_POLL_INTERVAL_SECONDS, 900),
      error: err.message || "Updater config invalid",
    };
  }
  const feed = String(updater.feedUrl || "").trim();
  const base = {
    local,
    remote: null,
    updateAvailable: false,
    checkAvailable: !!feed,
    triggerAvailable: !!updater.triggerConfigured,
    pollIntervalSeconds: clampPositiveInt(updater.pollIntervalSeconds, 900),
  };
  if (!feed) return { ...base, message: "Update feed chua duoc cau hinh" };

  if (!force && _updateCache && Date.now() - _updateCache.at < 300_000) return { ...base, ..._updateCache.data };

  const candidates = [...new Set([
    feed,
    DEFAULT_UPDATE_FEED_URL,
    "https://cdn.jsdelivr.net/gh/namct2610/coopeditor@main/release.json",
  ].filter(Boolean))];

  try {
    let remote = null;
    let lastError = "";
    let resolvedFeed = feed;
    for (const candidate of candidates) {
      resolvedFeed = candidate;
      try {
        const r = await fetch(candidate, { headers: { "user-agent": "coopeditor-updater", accept: "application/json, text/plain;q=0.9, */*;q=0.8" }, signal: fetchTimeoutSignal(8000) });
        if (!r.ok) {
          lastError = "remote HTTP " + r.status;
          continue;
        }
        const raw = await r.text();
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) {}
        remote = normalizeRemoteReleaseMeta(body);
        if (remote) break;
        lastError = "Khong parse duoc release metadata tu update feed";
      } catch (err) {
        lastError = err && err.message ? err.message : "Update feed request failed";
      }
    }
    if (!remote) return { ...base, checkAvailable: true, error: lastError || "Khong doc duoc remote release metadata", feedUrl: resolvedFeed };
    const data = {
      remote,
      updateAvailable: hasRemoteUpdate(local, remote),
      checkAvailable: true,
      feedUrl: resolvedFeed,
      checkedAt: new Date().toISOString(),
    };
    _updateCache = { at: Date.now(), data };
    return { ...base, ...data };
  } catch (err) {
    return { ...base, error: err.message };
  }
}


function clampPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function handleSharedRead(req, res, token) {
  const link = await shareLinks.get(token);
  if (!link) return bad(res, "Share link not found", 404);
  if (!(await shareLinks.isValid(link))) return bad(res, "Share link expired or revoked", 410);
  const project = await store.getProject(link.projectId);
  if (!project) return bad(res, "Project missing", 404);
  // assets: limit to link.assetId when present; else all in project.
  const allAssets = await store.listAssetsByProject(link.projectId);
  const assets = link.assetId ? allAssets.filter((a) => a.id === link.assetId) : allAssets;
  // for each asset, attach its current version + comments
  const enriched = [];
  for (const a of assets) {
    const versions = await store.listVersionsForAsset(a.id);
    const current = versions[versions.length - 1];
    const comments = current ? await store.listCommentsForVersion(current.id) : [];
    const renditions = current ? await store.listRenditionsForVersion(current.id) : [];
    enriched.push({ ...a, currentVersion: current, comments, renditions });
  }
  return send(res, 200, {
    link: { token: link.token, accessLevel: link.accessLevel, expiresAt: link.expiresAt, guestLabel: link.guestLabel, assetScope: link.assetId },
    project: { id: project.id, name: project.name, client: project.client, status: project.status },
    assets: enriched,
  });
}

async function handleSharedComment(req, res, token) {
  const link = await shareLinks.get(token);
  if (!link) return bad(res, "Share link not found", 404);
  if (!(await shareLinks.isValid(link))) return bad(res, "Share link expired or revoked", 410);
  if (link.accessLevel !== "comment") return bad(res, "This share link is read-only", 403);
  const rate = shareCommentRateLimit(req, token);
  if (!rate.ok) {
    res.setHeader("retry-after", String(rate.retryAfter));
    return bad(res, "Too many shared comments from this IP. Thu lai sau " + rate.retryAfter + " giay.", 429);
  }
  const body = await readJson(req).catch(() => null);
  if (!body || typeof body.content !== "string" || typeof body.timestampMs !== "number") return bad(res, "content and timestampMs required");
  if (!body.assetVersionId) return bad(res, "assetVersionId required");
  // Verify the version belongs to the link's project + (if scoped) asset.
  const version = await store.getVersion(body.assetVersionId);
  if (!version) return bad(res, "Version not found", 404);
  const projectId = await store.findProjectIdForVersion(version.id);
  if (projectId !== link.projectId) return bad(res, "Version not in shared project", 403);
  if (link.assetId && version.assetId !== link.assetId) return bad(res, "Version not in shared asset", 403);
  // Keep actorUserId = owner for audit ownership, but store guest identity
  // separately so UI/timeline/avatar show the real reviewer behind the share link.
  const guestSuffix = link.guestLabel ? ` — ${link.guestLabel} (qua link share)` : ` — (qua link share)`;
  let content = "";
  try {
    content = normalizeCommentContent(body.content, { suffix: guestSuffix });
  } catch (err) {
    return bad(res, err.message || "content required");
  }
  const guestIdentity = buildGuestIdentity(link.guestLabel);
  const c = await store.addComment({
    assetVersionId: body.assetVersionId,
    authorUserId: link.createdBy,
    content,
    timestampMs: body.timestampMs,
    frameNumber: body.frameNumber,
    parentId: body.parentId,
    ...guestIdentity,
  });
  await publishProjectEvent(projectId, { type: "comment", action: "created", comment: c });
  await audit.record({ actorUserId: link.createdBy, action: "comment.created", resourceType: "comment", resourceId: c.id, projectId, payload: { via: "share_link", token: token.slice(0, 8), guestLabel: link.guestLabel, snippet: c.content.slice(0, 120) } });
  if (mailer.enabled()) notifyCommentByEmail({ comment: c, projectId, authorUserId: link.createdBy }).catch(() => {});
  if (webhooks.enabled()) notifyCommentWebhook({ comment: c, projectId, authorUserId: link.createdBy }).catch(() => {});
  return send(res, 201, c);
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  const sess = await destroySession(cookies[COOKIE_NAME]);
  if (sess) {
    presence.leave(sess.userId);
    try { await dsm.dsmLogout(sess.dsmSid); } catch (_) {}
    await audit.record({ actorUserId: sess.userId, action: "auth.logout", resourceType: "session" });
  }
  send(res, 200, { ok: true }, { "set-cookie": cookieClearHeader(isSecureRequest(req)) });
}

async function sendMetrics(res) {
  const queue = await transcodeMetrics();
  const login = loginMetrics();
  const lines = [
    "# HELP coopeditor_transcode_queue_depth Number of queued transcode jobs.",
    "# TYPE coopeditor_transcode_queue_depth gauge",
    `coopeditor_transcode_queue_depth ${queue.queued}`,
    "# HELP coopeditor_transcode_running_jobs Number of running transcode jobs.",
    "# TYPE coopeditor_transcode_running_jobs gauge",
    `coopeditor_transcode_running_jobs ${queue.running}`,
    "# HELP coopeditor_login_attempts_total Total login attempts observed by the API.",
    "# TYPE coopeditor_login_attempts_total counter",
    `coopeditor_login_attempts_total ${login.totalAttempts}`,
    "# HELP coopeditor_login_blocked_attempts_total Total login attempts blocked by rate limiting.",
    "# TYPE coopeditor_login_blocked_attempts_total counter",
    `coopeditor_login_blocked_attempts_total ${login.blockedAttempts}`,
    "# HELP coopeditor_login_rate_limit_buckets Number of active rate-limit buckets.",
    "# TYPE coopeditor_login_rate_limit_buckets gauge",
    `coopeditor_login_rate_limit_buckets ${login.activeBuckets}`,
    "# HELP coopeditor_sse_subscribers Number of active SSE subscribers.",
    "# TYPE coopeditor_sse_subscribers gauge",
    `coopeditor_sse_subscribers ${subscriberCount()}`,
  ];
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
  res.end(lines.join("\n") + "\n");
}

async function transcodeMetrics() {
  if (store.backend === "memory") {
    return { queued: pendingTranscodeCount(), running: 0 };
  }
  const pool = db();
  const { rows } = await pool.query(store.backend === "sqlite" ? `
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM transcode_jobs
  ` : `
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running
    FROM transcode_jobs
  `);
  return rows[0] || { queued: 0, running: 0 };
}

const server = createServer(async (req, res) => {
  const requestId = newRequestId();
  req.requestId = requestId;
  req.log = createRequestLogger(req, requestId);
  const startedAt = Date.now();
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    req.log.info({
      status_code: res.statusCode,
      duration_ms: Date.now() - startedAt,
      user_id: req.authUserId || null,
    }, "request completed");
  });
  try {
    const url = new URL(req.url || "/", "http://x");
    await handle(req, res, url);
  } catch (err) {
    req.log.error({ err: String(err && err.message || err) }, "request failed");
    if (!res.headersSent) { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: String(err && err.message || err) })); }
  }
});

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT ?? 4000);

(async () => {
  // initDb() picks pg / sqlite / no-op based on DATABASE_URL prefix. Previous
  // check `store.backend === "pg"` was correct before rc12 when the label
  // covered both pg+sqlite, but after the label split we'd skip init on
  // sqlite — store-pg queries then crashed with "Cannot read properties of
  // null (reading 'query')" because db() never opened a pool.
  if (store.backend === "pg" || store.backend === "sqlite" || store.backend === "postgres") await initDb();
  // SPK upgrades never ran migrations (start-stop-status only migrates on
  // first boot, pre/postupgrade are no-ops), so NAS installs were missing every
  // table/column added since — "no such table: scripts". The single-process
  // SQLite deployment now applies pending migrations on every boot (idempotent:
  // applied files are recorded in schema_migrations). Postgres deployments keep
  // running migrate.js as their own step — several API replicas could race here.
  if (store.backend === "sqlite") {
    await runMigrations({ log: (msg) => logger.info(msg) })
      .catch((err) => logger.error({ err: err.message }, "sqlite migrations failed at boot"));
  }
  bindWsPublish(wsPublish);
  await attachWebSocket(server).catch((e) => logger.error({ err: e.message }, "websocket bootstrap failed"));
  server.listen(port, host, () => {
    logger.info({
      host,
      port,
      backend: store.backend,
      dsm_dev_mode: dsm.isDevMode(),
      event_bus: eventBusMode(),
    }, `Coopeditor API listening on http://${host}:${port}`);
  });
  startWorker();
  startRetention();
  // Look for a new release every 5 min (the feed's cache) and fetch its .spk
  // to the NAS straight away, so Package Center can offer it the first time
  // it asks instead of after the next half-hour check plus the download.
  if (SPK_MIRROR_DIR) {
    warmSpkMirror(SPK_MIRROR_DIR);
    setInterval(() => warmSpkMirror(SPK_MIRROR_DIR), 5 * 60_000).unref();
  }
  await startEventBus().catch((e) => logger.error({ err: e.message }, "event bus bootstrap failed"));
})();
