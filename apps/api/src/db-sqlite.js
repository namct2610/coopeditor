// SQLite driver adapter that exposes the same `query()` / `connect()` /
// `release()` interface as the pg pool. Letting store-pg.js work unchanged
// once we run a migration pass to map Postgres-specific SQL features to
// SQLite equivalents.
//
// Why this shape:
//   * store-pg.js calls `pool.query(sql, params)` and reads `result.rows`.
//     better-sqlite3 returns rows directly from `.all()` — we wrap so the
//     return shape matches `{ rows, rowCount }`.
//   * pg uses positional placeholders `$1, $2, ...`; SQLite uses `?`. We
//     rewrite at execute time without parsing — naive but correct since
//     placeholders never appear inside string literals in our codebase.
//   * pg's `INSERT ... RETURNING *` works on SQLite 3.35+; better-sqlite3
//     ships SQLite 3.46+, so this is a no-op compatibility.
//   * Transactions: store-pg.js uses `pool.connect()` + `BEGIN/COMMIT`. We
//     wrap that into `db.transaction(fn)` semantics by handing out a
//     pseudo-client that buffers statements until COMMIT.
//
// Limitations (handled in migrations-sqlite/, not here):
//   * No native arrays. text[] / int[] migrate to JSON TEXT columns.
//   * No JSONB. JSONB columns migrate to TEXT and code parses via JSON.parse.
//   * TIMESTAMPTZ → TEXT (ISO 8601). NOW() → CURRENT_TIMESTAMP.
//   * gen_random_uuid() → done in JS before INSERT.
//   * No LISTEN/NOTIFY. Event bus already has an in-process fallback.

let _db = null;
let _adapter = null;
let _logged = false;

function rewritePlaceholders(sql) {
  // Naive $N → ? rewrite. Safe because the codebase never embeds `$N` inside
  // string literals (verified by grep). If that changes, switch to a proper
  // SQL tokeniser.
  let s = sql.replace(/\$(\d+)/g, "?");
  // Postgres-isms that SQLite refuses but both dialects accept the alternate:
  //   * now()              → CURRENT_TIMESTAMP  (both Postgres + SQLite)
  //   * NOW()              → CURRENT_TIMESTAMP
  // SQLite parses now() as a user function and bails with "no such function: now"
  // — exactly the error the user hit on login (sessions.js DELETE WHERE
  // expires_at <= now()). CURRENT_TIMESTAMP is standard SQL, no behaviour
  // change on Postgres.
  s = s.replace(/\bnow\(\)/gi, "CURRENT_TIMESTAMP");
  return s;
}

function isWrite(sql) {
  const t = sql.trim().slice(0, 12).toUpperCase();
  return t.startsWith("INSERT") || t.startsWith("UPDATE") || t.startsWith("DELETE")
    || t.startsWith("CREATE") || t.startsWith("DROP") || t.startsWith("ALTER")
    || t.startsWith("REPLACE");
}

function runOne(stmt, params) {
  // .all() works for SELECT + RETURNING; .run() for plain writes. Try .all()
  // first since RETURNING is now common — fall back to .run() when no result
  // columns (pure write).
  try {
    const rows = stmt.all(...(params || []));
    return { rows, rowCount: rows.length };
  } catch (err) {
    if (/This statement does not return data/i.test(err.message)) {
      const info = stmt.run(...(params || []));
      return { rows: [], rowCount: info.changes };
    }
    throw err;
  }
}

function makeAdapter(db) {
  return {
    async query(sql, params) {
      const stmt = db.prepare(rewritePlaceholders(sql));
      return runOne(stmt, params);
    },
    async connect() {
      // Pseudo-client for transactional code paths. Better-sqlite3 has its own
      // `.transaction(fn)` but store-pg.js uses imperative BEGIN/COMMIT, so we
      // buffer flag transitions on a client and execute the body inside an
      // immediate transaction.
      let inTx = false;
      const flush = (cb) => { if (inTx) { try { db.exec("ROLLBACK"); } catch (_) {} inTx = false; } if (cb) cb(); };
      return {
        async query(sql, params) {
          const trimmed = sql.trim().toUpperCase();
          if (trimmed === "BEGIN") { db.exec("BEGIN IMMEDIATE"); inTx = true; return { rows: [], rowCount: 0 }; }
          if (trimmed === "COMMIT") { db.exec("COMMIT"); inTx = false; return { rows: [], rowCount: 0 }; }
          if (trimmed === "ROLLBACK") { try { db.exec("ROLLBACK"); } catch (_) {} inTx = false; return { rows: [], rowCount: 0 }; }
          const stmt = db.prepare(rewritePlaceholders(sql));
          return runOne(stmt, params);
        },
        release() { flush(); },
      };
    },
    end() { db.close(); },
    // Expose raw handle for code paths that need .pragma() / .exec() (rare).
    _raw: db,
  };
}

export async function initSqlite(filename) {
  if (_adapter) return _adapter;
  const { default: Database } = await import("better-sqlite3");
  _db = new Database(filename);
  // Performance + durability tunings. WAL gives concurrent reads while a
  // writer is active; NORMAL syncs are fine on NAS (battery-backed RAID).
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");
  _adapter = makeAdapter(_db);
  if (!_logged) { console.log("[db-sqlite] opened " + filename); _logged = true; }
  return _adapter;
}

export function sqliteHandle() { return _adapter; }

export function closeSqlite() { if (_adapter) { _adapter.end(); _adapter = null; _db = null; } }
