import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectWorkerMountHealth, ensureWorkerMountReady, reportWorkerBootstrapFailure, shouldFailWorkerStartup, createWorkerRuntimeReporter } from "../src/runtime-status.js";

const migrateEntry = fileURLToPath(new URL("../../api/src/migrate.js", import.meta.url));

function spawnAndWait(file, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      reject(new Error(file + " timed out\nSTDOUT:\n" + stdout + "\nSTDERR:\n" + stderr));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(file + " exited " + code + "\nSTDOUT:\n" + stdout + "\nSTDERR:\n" + stderr));
    });
  });
}

test("detectWorkerMountHealth reports ready for an existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "co-worker-mount-"));
  const status = await detectWorkerMountHealth({ DSM_MOUNT_ROOT: root });
  assert.equal(status.dsmMountRoot, root);
  assert.equal(status.mountReady, true);
  assert.equal(status.mountError, "");
});

test("detectWorkerMountHealth reports ENOENT clearly", async () => {
  const missing = join(tmpdir(), "co-worker-mount-missing-" + Date.now());
  const status = await detectWorkerMountHealth({ DSM_MOUNT_ROOT: missing });
  assert.equal(status.mountReady, false);
  assert.match(status.mountError, /chưa thấy DSM mount root/i);
});

test("detectWorkerMountHealth rejects a file path as invalid mount root", async () => {
  const root = await mkdtemp(join(tmpdir(), "co-worker-mount-file-"));
  const file = join(root, "not-a-dir.txt");
  await writeFile(file, "x", "utf8");
  const status = await detectWorkerMountHealth({ DSM_MOUNT_ROOT: file });
  assert.equal(status.mountReady, false);
  assert.match(status.mountError, /không phải thư mục NAS hợp lệ|khong phai thu muc NAS hop le/i);
});

test("detectWorkerMountHealth falls back to /nas for legacy host-path configs", async () => {
  const root = await mkdtemp(join(tmpdir(), "co-worker-legacy-mount-"));
  await mkdir(root, { recursive: true });
  const status = await detectWorkerMountHealth({
    DSM_MOUNT_ROOT: "/volume1/PCNgon",
    DSM_LEGACY_MOUNT_ROOT: root,
  });
  assert.equal(status.dsmMountRoot, root);
  assert.equal(status.mountReady, true);
  assert.match(status.mountError, /fallback|dsmmountroot|\/nas|luu lai/i);
});

test("ensureWorkerMountReady throws the same mount diagnostic when NAS mount is missing", async () => {
  const missing = join(tmpdir(), "co-worker-mount-missing-" + Date.now());
  await assert.rejects(
    () => ensureWorkerMountReady({ DSM_MOUNT_ROOT: missing }),
    /chưa thấy DSM mount root|khong thay DSM mount root/i,
  );
});

test("worker startup is strict about NAS mount by default but can be relaxed explicitly", () => {
  assert.equal(shouldFailWorkerStartup({}), true);
  assert.equal(shouldFailWorkerStartup({ WORKER_STRICT_NAS_MOUNT: "1" }), true);
  assert.equal(shouldFailWorkerStartup({ WORKER_STRICT_NAS_MOUNT: "0" }), false);
});

test("reportWorkerBootstrapFailure writes a failed mount heartbeat row", async () => {
  const missing = join(tmpdir(), "co-worker-bootstrap-missing-" + Date.now());
  const calls = [];
  const fakePool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  const status = await reportWorkerBootstrapFailure(fakePool, {
    env: { DSM_MOUNT_ROOT: missing, APP_DATA_DIR: "/data" },
    workerId: "boot-worker-1",
    hostname: "nas-box",
    pid: 1234,
  });
  assert.equal(status.mountReady, false);
  assert.match(status.mountError, /chưa thấy DSM mount root|khong thay DSM mount root/i);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO worker_runtime_status/i);
  assert.equal(calls[0].params[0], "boot-worker-1");
  assert.equal(calls[0].params[7], 0);
});

test("createWorkerRuntimeReporter writes heartbeat rows to sqlite with only primitive bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "co-worker-runtime-sqlite-"));
  const appDataDir = join(root, "data");
  const mountRoot = join(root, "nas");
  const dbPath = join(appDataDir, "coopeditor.db");
  await mkdir(appDataDir, { recursive: true });
  await mkdir(mountRoot, { recursive: true });

  const env = {
    DATABASE_URL: "sqlite:" + dbPath,
    APP_DATA_DIR: appDataDir,
    DSM_MOUNT_ROOT: mountRoot,
  };
  await spawnAndWait(migrateEntry, env);

  const dbMod = await import("../../api/src/db.js");
  try {
    Object.assign(process.env, env);
    await dbMod.initDb();
    const reporter = createWorkerRuntimeReporter(dbMod.db(), {
      env,
      workerId: "sqlite-worker-1",
      hostname: { host: "nnas" },
      pid: "6028",
      mode: "ffmpeg-only",
      hwaccel: "",
      codecLadder: ["h264"],
      appDataDir: { dir: appDataDir },
    });
    const status = await reporter.reportOnce();
    assert.equal(status.mountReady, true);

    const rows = (await dbMod.db().query(
      `SELECT worker_id, hostname, pid, mode, hwaccel, codec_ladder, dsm_mount_root, mount_ready, app_data_dir
         FROM worker_runtime_status
        WHERE worker_id = $1`,
      ["sqlite-worker-1"],
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].worker_id, "sqlite-worker-1");
    assert.equal(rows[0].pid, 6028);
    assert.equal(rows[0].mode, "ffmpeg-only");
    assert.equal(rows[0].codec_ladder, "[\"h264\"]");
    assert.equal(rows[0].mount_ready, 1);
  } finally {
    await dbMod.close();
    for (const key of Object.keys(env)) delete process.env[key];
  }
});
