import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// Reusable random buffer for /speedtest/segment — generated once at startup and
// written repeatedly. 256 KiB is small enough to fit in CPU cache yet large
// enough that the per-chunk write overhead doesn't dominate at gigabit speeds.
const SPEEDTEST_NOISE = randomBytes(256 * 1024);
const APP_DATA_DIR = process.env.APP_DATA_DIR || "/data";
const PROJECT_THUMB_DIR = join(APP_DATA_DIR, "system", "project-thumbs");
const PROXY_STORAGE_SNAPSHOT_PATH = join(APP_DATA_DIR, "system", "proxy-storage-cache.json");
const MAX_PROJECT_THUMB_BYTES = 2 * 1024 * 1024;
const ALLOWED_PROJECT_THUMB_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_COMMENT_CONTENT_CHARS = 4000;

import * as store from "./store-index.js";
import { db, initPg } from "./db.js";
import * as dsm from "./dsm.js";
import { subscribe as sseSubscribe, subscriberCount, bindWsPublish } from "./events.js";
import { attachWebSocket, publish as wsPublish, subscriberCount as wsCount } from "./ws.js";
import { eventBusMode, publishEvent, startEventBus } from "./event-bus.js";
import { hasValidSignedPlaybackToken, serveHls, s3ListPrefix, s3DeletePrefix, fsListPrefix, fsDeletePrefix, hlsBackendInfo } from "./hls-proxy.js";
import { tryServeSpa } from "./web-spa.js";
import { applyCors, isTrustedMutationRequest, loginMetrics, loginRateLimit, loginSuccess, shareCommentRateLimit } from "./security.js";
import * as presence from "./presence.js";
import {
  COOKIE_NAME, createSession, getSession, destroySession,
  parseCookies, cookieSetHeader, cookieClearHeader,
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

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'",
  );
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) { req.destroy(); reject(new Error("Body too large")); } });
    req.on("end", () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
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

async function streamLocalMedia(req, res, filePath, contentType) {
  const info = await stat(filePath);
  const total = info.size;
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

// Annotation payload:
// {
//   strokes: [{ tool: "pen"|"arrow"|"rect", color: "#RRGGBB", points: [[x01, y01], ...] }],
//   texts: [{ x: 0..1, y: 0..1, color: "#RRGGBB", text: "..." }]
// }
// Coordinates are normalized 0..1 so they survive scaling. Size cap = 50 strokes × 256 points.
function validateAnnotation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes.slice(0, 50).map((s) => {
    if (!s || typeof s !== "object") return null;
    const tool = ["pen", "arrow", "rect"].includes(s.tool) ? s.tool : "pen";
    const color = typeof s.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : "#ef4d57";
    if (!Array.isArray(s.points)) return null;
    const points = s.points.slice(0, 256).map((p) => {
      if (!Array.isArray(p) || p.length < 2) return null;
      const x = Math.max(0, Math.min(1, Number(p[0]) || 0));
      const y = Math.max(0, Math.min(1, Number(p[1]) || 0));
      return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    }).filter(Boolean);
    if (!points.length) return null;
    return { tool, color, points };
  }).filter(Boolean) : [];
  const texts = Array.isArray(raw.texts) ? raw.texts.slice(0, 32).map((t) => {
    if (!t || typeof t !== "object") return null;
    const color = typeof t.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(t.color) ? t.color : "#ef4d57";
    const x = Math.round(Math.max(0, Math.min(1, Number(t.x) || 0)) * 1000) / 1000;
    const y = Math.round(Math.max(0, Math.min(1, Number(t.y) || 0)) * 1000) / 1000;
    const text = String(t.text || "").trim().slice(0, 120);
    if (!text) return null;
    return { x, y, color, text };
  }).filter(Boolean) : [];
  if (!strokes.length && !texts.length) return null;
  return { strokes, texts };
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
  const p = url.pathname;
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

  if (p === "/health" && m === "GET") return send(res, 200, { ok: true, dsmConfigured: !dsm.isDevMode(), backend: store.backend });
  if (p === "/setup/status" && m === "GET") {
    // When server.js is running, runtime IS configured (via env or config file).
    // Force `configured: true` so the FE doesn't render the setup wizard.
    return send(res, 200, { ...publicRuntimeSummary(), configured: true });
  }
  if (p === "/version" && m === "GET") {
    return send(res, 200, buildLocalReleaseMeta());
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
    return send(res, 200, { user });
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
      return bad(res, "Khong tao duoc thumbnail: " + (err && err.message), 500);
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
      const patch = { ...body };
      delete patch.thumbDataUrl;
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
    const firstAsset = assets[0];
    if (!firstAsset || !firstAsset.nasPath) return bad(res, "Project thumb not found", 404);
    try {
      const seekMs = Math.min(Math.max(1000, Math.round((firstAsset.durationMs || 0) * 0.1)), Math.max(1000, (firstAsset.durationMs || 0) - 1000));
      const thumbPath = await dsm.ensureVideoThumbnail(firstAsset.nasPath, "project:" + projectId + ":" + firstAsset.id + ":" + (firstAsset.durationMs || 0), { seekMs });
      return sendBinary(res, 200, await readFile(thumbPath), "image/jpeg");
    } catch (err) {
      return bad(res, "Khong tao duoc project thumb: " + (err && err.message), 500);
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
    return send(res, 200, await store.listAssetsByProject(projectId));
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
      return bad(res, "Khong tao duoc poster: " + (err && err.message), 500);
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
      return await streamLocalMedia(req, res, localPath, asset.mimeType || mimeFromPath(asset.nasPath));
    } catch (err) {
      return bad(res, "Khong mo duoc source video: " + (err && err.message), 404);
    }
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
    return send(res, 200, await checkUpdateStatus({ force: url.searchParams.get("refresh") === "1" }));
  }

  if (p === "/admin/update-trigger" && m === "POST") {
    if (!(await canManageUpdates(sess.userId))) return bad(res, "Forbidden", 403);
    return send(res, 200, await triggerUpdateRun());
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
    if (masked.updater) { maskField(masked.updater, "triggerToken"); }
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

async function decorateProject(p, userId) {
  const assets = await store.listAssetsByProject(p.id);
  const ready = assets.filter((a) => a.status === "ready").length;
  const commentsCount = assets.reduce((a, x) => a + (x.commentsCount || 0), 0);
  const team = [];
  for (const uid of (p.teamUserIds || [])) { const u = await store.getUser(uid); if (u) team.push(u); }
  const member = userId ? await store.getProjectMember(p.id, userId) : null;
  let thumbUrl = "";
  try {
    if (await loadProjectThumb(p.id)) thumbUrl = "/projects/" + p.id + "/thumb";
  } catch (_) {}
  return { ...p, myRole: p.myRole || (member && member.role) || undefined, sourcesCount: assets.length, readyCount: ready, commentsCount, team, thumbUrl };
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
  send(res, 200, { user }, { "set-cookie": cookieSetHeader(token, 12 * 3600) });
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
    res.setHeader("set-cookie", cookieSetHeader(token, 12 * 3600));
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

async function triggerUpdateRun() {
  let updater = null;
  try {
    updater = resolveUpdaterConfig(readRuntimeConfig());
  } catch (err) {
    return { ok: false, triggerAvailable: false, error: err.message || "Updater config invalid" };
  }
  const triggerUrl = updater.triggerUrl || "";
  const triggerToken = updater.triggerToken || "";
  if (!triggerUrl) {
    return { ok: false, triggerAvailable: false, error: "Manual update trigger chua duoc cau hinh" };
  }

  try {
    const headers = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "user-agent": "coopeditor-updater",
    };
    if (triggerToken) {
      headers.authorization = "Bearer " + triggerToken;
      headers["x-update-token"] = triggerToken;
    }
    const attempts = [
      { method: "GET" },
      { method: "POST", body: JSON.stringify({
        source: "coopeditor-ui",
        requestedAt: new Date().toISOString(),
        currentVersion: buildLocalReleaseMeta().version,
        currentSha: buildLocalReleaseMeta().sha,
      }) },
    ];
    let lastFailure = null;
    for (const attempt of attempts) {
      const reqHeaders = { ...headers };
      if (attempt.body) reqHeaders["content-type"] = "application/json";
      const r = await fetch(triggerUrl, {
        method: attempt.method,
        headers: reqHeaders,
        body: attempt.body,
        signal: fetchTimeoutSignal(12000),
      });
      const raw = await r.text();
      let responseBody = raw;
      try { responseBody = raw ? JSON.parse(raw) : null; } catch (_) {}
      if (r.ok) {
        _updateCache = null;
        return {
          ok: true,
          triggerAvailable: true,
          status: r.status,
          accepted: true,
          method: attempt.method,
          message: "Da gui lenh cap nhat toi updater service",
          response: responseBody,
        };
      }
      lastFailure = {
        ok: false,
        triggerAvailable: true,
        status: r.status,
        method: attempt.method,
        error: typeof responseBody === "string" ? responseBody.slice(0, 240) : ("trigger HTTP " + r.status),
      };
      if (r.status !== 404 && r.status !== 405) break;
    }
    return lastFailure || { ok: false, triggerAvailable: true, error: "Update trigger failed" };
  } catch (err) {
    return { ok: false, triggerAvailable: true, error: err.message || "Update trigger failed" };
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
  send(res, 200, { ok: true }, { "set-cookie": cookieClearHeader() });
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
  if (store.backend !== "pg") {
    return { queued: pendingTranscodeCount(), running: 0 };
  }
  const pool = db();
  const { rows } = await pool.query(`
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
  if (store.backend === "pg") await initPg();
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
  await startEventBus().catch((e) => logger.error({ err: e.message }, "event bus bootstrap failed"));
})();
