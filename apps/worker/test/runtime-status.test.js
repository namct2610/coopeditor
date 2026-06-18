import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectWorkerMountHealth } from "../src/runtime-status.js";

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
