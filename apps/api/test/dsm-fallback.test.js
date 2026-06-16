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

test("mounted NAS listing hides non-video files and system folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-filter-"));
  await mkdir(join(root, "@eaDir"));
  await mkdir(join(root, "Clips"));
  await writeFile(join(root, "clip.mp4"), "demo");
  await writeFile(join(root, "notes.odoc"), "doc");
  await writeFile(join(root, "cover.jpg"), "img");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?filter=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "Clips"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "clip.mp4"));
    assert.ok(!listing.entries.some((entry) => entry.name === "notes.odoc"));
    assert.ok(!listing.entries.some((entry) => entry.name === "cover.jpg"));
    assert.ok(!listing.entries.some((entry) => entry.name === "@eaDir"));
  } finally {
    global.fetch = originalFetch;
  }
});
