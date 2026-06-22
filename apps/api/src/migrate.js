// Tiny migration runner. Applies every .sql file under ../migrations (Postgres)
// or ../migrations-sqlite (SQLite) in order, recording version in
// schema_migrations. Idempotent.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, initDb, close, activeDriver } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function migrationsDir() {
  return activeDriver() === "sqlite"
    ? join(__dirname, "..", "migrations-sqlite")
    : join(__dirname, "..", "migrations");
}

async function applyOne(file, sql) {
  if (activeDriver() === "sqlite") {
    // SQLite: better-sqlite3 supports multi-statement .exec() inside a
    // single transaction wrapper. Use the raw handle directly because
    // some statements (CREATE INDEX ... WHERE) don't survive the
    // placeholder rewrite path.
    const handle = db();
    const raw = handle && handle._raw;
    if (!raw) throw new Error("sqlite raw handle unavailable");
    raw.exec("BEGIN");
    try {
      raw.exec(sql);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(file);
      raw.exec("COMMIT");
    } catch (err) {
      try { raw.exec("ROLLBACK"); } catch (_) {}
      throw err;
    }
    return;
  }
  // Postgres path: per-statement client + transaction.
  const pool = db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set (e.g. postgres://frame:frame@localhost:5432/coopeditor, or sqlite:/data/coopeditor.db)");
    process.exit(1);
  }
  await initDb();
  const dir = migrationsDir();
  const handle = db();
  // bootstrap migrations table itself — same DDL works on both dialects
  // because we keep it ANSI-compatible.
  if (activeDriver() === "sqlite") {
    handle._raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  } else {
    await handle.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  }
  const appliedRows = activeDriver() === "sqlite"
    ? handle._raw.prepare("SELECT version FROM schema_migrations").all()
    : (await handle.query("SELECT version FROM schema_migrations")).rows;
  const applied = new Set(appliedRows.map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let n = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    console.log("[migrate] applying " + f);
    try {
      await applyOne(f, sql);
      n++;
    } catch (err) {
      console.error("[migrate] failed " + f + ": " + err.message);
      process.exit(1);
    }
  }
  console.log("[migrate] " + (n ? n + " new migration(s) applied" : "nothing to do"));
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
