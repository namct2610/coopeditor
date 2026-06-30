import test from "node:test";
import assert from "node:assert/strict";

import { summarizeTranscodeWorkers, normalizeDbTimestamp } from "../src/transcode-runtime-status.js";

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

test("summarizeTranscodeWorkers prioritizes API mount permission errors on SPK", () => {
  const summary = summarizeTranscodeWorkers([], {
    spkRuntime: true,
    apiMount: {
      mountReady: false,
      dsmMountRoot: "/volume1/PCNgon",
      mountError: "API không đủ quyền đọc DSM mount root /volume1/PCNgon.",
    },
    runtimeConfigPresent: true,
  });
  assert.equal(summary.status, "mount-error");
  assert.match(summary.message, /không đủ quyền đọc DSM mount root/i);
  assert.match(summary.message, /package user `coopeditor`/i);
  assert.doesNotMatch(summary.message, /worker inline trong package Coopeditor chưa khởi động được/i);
});

test("summarizeTranscodeWorkers surfaces stale worker mount errors before generic heartbeat wording", () => {
  const summary = summarizeTranscodeWorkers([{
    workerId: "w-stale",
    stale: true,
    mountReady: false,
    mountError: "Worker không đủ quyền đọc DSM mount root /volume1/PCNgon.",
    dsmMountRoot: "/volume1/PCNgon",
  }], {
    spkRuntime: true,
    runtimeConfigPresent: true,
  });
  assert.equal(summary.status, "mount-error");
  assert.match(summary.message, /Worker không đủ quyền đọc DSM mount root/i);
  assert.match(summary.message, /heartbeat worker cũ/i);
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

test("summarizeTranscodeWorkers marks sim-only worker as not transcode-ready on SPK", () => {
  const summary = summarizeTranscodeWorkers([{
    workerId: "w-sim",
    stale: false,
    mountReady: true,
    mountError: "",
    mode: "sim",
    dsmMountRoot: "/volume1/PCNgon",
  }], {
    spkRuntime: true,
  });
  assert.equal(summary.status, "sim");
  assert.equal(summary.canTranscode, false);
  assert.equal(summary.spkRuntime, true);
  assert.match(summary.message, /mô phỏng|FFmpeg/i);
});

test("normalizeDbTimestamp treats sqlite timestamps as UTC instead of local time", () => {
  assert.equal(
    normalizeDbTimestamp("2026-06-30 10:18:05"),
    "2026-06-30T10:18:05Z",
  );
  assert.equal(
    normalizeDbTimestamp("2026-06-30T10:18:05.000Z"),
    "2026-06-30T10:18:05.000Z",
  );
});
