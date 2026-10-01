// Regression: SPK upgrades never ran migrations, so a NAS that was first
// installed on an old version kept its old schema ("no such table: scripts").
// The API must apply pending SQLite migrations itself at boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const PORT = 4397;
const BASE = "http://127.0.0.1:" + PORT;

test("API boot applies pending SQLite migrations to an old NAS database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coopeditor-boot-migrate-"));
  const dbPath = join(dir, "coopeditor.db");
  const env = { ...process.env, DATABASE_URL: "sqlite:" + dbPath };
  let proc = null;
  try {
    // Build an "old install": full schema, then roll back everything after 001.
    assert.equal(spawnSync(process.execPath, [join(SRC, "migrate.js")], { env }).status, 0);
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE script_comments; DROP TABLE scripts;
      DROP INDEX projects_air_date_idx; ALTER TABLE projects DROP COLUMN air_date;
      DROP INDEX IF EXISTS assets_air_date_idx; ALTER TABLE assets DROP COLUMN air_date;
      DELETE FROM schema_migrations WHERE version <> '001_init.sql';`);
    raw.close();

    proc = spawn(process.execPath, [join(SRC, "server.js")], {
      env: { ...env, PORT: String(PORT), APP_DATA_DIR: dir, DSM_DEV_LOGIN: "1", ALLOWED_ORIGINS: "http://localhost:3000" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await wait(150); up = await fetch(BASE + "/health").then((r) => r.ok, () => false); }
    assert.ok(up, "API came up");

    const check = new Database(dbPath, { readonly: true });
    const applied = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
    const hasScripts = !!check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scripts'").get();
    const projectCols = check.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
    check.close();
    assert.ok(applied.includes("004_scripts.sql"), "pending migrations recorded: " + applied.join(","));
    assert.ok(hasScripts, "scripts table created");
    assert.ok(projectCols.includes("air_date"), "air_date column restored");

    // and the feature actually works through the API
    const login = await fetch(BASE + "/auth/dsm/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "minh", passwd: "x" }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const created = await fetch(BASE + "/scripts", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "Sau nâng cấp" }) });
    assert.equal(created.status, 201);
  } finally {
    if (proc) proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
