import test from "node:test";
import assert from "node:assert/strict";

import {
  createClusterEnvelope,
  parseClusterEnvelope,
  parseRedisStreamRows,
  resolveEventBusDriver,
} from "../../../packages/contracts/src/event-bus.js";

test("resolveEventBusDriver prefers redis when REDIS_URL is present", () => {
  assert.equal(resolveEventBusDriver({ REDIS_URL: "redis://127.0.0.1:6379" }), "redis-streams");
  assert.equal(resolveEventBusDriver({ DATABASE_URL: "postgres://example" }), "pg");
  assert.equal(resolveEventBusDriver({ EVENT_BUS_DRIVER: "none", DATABASE_URL: "postgres://example" }), "none");
});

test("resolveEventBusDriver forces sqlite runtimes to local-only even if stale pg env is present", () => {
  assert.equal(resolveEventBusDriver({
    DATABASE_URL: "sqlite:/var/packages/coopeditor/var/coopeditor.db",
    EVENT_BUS_DRIVER: "pg",
  }), "none");
  assert.equal(resolveEventBusDriver({
    DATABASE_URL: "file:/tmp/coopeditor.db",
    EVENT_BUS_DRIVER: "postgres",
  }), "none");
});

test("cluster envelopes round-trip safely", () => {
  const envelope = createClusterEnvelope({ type: "comment", action: "created" }, "api-a");
  const parsed = parseClusterEnvelope(JSON.stringify(envelope));
  assert.equal(parsed.sourceNodeId, "api-a");
  assert.equal(parsed.event.type, "comment");
});

test("parseRedisStreamRows extracts ids and payload fields", () => {
  const rows = parseRedisStreamRows([
    ["coopeditor_events", [
      ["1710000000000-0", ["payload", "{\"type\":\"presence\"}"]],
    ]],
  ]);
  assert.deepEqual(rows, [
    { id: "1710000000000-0", fields: { payload: "{\"type\":\"presence\"}" } },
  ]);
});
