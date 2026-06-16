// Postgres-backed implementation of the store API. Exposes the same surface
// as store.js (listProjects, getProject, listAssetsByProject, reorderAssets,
// listVersionsForAsset, listRenditionsForVersion, listCommentsForVersion,
// addComment, setCommentResolved, upsertUserFromDsm, addAssetFromImport,
// setRenditionStatus, users Map, etc.) so server.js can swap by import.

import { randomUUID } from "node:crypto";
import { db } from "./db.js";

const RUNGS = [
  { height: 540, label: "540p", bitrateKbps: 1800 },
  { height: 720, label: "720p", bitrateKbps: 3500 },
  { height: 1080, label: "1080p", bitrateKbps: 8000 },
];

async function q(sql, params) { return (await db().query(sql, params)).rows; }
async function one(sql, params) { return (await db().query(sql, params)).rows[0] || null; }

// camelCase mapping helpers — DB uses snake_case
const projectRow = (r) => r && ({
  id: r.id, name: r.name, status: r.status, client: r.client,
  updatedAt: r.updated_at, teamUserIds: r.team_user_ids || [], myRole: r.my_role || undefined,
  archivedAt: r.archived_at || null, createdAt: r.created_at,
});
const assetRow = (r) => r && ({
  id: r.id, projectId: r.project_id, title: r.title, position: r.position, nasPath: r.nas_path,
  codec: r.codec, sizeLabel: r.size_label, durationMs: r.duration_ms, frameRate: r.frame_rate,
  status: r.status, progress: r.progress, paletteA: r.palette_a, paletteB: r.palette_b,
  commentsCount: Number(r.comments_count || 0), versionsCount: Number(r.versions_count || 0),
  createdAt: r.created_at,
});
const versionRow = (r) => r && ({
  id: r.id, assetId: r.asset_id, versionNumber: r.version_number, label: r.label, note: r.note,
  authorUserId: r.author_user_id, createdAt: r.created_at,
});
const renditionRow = (r) => r && ({
  id: r.id, assetVersionId: r.asset_version_id, height: r.height, label: r.label,
  bitrateKbps: r.bitrate_kbps, status: r.status, progress: r.progress, hlsMasterUrl: r.hls_master_url,
});
const commentRow = (r) => r && ({
  id: r.id, assetVersionId: r.asset_version_id, authorUserId: r.author_user_id, content: r.content,
  timestampMs: r.timestamp_ms, frameNumber: r.frame_number, resolved: r.resolved,
  parentId: r.parent_id, deletedAt: r.deleted_at || null,
  annotation: r.annotation || null, createdAt: r.created_at,
});
const userRow = (r) => r && ({
  id: r.id, name: r.name, initial: r.initial, color: r.color, role: r.role,
  dsmUid: r.dsm_uid, email: r.email,
});
const projectMemberRow = (r) => r && ({
  projectId: r.project_id,
  userId: r.user_id,
  role: r.role,
  position: r.position,
  createdAt: r.created_at,
});
const projectTemplateRow = (r) => r && ({
  id: r.id,
  name: r.name,
  description: r.description || "",
  sourceProjectId: r.source_project_id || null,
  defaultClient: r.default_client || "",
  createdByUserId: r.created_by_user_id || null,
  createdAt: r.created_at,
});

// --- queries used by server.js ---

export async function listProjects() {
  const rows = await q(`
    SELECT p.*,
      COALESCE((SELECT array_agg(user_id ORDER BY position) FROM project_members t WHERE t.project_id = p.id), '{}') AS team_user_ids
    FROM projects p ORDER BY p.created_at`);
  return rows.map(projectRow);
}
export async function listProjectsForUser(userId, { includeArchived = false } = {}) {
  const filter = includeArchived ? "" : "AND p.archived_at IS NULL";
  const rows = await q(`
    SELECT p.*,
      pm.role AS my_role,
      COALESCE((SELECT array_agg(user_id ORDER BY position) FROM project_members t WHERE t.project_id = p.id), '{}') AS team_user_ids
    FROM project_members pm
    JOIN projects p ON p.id = pm.project_id
    WHERE pm.user_id = $1 ${filter}
    ORDER BY p.created_at`, [userId]);
  return rows.map(projectRow);
}
export async function createProject({ name, client, status = "progress", ownerUserId }) {
  const id = "p_" + randomUUID().slice(0, 8);
  const project = await one(`
    INSERT INTO projects (id, name, status, client)
    VALUES ($1, $2, $3, $4)
    RETURNING *`, [id, name, status, client || ""]);
  if (ownerUserId) {
    await q(`INSERT INTO project_members (project_id, user_id, role, position) VALUES ($1, $2, 'owner', 0)`, [id, ownerUserId]);
  }
  return getProject(id);
}
export async function listProjectTemplates() {
  return (await q(`SELECT * FROM project_templates ORDER BY created_at, name`)).map(projectTemplateRow);
}
export async function getProjectTemplate(id) {
  return projectTemplateRow(await one(`SELECT * FROM project_templates WHERE id = $1`, [id]));
}
export async function createProjectTemplate({ name, description = "", sourceProjectId = null, defaultClient = "", createdByUserId }) {
  const id = "tpl_" + randomUUID().slice(0, 8);
  const row = await one(`
    INSERT INTO project_templates (id, name, description, source_project_id, default_client, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
  [id, name, description || "", sourceProjectId || null, defaultClient || "", createdByUserId || null]);
  return projectTemplateRow(row);
}
export async function duplicateProject(sourceId, { newName, ownerUserId }) {
  const src = await getProject(sourceId);
  if (!src) return null;
  const id = "p_" + randomUUID().slice(0, 8);
  await q(`INSERT INTO projects (id, name, status, client) VALUES ($1, $2, 'progress', $3)`, [id, newName || (src.name + " (copy)"), src.client]);
  // copy memberships (including the requestor as owner if not already a member)
  const members = await listProjectMembers(sourceId);
  let pos = 0;
  for (const m of members) {
    await q(`INSERT INTO project_members (project_id, user_id, role, position) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, m.userId, m.role, pos++]);
  }
  if (ownerUserId && !members.some((m) => m.userId === ownerUserId)) {
    await q(`INSERT INTO project_members (project_id, user_id, role, position) VALUES ($1, $2, 'owner', $3) ON CONFLICT DO NOTHING`, [id, ownerUserId, pos]);
  }
  return getProject(id);
}
export async function createProjectFromTemplate(templateId, { name, client, ownerUserId }) {
  const template = await getProjectTemplate(templateId);
  if (!template) return null;
  const projectName = name && name.trim() ? name.trim() : `${template.name} ${new Date().toISOString().slice(0, 10)}`;
  if (template.sourceProjectId) {
    const duplicated = await duplicateProject(template.sourceProjectId, { newName: projectName, ownerUserId });
    if (!duplicated) return null;
    if ((client && client.trim()) || template.defaultClient) {
      return patchProject(duplicated.id, { name: duplicated.name, client: client && client.trim() ? client.trim() : template.defaultClient });
    }
    return duplicated;
  }
  return createProject({
    name: projectName,
    client: client && client.trim() ? client.trim() : (template.defaultClient || ""),
    ownerUserId,
  });
}
export async function archiveProject(id) {
  return projectRow(await one(`UPDATE projects SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING *`, [id]));
}
export async function restoreProject(id) {
  return projectRow(await one(`UPDATE projects SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL RETURNING *`, [id]));
}
export async function getProject(id) {
  const r = await one(`
    SELECT p.*,
      COALESCE((SELECT array_agg(user_id ORDER BY position) FROM project_members t WHERE t.project_id = p.id), '{}') AS team_user_ids
    FROM projects p WHERE id = $1`, [id]);
  return projectRow(r);
}
export async function getProjectMember(projectId, userId) {
  return projectMemberRow(await one(`SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]));
}
export async function listProjectMembers(projectId) {
  return (await q(`SELECT * FROM project_members WHERE project_id = $1 ORDER BY position`, [projectId])).map(projectMemberRow);
}
export async function listProjectMembersForUser(userId) {
  return (await q(`SELECT * FROM project_members WHERE user_id = $1 ORDER BY created_at`, [userId])).map(projectMemberRow);
}
export async function upsertProjectMember(projectId, userId, role) {
  const positionRow = await one(`SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM project_members WHERE project_id = $1`, [projectId]);
  const row = await one(`
    INSERT INTO project_members (project_id, user_id, role, position)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (project_id, user_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING *`, [projectId, userId, role, positionRow.next_position]);
  return projectMemberRow(row);
}
export async function setProjectMemberRole(projectId, userId, role) {
  return projectMemberRow(await one(`
    UPDATE project_members
       SET role = $3
     WHERE project_id = $1 AND user_id = $2
     RETURNING *`, [projectId, userId, role]));
}
export async function removeProjectMember(projectId, userId) {
  return projectMemberRow(await one(`
    DELETE FROM project_members
     WHERE project_id = $1 AND user_id = $2
     RETURNING *`, [projectId, userId]));
}
export async function listProjectMemberUserIds(projectId) {
  return (await q(`SELECT user_id FROM project_members WHERE project_id = $1 ORDER BY position`, [projectId])).map((row) => row.user_id);
}
export async function patchProject(id, patch) {
  const sets = []; const vals = []; let i = 1;
  if (patch.status) { sets.push("status = $" + i++); vals.push(patch.status); }
  if (patch.name) { sets.push("name = $" + i++); vals.push(patch.name); }
  if (typeof patch.client === "string") { sets.push("client = $" + i++); vals.push(patch.client); }
  sets.push("updated_at = 'vừa xong'");
  vals.push(id);
  await q(`UPDATE projects SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  return getProject(id);
}

export async function listAssetsByProject(pid) {
  const rows = await q(`
    SELECT a.*,
      (SELECT COUNT(*) FROM comments c JOIN asset_versions v ON v.id = c.asset_version_id WHERE v.asset_id = a.id AND c.parent_id IS NULL) AS comments_count,
      (SELECT COUNT(*) FROM asset_versions v WHERE v.asset_id = a.id) AS versions_count
    FROM assets a
    WHERE a.project_id = $1 ORDER BY a.position`, [pid]);
  return rows.map(assetRow);
}
export async function getAsset(id) { return assetRow(await one(`SELECT * FROM assets WHERE id = $1`, [id])); }
export async function findProjectIdForAsset(assetId) {
  const row = await one(`SELECT project_id FROM assets WHERE id = $1`, [assetId]);
  return row ? row.project_id : null;
}

export async function reorderAssets(pid, orderedIds) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE assets SET position = $1 WHERE id = $2 AND project_id = $3`, [i, orderedIds[i], pid]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function listVersionsForAsset(assetId) {
  const rows = await q(`SELECT * FROM asset_versions WHERE asset_id = $1 ORDER BY version_number`, [assetId]);
  return rows.map(versionRow);
}
export async function getVersion(id) { return versionRow(await one(`SELECT * FROM asset_versions WHERE id = $1`, [id])); }
export async function findProjectIdForVersion(versionId) {
  const row = await one(`
    SELECT a.project_id
      FROM asset_versions v
      JOIN assets a ON a.id = v.asset_id
     WHERE v.id = $1`, [versionId]);
  return row ? row.project_id : null;
}
export async function findProjectIdForRendition(renditionId) {
  const row = await one(`
    SELECT a.project_id
      FROM renditions r
      JOIN asset_versions v ON v.id = r.asset_version_id
      JOIN assets a ON a.id = v.asset_id
     WHERE r.id = $1`, [renditionId]);
  return row ? row.project_id : null;
}

export async function listRenditionsForVersion(vid) {
  const rows = await q(`SELECT * FROM renditions WHERE asset_version_id = $1 ORDER BY height`, [vid]);
  return rows.map(renditionRow);
}
export async function getRendition(id) { return renditionRow(await one(`SELECT * FROM renditions WHERE id = $1`, [id])); }
export async function setRenditionStatus(id, patch) {
  const sets = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    const col = k === "hlsMasterUrl" ? "hls_master_url" : k; // simple snake-case for the fields we use
    sets.push(col + " = $" + i++); vals.push(v);
  }
  vals.push(id);
  await q(`UPDATE renditions SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  return getRendition(id);
}
export async function listProcessingRenditions() {
  return (await q(`SELECT * FROM renditions WHERE status = 'processing'`)).map(renditionRow);
}
export async function listProcessingAssets() {
  return (await q(`SELECT * FROM assets WHERE status = 'processing'`)).map(assetRow);
}
export async function setAssetStatus(id, patch) {
  const sets = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(patch)) { sets.push(k + " = $" + i++); vals.push(v); }
  vals.push(id);
  await q(`UPDATE assets SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

export async function listCommentsForVersion(vid, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? `SELECT * FROM comments WHERE asset_version_id = $1 ORDER BY COALESCE(parent_id, id), created_at`
    : `SELECT * FROM comments WHERE asset_version_id = $1 AND deleted_at IS NULL ORDER BY COALESCE(parent_id, id), created_at`;
  return (await q(sql, [vid])).map(commentRow);
}
export async function getComment(id) { return commentRow(await one(`SELECT * FROM comments WHERE id = $1`, [id])); }
export async function findProjectIdForComment(commentId) {
  const row = await one(`
    SELECT a.project_id
      FROM comments c
      JOIN asset_versions v ON v.id = c.asset_version_id
      JOIN assets a ON a.id = v.asset_id
     WHERE c.id = $1`, [commentId]);
  return row ? row.project_id : null;
}
export async function addComment(input) {
  const id = randomUUID();
  const row = await one(`INSERT INTO comments (id, asset_version_id, author_user_id, content, timestamp_ms, frame_number, parent_id, annotation)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, input.assetVersionId, input.authorUserId, input.content, input.timestampMs || 0, input.frameNumber || null, input.parentId || null, input.annotation ? JSON.stringify(input.annotation) : null]);
  return commentRow(row);
}
export async function setCommentResolved(id, resolved) {
  const row = await one(`UPDATE comments SET resolved = $1 WHERE id = $2 RETURNING *`, [!!resolved, id]);
  return commentRow(row);
}
export async function setCommentContent(id, content) {
  const row = await one(`UPDATE comments SET content = $1 WHERE id = $2 RETURNING *`, [content, id]);
  return commentRow(row);
}
export async function deleteComment(id) {
  return commentRow(await one(`UPDATE comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`, [id]));
}
export async function restoreComment(id) {
  return commentRow(await one(`UPDATE comments SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`, [id]));
}

export async function listUsers() { return (await q(`SELECT * FROM users ORDER BY created_at`)).map(userRow); }
export async function getUser(id) { return userRow(await one(`SELECT * FROM users WHERE id = $1`, [id])); }

export async function upsertUserFromDsm({ uid, name, email }) {
  const aliasId = aliasUserId(name || email || "");
  if (aliasId) {
    const existing = await one(`
      UPDATE users
         SET name = COALESCE($2, name),
             initial = COALESCE($3, initial),
             dsm_uid = $4,
             email = COALESCE($5, email)
       WHERE id = $1
       RETURNING *`, [aliasId, name || null, (name || "?").trim().charAt(0).toUpperCase(), uid, email || null]);
    if (existing) return userRow(existing);
  }

  const id = "dsm_" + uid;
  const palette = ["#2da8e2", "#e072a8", "#f5a623", "#a07bff", "#35c389", "#ef4d57"];
  const color = palette[uid % palette.length];
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const row = await one(`INSERT INTO users (id, name, initial, color, role, dsm_uid, email)
    VALUES ($1,$2,$3,$4,'editor',$5,$6)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email
    RETURNING *`, [id, name || "?", initial, color, uid, email]);
  return userRow(row);
}

export async function upsertUserFromOidc({ issuer, sub, name, email }) {
  // Try to match by (issuer, sub) first, then email fallback so existing DSM
  // accounts can also sign in via OIDC without duplicating.
  const existing = await one(
    `SELECT * FROM users WHERE (oidc_issuer = $1 AND oidc_sub = $2) OR (email IS NOT NULL AND email = $3) LIMIT 1`,
    [issuer, sub, email || null],
  );
  if (existing) {
    const row = await one(`
      UPDATE users SET oidc_issuer = $2, oidc_sub = $3,
        name = COALESCE($4, name), email = COALESCE($5, email)
      WHERE id = $1 RETURNING *`,
      [existing.id, issuer, sub, name || null, email || null]);
    return userRow(row);
  }
  const id = "oidc_" + sub.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const palette = ["#2da8e2", "#e072a8", "#f5a623", "#a07bff", "#35c389", "#ef4d57"];
  const color = palette[Math.abs(hashCode(sub)) % palette.length];
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const row = await one(`
    INSERT INTO users (id, name, initial, color, role, email, oidc_issuer, oidc_sub)
    VALUES ($1,$2,$3,$4,'editor',$5,$6,$7)
    RETURNING *`, [id, name || "User", initial, color, email || null, issuer, sub]);
  return userRow(row);
}

function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0; return h; }

function aliasUserId(raw) {
  const key = String(raw || "").trim().toLowerCase();
  const slug = key.split("@")[0];
  const map = {
    minh: "u_minh",
    lan: "u_lan",
    tu: "u_tu",
    phong: "u_phong",
    khach: "u_khach",
    client: "u_khach",
  };
  return map[slug] || null;
}

// --- transcode job queue (pg-only) ---
export async function enqueueTranscode(renditionId) {
  await q(`INSERT INTO transcode_jobs (rendition_id) VALUES ($1)`, [renditionId]);
  // notify the worker(s) so they can wake up immediately
  await q(`SELECT pg_notify('coopeditor_jobs', $1)`, [renditionId]).catch(() => {});
}

export async function addAssetFromImport({ projectId, title, codec, sizeLabel, durationMs, nasPath }) {
  const id = "imp_" + randomUUID().slice(0, 8);
  const PAL = [["#0c2436","#1c5876"],["#2a1d0c","#7a521d"],["#0c1c33","#234a78"],["#15171c","#3a4453"],["#291230","#6e2a55"],["#241a0e","#7a5524"],["#102b2b","#1f5a52"],["#1a1430","#3a2f6e"]];
  const existing = (await one(`SELECT COUNT(*)::int AS n FROM assets WHERE project_id = $1`, [projectId])).n;
  const [a, b] = PAL[existing % PAL.length];
  const aRow = await one(`INSERT INTO assets (id, project_id, title, position, nas_path, codec, size_label, duration_ms, frame_rate, status, progress, palette_a, palette_b)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,24,'processing',$9,$10,$11) RETURNING *`,
    [id, projectId, title, existing, nasPath, codec, sizeLabel, durationMs, 5 + Math.floor(Math.random() * 8), a, b]);

  // seed V1 + 3 renditions (pending; worker will tick when requested or on import)
  const vid = id + "_v1";
  await q(`INSERT INTO asset_versions (id, asset_id, version_number, label, note, author_user_id)
    VALUES ($1,$2,1,'V1','current',(SELECT id FROM users LIMIT 1))`, [vid, id]);
  for (const r of RUNGS) {
    await q(`INSERT INTO renditions (id, asset_version_id, height, label, bitrate_kbps, status, progress)
      VALUES ($1,$2,$3,$4,$5,'pending',0)`, [vid + "_" + r.label, vid, r.height, r.label, r.bitrateKbps]);
  }
  return assetRow({ ...aRow, comments_count: 0, versions_count: 1 });
}
