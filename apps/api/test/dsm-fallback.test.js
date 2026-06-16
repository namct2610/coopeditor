import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("dsmListFolder falls back to mounted NAS when FileStation list_share fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-"));
  await mkdir(join(root, "Projects"));
  await writeFile(join(root, "clip.mov"), "demo");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?fallback=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.equal(listing.path, "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "Projects"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "clip.mov"));
  } finally {
    global.fetch = originalFetch;
  }
});
