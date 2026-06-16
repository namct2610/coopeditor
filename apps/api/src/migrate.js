// Tiny migration runner. Applies every .sql file under ../migrations in order,
// recording version in schema_migrations. Idempotent.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, initPg, close } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, "..", "migrations");

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL must be set (e.g. postgres://frame:frame@localhost:5432/coopeditor)"); process.exit(1); }
  await initPg();
  const pool = db();
  // bootstrap migrations table itself
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await pool.query(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let n = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    console.log("[migrate] applying " + f);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [f]);
      await client.query("COMMIT");
      n++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[migrate] failed " + f + ": " + err.message);
      process.exit(1);
    } finally { client.release(); }
  }
  console.log("[migrate] " + (n ? n + " new migration(s) applied" : "nothing to do"));
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
