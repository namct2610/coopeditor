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
    const key = part.slice(0, i).trim();
    const rawValue = part.slice(i + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch (_) {
      // Malformed cookie fragments should not crash the whole request path.
      out[key] = rawValue;
    }
  }
  return out;
}

// Secure cookies only work over HTTPS. In NAS-first deployments the same box is
// commonly reached BOTH over https (public URL / reverse proxy) AND over plain
// http (LAN IP / Tailscale). Forcing Secure globally from the publicUrl scheme
// (COOKIE_SECURE=1) breaks the http path: the browser silently drops a Secure
// cookie received over http, so login returns 200 but the very next request is
// unauthenticated and the app bounces back to the login screen.
//
// So decide Secure PER REQUEST from the actual connection. Over https the cookie
// is Secure (correct); over http it is not, and the LAN login works. The env
// COOKIE_SECURE=1 stays as a fallback only for callers that have no request
// (there are none today) — the request signal always wins.
const SECURE_FALLBACK = process.env.COOKIE_SECURE === "1";

// True when the client↔edge leg is https. Trust x-forwarded-proto first (DSM's
// reverse proxy terminates TLS and forwards over http), then a direct TLS
// socket. Absent both → treat as http so LAN access keeps working.
export function isSecureRequest(req) {
  if (!req) return SECURE_FALLBACK;
  const xfProto = String((req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim().toLowerCase();
  if (xfProto) return xfProto === "https";
  if (req.headers && String(req.headers["x-forwarded-ssl"] || "").toLowerCase() === "on") return true;
  return !!(req.socket && req.socket.encrypted);
}

export function cookieSetHeader(token, maxAgeSec = TTL_SEC, secure = SECURE_FALLBACK) {
  const parts = [
    COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + maxAgeSec,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function cookieClearHeader(secure = SECURE_FALLBACK) {
  const base = COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  return secure ? base + "; Secure" : base;
}
