import { randomBytes } from "node:crypto";

import { db } from "./db.js";

const TTL_MS = 12 * 60 * 60 * 1000;
const TTL_SEC = Math.floor(TTL_MS / 1000);

export const COOKIE_NAME = "fe_sess";

const memorySessions = new Map();

function poolOrNull() {
  if (!process.env.DATABASE_URL) return null;
  return db();
}

function toExpiryIso() {
  return new Date(Date.now() + TTL_MS).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    token: row.token,
    userId: row.user_id,
    dsmSid: row.dsm_sid,
    createdAt: row.created_at,
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

async function purgeExpiredDbSessions(pool) {
  await pool.query(`DELETE FROM sessions WHERE expires_at <= now()`);
}

export async function createSession({ userId, dsmSid }) {
  const token = randomBytes(24).toString("base64url");
  const pool = poolOrNull();
  if (!pool) {
    memorySessions.set(token, {
      userId,
      dsmSid,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + TTL_MS,
    });
    return token;
  }

  await purgeExpiredDbSessions(pool);
  await pool.query(
    `INSERT INTO sessions (token, user_id, dsm_sid, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, dsmSid, toExpiryIso()],
  );
  return token;
}

export async function getSession(token) {
  if (!token) return null;
  const pool = poolOrNull();
  if (!pool) {
    const session = memorySessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      memorySessions.delete(token);
      return null;
    }
    return session;
  }

  const expired = await pool.query(
    `DELETE FROM sessions
      WHERE token = $1 AND expires_at <= now()
      RETURNING token`,
    [token],
  );
  if (expired.rowCount) return null;

  const row = (
    await pool.query(
      `SELECT token, user_id, dsm_sid, created_at, expires_at
         FROM sessions
        WHERE token = $1`,
      [token],
    )
  ).rows[0];
  return mapRow(row);
}

export async function destroySession(token) {
  if (!token) return null;
  const pool = poolOrNull();
  if (!pool) {
    const session = memorySessions.get(token) || null;
    memorySessions.delete(token);
    return session;
  }

  const row = (
    await pool.query(
      `DELETE FROM sessions
        WHERE token = $1
        RETURNING token, user_id, dsm_sid, created_at, expires_at`,
      [token],
    )
  ).rows[0];
  return mapRow(row);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SECURE = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";

export function cookieSetHeader(token, maxAgeSec = TTL_SEC) {
  const parts = [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAgeSec,
  ];
  if (SECURE) parts.push("Secure");
  return parts.join("; ");
}

export function cookieClearHeader() {
  const base = COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  return SECURE ? base + "; Secure" : base;
}
