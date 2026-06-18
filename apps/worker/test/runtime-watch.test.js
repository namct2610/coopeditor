import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeConfigWatcher } from "../src/runtime-watch.js";

test("runtime config watcher fires once when fingerprint changes", async () => {
  const seen = [];
  let fingerprint = "a";
  const watcher = createRuntimeConfigWatcher({
    readFingerprint: async () => fingerprint,
    onChange: async (payload) => { seen.push(payload); },
  });

  await watcher.prime();
  assert.equal(await watcher.check(), false);

  fingerprint = "b";
  assert.equal(await watcher.check(), true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { previousFingerprint: "a", nextFingerprint: "b" });

  assert.equal(await watcher.check(), false);
  assert.equal(seen.length, 1);
});
