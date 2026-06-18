import test from "node:test";
import assert from "node:assert/strict";

import { summarizeTranscodeWorkers } from "../src/transcode-runtime-status.js";

test("summarizeTranscodeWorkers reports offline when no worker heartbeat exists", () => {
  const summary = summarizeTranscodeWorkers([]);
  assert.equal(summary.workerHeartbeatPresent, false);
  assert.equal(summary.activeWorkers, 0);
  assert.equal(summary.canTranscode, false);
  assert.equal(summary.status, "offline");
  assert.match(summary.message, /worker online|heartbeat|coopeditor-worker/i);
});

test("summarizeTranscodeWorkers reports warning when mount fallback is active", () => {
  const summary = summarizeTranscodeWorkers([{
    workerId: "w1",
    stale: false,
    mountReady: true,
    mountError: "Worker dang fallback tu DSM mount root cu /volume1/PCNgon sang /nas.",
  }]);
  assert.equal(summary.workerHeartbeatPresent, true);
  assert.equal(summary.activeWorkers, 1);
  assert.equal(summary.canTranscode, true);
  assert.equal(summary.status, "warning");
  assert.match(summary.message, /fallback|\/nas/i);
});
