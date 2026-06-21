import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectWorkerMountHealth, ensureWorkerMountReady, reportWorkerBootstrapFailure, shouldFailWorkerStartup } from "../src/runtime-status.js";

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
  assert.equal(calls[0].params[7], false);
});
