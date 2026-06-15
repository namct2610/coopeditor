// Postgres connection pool with lazy import of the `pg` package — so when
// DATABASE_URL is unset we don't even require pg to be installed.

let _pool = null;
let _logged = false;
let _Pool = null;

async function loadPg() {
  if (_Pool) return _Pool;
  const mod = await import("pg");
  _Pool = mod.default ? mod.default.Pool : mod.Pool;
  return _Pool;
}

export function db() {
  if (!process.env.DATABASE_URL) {
    if (!_logged) { console.log("[db] DATABASE_URL not set — running with in-memory store"); _logged = true; }
    return null;
  }
  if (!_pool) {
    // synchronous callers (most queries) need a ready pool; do a synchronous load via require
    // when ESM doesn't allow it, fall back to throwing.
    throw new Error("db() called before initPg(); call await initPg() once at startup");
  }
  return _pool;
}

export async function initPg() {
  if (!process.env.DATABASE_URL || _pool) return _pool;
  const Pool = await loadPg();
  _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  _pool.on("error", (err) => console.error("[db] pool error:", err.message));
  return _pool;
}

export async function close() { if (_pool) { await _pool.end(); _pool = null; } }
