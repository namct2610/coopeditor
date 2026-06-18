import test from "node:test";
import assert from "node:assert/strict";

import { buildProxyStorageReport } from "../src/proxy-storage.js";

test("buildProxyStorageReport keeps orphan bytes in totals", () => {
  const report = buildProxyStorageReport(
    [
      { key: "r1/master.m3u8", size: 100 },
      { key: "r1/seg-0001.ts", size: 300 },
      { key: "ghost/master.m3u8", size: 50 },
      { key: "ghost/seg-0001.ts", size: 150 },
    ],
    [
      {
        renditionId: "r1",
        orphan: false,
        label: "720p",
        status: "ready",
        assetId: "a1",
        assetTitle: "Clip 01",
        projectId: "p1",
        projectName: "Project 01",
      },
    ],
  );

  assert.equal(report.totalBytes, 600);
  assert.equal(report.orphanBytes, 200);
  assert.equal(report.orphanCount, 1);
  assert.equal(report.renditions.length, 2);
  assert.equal(report.renditions[0].renditionId, "r1");
  assert.equal(report.renditions[0].bytes, 400);
  assert.equal(report.renditions[0].fileCount, 2);
  assert.equal(report.renditions[1].renditionId, "ghost");
  assert.equal(report.renditions[1].orphan, true);
  assert.equal(report.renditions[1].bytes, 200);
  assert.equal(report.renditions[1].fileCount, 2);
  assert.equal(report.renditions[1].status, "orphan");
});
