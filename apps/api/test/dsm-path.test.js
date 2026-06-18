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
