import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

// Opt out with REDIS_MODE_TESTS=0 in CI without Docker; otherwise testcontainers
// is used and the test skips gracefully when no runtime is available.
const OPT_OUT = process.env.REDIS_MODE_TESTS === "0";

async function waitReady(base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error("API never came up at " + base);
}

async function login(base, account) {
  const res = await fetch(base + "/auth/dsm/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, passwd: "x" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

test("redis-streams propagates comment SSE across API instances", { skip: OPT_OUT }, async (t) => {
  let GenericContainer;
  try {
    ({ GenericContainer } = await import("testcontainers"));
  } catch {
    t.skip("testcontainers is not installed");
    return;
  }

  let redis;
  try {
    redis = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .start();
  } catch (err) {
    if (/container runtime strategy/i.test(String(err && err.message || err))) {
      t.skip("No working Docker/Testcontainers runtime available on this machine");
      return;
    }
    throw err;
  }
  t.after(async () => {
    await redis.stop();
  });

  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
  const makeEnv = (port, nodeId) => ({
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DSM_DEV_LOGIN: "1",
    ALLOWED_ORIGINS: "http://localhost:3000",
    EVENT_BUS_DRIVER: "redis-streams",
    EVENT_BUS_NODE_ID: nodeId,
    EVENT_BUS_STREAM_KEY: "coopeditor_test_events",
    REDIS_URL: redisUrl,
  });
  const startApi = (port, nodeId) => spawn(process.execPath, [serverPath], {
    env: makeEnv(port, nodeId),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const procA = startApi(4591, "api-a");
  const procB = startApi(4592, "api-b");
  t.after(() => { procA.kill(); procB.kill(); });

  await waitReady("http://127.0.0.1:4591");
  await waitReady("http://127.0.0.1:4592");

  const cookieA = await login("http://127.0.0.1:4591", "minh");
  const cookieB = await login("http://127.0.0.1:4592", "lan");

  const events = [];
  const ctrl = new AbortController();
  const streamTask = (async () => {
    const res = await fetch("http://127.0.0.1:4592/events", {
      headers: { cookie: cookieB },
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const chunk of parts) {
        if (!chunk.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(chunk.slice(6));
          events.push(event);
          if (event.type === "comment" && event.action === "created") return;
        } catch {}
      }
    }
  })();

  await wait(250);
  const post = await fetch("http://127.0.0.1:4591/asset-versions/p1s1_v3/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieA,
    },
    body: JSON.stringify({ content: "redis cross-node comment", timestampMs: 4567 }),
  });
  assert.equal(post.status, 201);

  await Promise.race([
    streamTask,
    wait(5000).then(() => { throw new Error("Timed out waiting for redis-streams SSE propagation"); }),
  ]);
  ctrl.abort();

  assert.ok(events.some((event) => event.type === "comment" && event.action === "created" && event.comment && event.comment.content === "redis cross-node comment"));
});
