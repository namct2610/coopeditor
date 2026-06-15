// Public, time-bound, optionally-scoped share links. Used by clients who
// don't have a DSM account to review videos and (if access_level=comment)
// leave comments as a "guest_label" identity.
//
// PG mode stores in share_links table; memory mode uses an in-process Map.

import { randomBytes } from "node:crypto";
import { db } from "./db.js";

const memLinks = new Map();

function token() { return randomBytes(18).toString("base64url"); }
function now() { return new Date().toISOString(); }

export async function create({ projectId, assetId, accessLevel = "review", createdBy, ttlHours = 168, guestLabel }) {
  const ttl = Math.min(720, Math.max(1, ttlHours));
  const t = token();
  const expiresAt = new Date(Date.now() + ttl * 3_600_000).toISOString();
  const link = { token: t, projectId, assetId: assetId || null, accessLevel, createdBy, createdAt: now(), expiresAt, revokedAt: null, guestLabel: guestLabel || null };
  if (process.env.DATABASE_URL) {
    await db().query(
      `INSERT INTO share_links (token, project_id, asset_id, access_level, created_by, expires_at, guest_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t, projectId, assetId || null, accessLevel, createdBy, expiresAt, guestLabel || null],
    );
  } else {
    memLinks.set(t, link);
  }
  return link;
}

export async function get(t) {
  if (!t) return null;
  if (process.env.DATABASE_URL) {
    const row = (await db().query(`SELECT * FROM share_links WHERE token = $1`, [t])).rows[0];
    return row ? mapRow(row) : null;
  }
  return memLinks.get(t) || null;
}

export async function isValid(link) {
  if (!link || link.revokedAt) return false;
  return new Date(link.expiresAt).getTime() > Date.now();
}

export async function revoke(t) {
  if (process.env.DATABASE_URL) {
    const row = (await db().query(`UPDATE share_links SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL RETURNING *`, [t])).rows[0];
    return row ? mapRow(row) : null;
  }
  const link = memLinks.get(t);
  if (!link || link.revokedAt) return null;
  link.revokedAt = now();
  return link;
}

export async function listForProject(projectId) {
  if (process.env.DATABASE_URL) {
    return (await db().query(`SELECT * FROM share_links WHERE project_id = $1 ORDER BY created_at DESC`, [projectId])).rows.map(mapRow);
  }
  return [...memLinks.values()].filter((l) => l.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function mapRow(r) {
  return {
    token: r.token,
    projectId: r.project_id,
    assetId: r.asset_id,
    accessLevel: r.access_level,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at || null,
    guestLabel: r.guest_label || null,
  };
}
