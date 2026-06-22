// DB router. Picks the driver from DATABASE_URL:
//   * sqlite:/path/to/file.db  → better-sqlite3 (native SPK / single-host)
//   * sqlite:./relative.db     → relative to process.cwd()
//   * postgres://...           → pg pool (Docker stack / clustered deploy)
//   * (unset)                  → in-memory store, no driver loaded
//
// store-pg.js + migrate.js call db() to get an object exposing
// .query(sql, params) and .connect()/.release(). Both drivers expose that
// shape via their own adapter, so callers don't branch on driver.

import { initSqlite, sqliteHandle, closeSqlite } from "./db-sqlite.js";

let _pgPool = null;
let _Pool = null;
let _logged = false;
let _driver = null;

async function loadPg() {
  if (_Pool) return _Pool;
  const mod = await import("pg");
  _Pool = mod.default ? mod.default.Pool : mod.Pool;
  return _Pool;
}

function detectDriver() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) return null;
  if (url.startsWith("sqlite:") || url.startsWith("file:")) return "sqlite";
  if (url.startsWith("postgres:") || url.startsWith("postgresql:")) return "postgres";
  return null;
}

function sqlitePath() {
  const url = String(process.env.DATABASE_URL || "").trim();
  // Accept `sqlite:/abs/path.db`, `sqlite:./rel.db`, `sqlite::memory:`.
  const path = url.replace(/^sqlite:/i, "").replace(/^file:/i, "");
  return path || ":memory:";
}

export function db() {
  if (!process.env.DATABASE_URL) {
    if (!_logged) { console.log("[db] DATABASE_URL not set — running with in-memory store"); _logged = true; }
    return null;
  }
  if (_driver === "sqlite") {
    const h = sqliteHandle();
    if (!h) throw new Error("db() called before initPg()/initDb(); call await initDb() once at startup");
    return h;
  }
  if (_driver === "postgres") {
    if (!_pgPool) throw new Error("db() called before initPg(); call await initPg() once at startup");
    return _pgPool;
  }
  if (!_logged) { console.log("[db] DATABASE_URL set but driver not initialised — call initDb() at startup"); _logged = true; }
  return null;
}

export async function initDb() {
  const driver = detectDriver();
  if (!driver) return null;
  if (driver === "sqlite") {
    _driver = "sqlite";
    return initSqlite(sqlitePath());
  }
  if (driver === "postgres") {
    _driver = "postgres";
    return initPg();
  }
  return null;
}

// Back-compat shim — old call sites use initPg().
export async function initPg() {
  if (detectDriver() === "sqlite") return initDb();
  if (!process.env.DATABASE_URL || _pgPool) return _pgPool;
  _driver = "postgres";
  const Pool = await loadPg();
  _pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  _pgPool.on("error", (err) => console.error("[db] pool error:", err.message));
  return _pgPool;
}

export async function close() {
  if (_driver === "sqlite") { closeSqlite(); _driver = null; return; }
  if (_pgPool) { await _pgPool.end(); _pgPool = null; _driver = null; }
}

export function activeDriver() { return _driver; }
