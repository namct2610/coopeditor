import test from "node:test";
import assert from "node:assert/strict";

test("DSM path helpers normalize stored paths and rebuild local mount path", async () => {
  process.env.DSM_MOUNT_ROOT = "/nas";
  const mod = await import("../src/dsm.js?case=mount-root");

  assert.equal(mod.normalizeStoredNasPath("/nas/502. Case G200/C1967.MP4"), "/502. Case G200/C1967.MP4");
  assert.equal(mod.normalizeStoredNasPath("/volume1/PCNgon/502. Case G200/C1967.MP4"), "/502. Case G200/C1967.MP4");
  assert.equal(mod.normalizeStoredNasPath("502. Case G200/C1967.MP4"), "/502. Case G200/C1967.MP4");
  assert.equal(mod.resolveSourcePath("/nas/502. Case G200/C1967.MP4"), "/nas/502. Case G200/C1967.MP4");
  assert.equal(mod.resolveSourcePath("/volume1/PCNgon/502. Case G200/C1967.MP4"), "/nas/502. Case G200/C1967.MP4");
  assert.equal(mod.resolveSourcePath("/502. Case G200/C1967.MP4"), "/nas/502. Case G200/C1967.MP4");
});

test("DSM path helpers preserve legacy /nas paths even after mount root changes", async () => {
  process.env.DSM_MOUNT_ROOT = "/mnt/pcngon";
  const mod = await import("../src/dsm.js?case=legacy-nas-root");

  assert.equal(mod.normalizeStoredNasPath("/nas/502. Case G200/C1967.MP4"), "/502. Case G200/C1967.MP4");
  assert.equal(mod.resolveSourcePath("/nas/502. Case G200/C1967.MP4"), "/mnt/pcngon/502. Case G200/C1967.MP4");
  assert.equal(mod.normalizeStoredNasPath("/volume1/PCNgon"), "/");
});

test("DSM path helpers reject traversal segments", async () => {
  process.env.DSM_MOUNT_ROOT = "/nas";
  const mod = await import("../src/dsm.js?case=reject-traversal");

  assert.throws(() => mod.normalizeStoredNasPath("/../../etc/passwd"), /Duong dan NAS khong hop le/);
  assert.throws(() => mod.normalizeStoredNasPath("/Folder/../clip.mp4"), /Duong dan NAS khong hop le/);
  assert.throws(() => mod.resolveSourcePath("/Folder/../clip.mp4"), /Duong dan NAS khong hop le/);
});

test("DSM path helpers follow mount root changes after module load", async () => {
  process.env.DSM_MOUNT_ROOT = "/nas";
  const mod = await import("../src/dsm.js?case=live-env");

  assert.equal(mod.resolveSourcePath("/Clip/C001.MP4"), "/nas/Clip/C001.MP4");
  process.env.DSM_MOUNT_ROOT = "/mnt/pcngon";
  assert.equal(mod.resolveSourcePath("/Clip/C001.MP4"), "/mnt/pcngon/Clip/C001.MP4");
});
