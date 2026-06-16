import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

// Opt out with PG_MODE_TESTS=0 when CI runs limited environments; otherwise we
// try testcontainers and skip gracefully if Docker isn't available locally.
const OPT_OUT = process.env.PG_MODE_TESTS === "0";

test("pg mode persists sessions across API restart", { skip: OPT_OUT }, async (t) => {
  let GenericContainer;
  try {
    ({ GenericContainer } = await import("testcontainers"));
  } catch {
    t.skip("testcontainers is not installed");
    return;
  }

  let container;
  try {
    container = await new GenericContainer("postgres:16")
      .withEnvironment({
        POSTGRES_DB: "coopeditor_test",
        POSTGRES_USER: "frame",
        POSTGRES_PASSWORD: "frame",
      })
      .withExposedPorts(5432)
      .start();
  } catch (err) {
    if (/container runtime strategy/i.test(String(err && err.message || err))) {
      t.skip("No working Docker/Testcontainers runtime available on this machine");
      return;
    }
    throw err;
  }
  t.after(async () => {
    await container.stop();
  });

  const env = {
    ...process.env,
    DATABASE_URL: `postgres://frame:frame@${container.getHost()}:${container.getMappedPort(5432)}/coopeditor_test`,
    DSM_DEV_LOGIN: "1",
    ALLOWED_ORIGINS: "http://localhost:3000",
    PORT: "4499",
  };

  const migrate = spawn(process.execPath, [fileURLToPath(new URL("../src/migrate.js", import.meta.url))], { env, stdio: "inherit" });
  const migrateExit = await new Promise((resolve) => migrate.on("exit", resolve));
  assert.equal(migrateExit, 0);

  const startApi = () => spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let proc = startApi();
  t.after(() => proc.kill());

  const base = "http://127.0.0.1:4499";
  const waitReady = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(base + "/health");
        if (r.ok) return;
      } catch {}
      await wait(100);
    }
    throw new Error("API never came up");
  };

  await waitReady();
  const login = await fetch(base + "/auth/dsm/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "minh", passwd: "x" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  proc.kill();
  await wait(600);
  proc = startApi();
  await waitReady();

  const me = await fetch(base + "/me", { headers: { cookie } });
  assert.equal(me.status, 200);
  const json = await me.json();
  assert.equal(json.user.id, "u_minh");
});
