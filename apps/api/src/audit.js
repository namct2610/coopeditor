// Single entry point for audit-log writes. Persists to Postgres when available,
// otherwise to an in-memory ring so memory-mode dev still gets a feel for it.

import { db } from "./db.js";
import { logger } from "./logger.js";

const MEM_LIMIT = 5000;
const memLog = [];

export async function record({ actorUserId, action, resourceType, resourceId, projectId, payload }) {
  const entry = {
    actorUserId: actorUserId || null,
    action,
    resourceType,
    resourceId: resourceId || null,
    projectId: projectId || null,
    payload: payload || {},
    createdAt: new Date().toISOString(),
  };
  if (process.env.DATABASE_URL) {
    try {
      await db().query(
        `INSERT INTO audit_log (actor_user_id, action, resource_type, resource_id, project_id, payload)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [entry.actorUserId, entry.action, entry.resourceType, entry.resourceId, entry.projectId, JSON.stringify(entry.payload)],
      );
    } catch (err) {
      logger.error({ err: err.message, action }, "audit write failed");
    }
    return;
  }
  memLog.push({ id: memLog.length + 1, ...entry });
  if (memLog.length > MEM_LIMIT) memLog.splice(0, memLog.length - MEM_LIMIT);
}

export async function listForProject(projectId, limit = 100) {
  if (process.env.DATABASE_URL) {
    const { rows } = await db().query(
      `SELECT id, actor_user_id, action, resource_type, resource_id, project_id, payload, created_at
         FROM audit_log
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [projectId, Math.min(500, Math.max(1, limit))],
    );
    return rows.map(mapRow);
  }
  return memLog.filter((e) => e.projectId === projectId).slice(-limit).reverse();
}

export async function listRecent(limit = 100) {
  if (process.env.DATABASE_URL) {
    const { rows } = await db().query(
      `SELECT id, actor_user_id, action, resource_type, resource_id, project_id, payload, created_at
         FROM audit_log
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(500, Math.max(1, limit))],
    );
    return rows.map(mapRow);
  }
  return memLog.slice(-limit).reverse();
}

function mapRow(r) {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    projectId: r.project_id,
    payload: r.payload || {},
    createdAt: r.created_at,
  };
}
