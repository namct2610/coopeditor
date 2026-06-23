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
  process.env.DSM_LIBRARY_ROOT = "/";
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
  process.env.DSM_LIBRARY_ROOT = "/";
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

test("dev login still prefers mounted NAS over demo tree when a real mount is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-dev-mount-"));
  await mkdir(join(root, "PCNgon"));
  await writeFile(join(root, "C1967.MP4"), "demo");

  process.env.DSM_HOST = "";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/";
  process.env.DSM_DEV_LOGIN = "1";

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?dev-mounted=" + Date.now());
    const listing = await mod.dsmListFolder("sid-dev", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "PCNgon"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "C1967.MP4"));
    assert.ok(!listing.entries.some((entry) => entry.name === "Footage"));
  } finally {
    process.env.DSM_DEV_LOGIN = "";
  }
});

test("mounted NAS listing can be rooted to a single shared folder via DSM library root", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-library-root-"));
  await mkdir(join(root, "PCNgon", "502. Case G200"), { recursive: true });
  await mkdir(join(root, "AnotherShare"), { recursive: true });
  await writeFile(join(root, "PCNgon", "C1967.MP4"), "demo");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/PCNgon";
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?library-root-listing=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "502. Case G200"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "C1967.MP4"));
    assert.ok(!listing.entries.some((entry) => entry.name === "PCNgon"));
    assert.ok(!listing.entries.some((entry) => entry.name === "AnotherShare"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("mounted NAS listing stays inside the shared folder when mount root already points directly to it", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-dsm-library-mounted-directly-"));
  await mkdir(join(root, "502. Case G200"), { recursive: true });
  await writeFile(join(root, "C1967.MP4"), "demo");

  process.env.DSM_HOST = "https://nas.example.com:5001";
  process.env.DSM_MOUNT_ROOT = root;
  process.env.DSM_LIBRARY_ROOT = "/PCNgon";
  process.env.DSM_DEV_LOGIN = "";

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: false, error: { code: 117 } }),
  });

  try {
    const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href + "?library-root-mounted-directly=" + Date.now());
    const listing = await mod.dsmListFolder("sid-demo", "/");
    assert.ok(listing.entries.some((entry) => entry.type === "folder" && entry.name === "502. Case G200"));
    assert.ok(listing.entries.some((entry) => entry.type === "file" && entry.name === "C1967.MP4"));
  } finally {
    global.fetch = originalFetch;
  }
});
