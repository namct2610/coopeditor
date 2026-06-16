import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// Reusable random buffer for /speedtest/segment — generated once at startup and
// written repeatedly. 256 KiB is small enough to fit in CPU cache yet large
// enough that the per-chunk write overhead doesn't dominate at gigabit speeds.
const SPEEDTEST_NOISE = randomBytes(256 * 1024);

import * as store from "./store-index.js";
import { db, initPg } from "./db.js";
import * as dsm from "./dsm.js";
import { subscribe as sseSubscribe, subscriberCount, bindWsPublish } from "./events.js";
import { attachWebSocket, publish as wsPublish, subscriberCount as wsCount } from "./ws.js";
import { eventBusMode, publishEvent, startEventBus } from "./event-bus.js";
import { hasValidSignedPlaybackToken, serveHls } from "./hls-proxy.js";
import { applyCors, loginMetrics, loginRateLimit, loginSuccess } from "./security.js";
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
import { publicRuntimeSummary } from "./runtime-config.js";

// ---------- helpers ----------

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

// Annotation payload: { strokes: [{ tool: "pen"|"arrow"|"rect", color: "#RRGGBB", points: [[x01, y01], ...] }] }
// Coordinates are normalized 0..1 so they survive scaling. Size cap = 50 strokes × 256 points.
function validateAnnotation(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.strokes)) return null;
  const strokes = raw.strokes.slice(0, 50).map((s) => {
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
  }).filter(Boolean);
  if (!strokes.length) return null;
  return { strokes };
}

async function publishProjectEvent(projectId, event) {
  const userIds = await store.listProjectMemberUserIds(projectId);
  publishEvent({ ...event, projectId, userIds });
}

async function notifyCommentWebhook({ comment, projectId, authorUserId }) {
  const [project, version, author] = await Promise.all([store.getProject(projectId), store.getVersion(comment.assetVersionId), store.getUser(authorUserId)]);
  const asset = version ? await store.getAsset(version.assetId) : null;
  webhooks.notifyCommentCreated({
    projectName: project ? project.name : "Project",
    sourceTitle: asset ? asset.title : "(source)",
    authorName: author ? author.name : "Someone",
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
  mailer.notifyComment({
    recipients,
    projectName: project ? project.name : "Project",
    sourceTitle: asset ? asset.title : "(source)",
    authorName: author ? author.name : "Someone",
    content: comment.content,
    projectId,
    timestampMs: comment.timestampMs || 0,
  });
}

// ---------- routes ----------

async function handle(req, res, url) {
  const m = req.method || "GET";
  const p = url.pathname;

  if (!applyCors(req, res)) {
    res.statusCode = 403; res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Origin not allowed" }));
  }
  if (m === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = 204; return res.end();
  }

  setSecurityHeaders(res);

  if (p === "/health" && m === "GET") return send(res, 200, { ok: true, dsmConfigured: !dsm.isDevMode(), backend: store.backend });
  if (p === "/setup/status" && m === "GET") {
    // When server.js is running, runtime IS configured (via env or config file).
    // Force `configured: true` so the FE doesn't render the setup wizard.
    return send(res, 200, { ...publicRuntimeSummary(), configured: true });
  }
  if (p === "/version" && m === "GET") {
    return send(res, 200, {
      sha: process.env.BUILD_SHA || "unknown",
      builtAt: process.env.BUILT_AT || "unknown",
    });
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
      if (!projectId) return bad(res, "Rendition not found", 404);
      if (!(await requireProjectAccess(res, projectId, sess.userId))) return;
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
      const updated = await store.patchProject(projectId, body);
      if (!updated) return bad(res, "Project not found", 404);
      await audit.record({ actorUserId: sess.userId, action: "project.update", resourceType: "project", resourceId: projectId, projectId, payload: body });
      return send(res, 200, await decorateProject(updated, sess.userId));
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
      if (!body || typeof body.userId !== "string" || !["owner", "editor", "reviewer", "client"].includes(body.role)) {
        return bad(res, "userId and valid role required");
      }
      const user = await store.getUser(body.userId);
      if (!user) return bad(res, "User not found", 404);
      const member = await store.upsertProjectMember(projectId, body.userId, body.role);
      const project = await store.getProject(projectId);
      await audit.record({ actorUserId: sess.userId, action: "project.member_added", resourceType: "project_member", resourceId: body.userId, projectId, payload: { role: body.role, userName: user.name } });
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
  if ((mat = p.match(/^\/projects\/([^/]+)\/import$/)) && m === "POST") {
    const pid = mat[1];
    if (!(await requireProjectAccess(res, pid, sess.userId, ["owner", "editor"]))) return;
    if (!(await store.getProject(pid))) return bad(res, "Project not found", 404);
    const body = await readJson(req).catch(() => null);
    if (!body || !Array.isArray(body.nasPaths)) return bad(res, "nasPaths required");
    const created = [];
    for (const path of body.nasPaths) {
      const file = await dsm.getFileMeta(sess.dsmSid, path);
      if (!file || file.type !== "file") continue;
      const a = await store.addAssetFromImport({
        projectId: pid, title: file.name.replace(/\.[^.]+$/, ""), codec: file.codec || "unknown",
        sizeLabel: file.sizeLabel || "—", durationMs: file.durationMs || 0, nasPath: file.sourcePath || path,
      });
      created.push(a);
      const versions = await store.listVersionsForAsset(a.id);
      const rends = await store.listRenditionsForVersion(versions[0].id);
      for (const r of rends) requestTranscode(r.id);
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
      if (!body || ![540, 720, 1080].includes(body.height)) return bad(res, "height must be 540|720|1080");
      const r = (await store.listRenditionsForVersion(vid)).find((x) => x.height === body.height);
      if (!r) return bad(res, "Rendition not found", 404);
      if (r.status === "ready") return send(res, 200, r);
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
      const annotation = validateAnnotation(body.annotation);
      const c = await store.addComment({ assetVersionId: vid, authorUserId: sess.userId, content: body.content, timestampMs: body.timestampMs, frameNumber: body.frameNumber, parentId: body.parentId, annotation });
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
    const body = await readJson(req).catch(() => null);
    if (!body) return bad(res, "Invalid body");
    if (typeof body.content === "string") {
      const content = body.content.trim();
      if (!content) return bad(res, "content required");
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
    try { return send(res, 200, await dsm.dsmListFolder(sess.dsmSid, path)); }
    catch (err) { return bad(res, "NAS list failed: " + (err && err.message), 502); }
  }

  if (p === "/users" && m === "GET") return send(res, 200, await store.listUsers());

  if (p === "/admin/update-status" && m === "GET") {
    // Any logged-in owner of any project can check. (Cheaper than building a real "admin" role.)
    const members = await store.listProjectMembersForUser(sess.userId).catch(() => []);
    const isAdmin = members && members.some((mm) => mm.role === "owner");
    if (!isAdmin) return bad(res, "Forbidden", 403);
    return send(res, 200, await checkUpdateStatus());
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

  return bad(res, "Not found", 404);
}

async function decorateProject(p, userId) {
  const assets = await store.listAssetsByProject(p.id);
  const ready = assets.filter((a) => a.status === "ready").length;
  const commentsCount = assets.reduce((a, x) => a + (x.commentsCount || 0), 0);
  const team = [];
  for (const uid of (p.teamUserIds || [])) { const u = await store.getUser(uid); if (u) team.push(u); }
  const member = userId ? await store.getProjectMember(p.id, userId) : null;
  return { ...p, myRole: p.myRole || (member && member.role) || undefined, sourcesCount: assets.length, readyCount: ready, commentsCount, team };
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
async function checkUpdateStatus() {
  const localSha = process.env.BUILD_SHA || "unknown";
  const localBuiltAt = process.env.BUILT_AT || "unknown";
  const feed = process.env.UPDATE_FEED_URL || "";
  if (!feed) return { localSha, localBuiltAt, remoteSha: null, behind: 0, checkAvailable: false };

  // Cache 5 phút để không spam GitHub API
  if (_updateCache && Date.now() - _updateCache.at < 300_000) return { localSha, localBuiltAt, ..._updateCache.data };

  try {
    const r = await fetch(feed, { headers: { "user-agent": "coopeditor-updater", accept: "application/json" }, signal: AbortSignal.timeout?.(8000) });
    if (!r.ok) return { localSha, localBuiltAt, remoteSha: null, behind: 0, checkAvailable: false, error: "remote HTTP " + r.status };
    const body = await r.json();
    const remoteSha = body.sha || body.id || (body.commit && body.commit.sha) || null;
    const updateAvailable = !!(remoteSha && localSha !== "unknown" && remoteSha.slice(0, 7) !== localSha.slice(0, 7));
    const data = { remoteSha, updateAvailable, checkAvailable: true };
    _updateCache = { at: Date.now(), data };
    return { localSha, localBuiltAt, ...data };
  } catch (err) {
    return { localSha, localBuiltAt, remoteSha: null, behind: 0, checkAvailable: false, error: err.message };
  }
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
  const body = await readJson(req).catch(() => null);
  if (!body || typeof body.content !== "string" || typeof body.timestampMs !== "number") return bad(res, "content and timestampMs required");
  if (!body.assetVersionId) return bad(res, "assetVersionId required");
  // Verify the version belongs to the link's project + (if scoped) asset.
  const version = await store.getVersion(body.assetVersionId);
  if (!version) return bad(res, "Version not found", 404);
  const projectId = await store.findProjectIdForVersion(version.id);
  if (projectId !== link.projectId) return bad(res, "Version not in shared project", 403);
  if (link.assetId && version.assetId !== link.assetId) return bad(res, "Version not in shared asset", 403);
  // Use the link's owner (createdBy) as authorUserId; suffix the content with guest_label so it's clear who wrote it.
  const guestSuffix = link.guestLabel ? ` — ${link.guestLabel} (qua link share)` : ` — (qua link share)`;
  const c = await store.addComment({
    assetVersionId: body.assetVersionId,
    authorUserId: link.createdBy,
    content: body.content.trim() + guestSuffix,
    timestampMs: body.timestampMs,
    frameNumber: body.frameNumber,
    parentId: body.parentId,
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
