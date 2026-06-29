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

test("summarizeTranscodeWorkers uses SPK-specific wording when worker is inline", () => {
  const summary = summarizeTranscodeWorkers([], {
    spkRuntime: true,
    apiMount: {
      mountReady: true,
      dsmMountRoot: "/volume1/PCNgon",
      mountError: "",
    },
    runtimeConfigPresent: true,
  });
  assert.equal(summary.status, "offline");
  assert.match(summary.message, /package Coopeditor|worker inline/i);
  assert.doesNotMatch(summary.message, /coopeditor-worker chưa được recreate/i);
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

test("summarizeTranscodeWorkers explains offline worker when API mount is ready", () => {
  const summary = summarizeTranscodeWorkers([], {
    apiMount: {
      mountReady: true,
      dsmMountRoot: "/nas",
      mountError: "",
    },
    runtimeConfigPresent: true,
    latestMountFailure: {
      error: "Source path not mounted in worker: /nas/502. Case G200/C1967.MP4",
    },
  });
  assert.equal(summary.status, "offline");
  assert.match(summary.message, /API đang thấy DSM mount root \/nas/i);
  assert.match(summary.message, /app-data volume vào \/data|runtime config/i);
  assert.match(summary.message, /Source path not mounted in worker/i);
  assert.equal(summary.diagnostics.apiMount.mountReady, true);
});
