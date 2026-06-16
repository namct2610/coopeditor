import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("applyRuntimeEnvFromConfig preserves updater defaults from env for old config files", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-config-"));
  const configPath = join(root, "system", "config.json");
  await mkdir(join(root, "system"), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    publicUrl: "https://review.example.com",
    dsmHost: "https://nas.example.com:5001",
    dsmMountRoot: "/nas",
    dsmDevLogin: false,
    dsmInsecure: false,
    scheme: "https",
  }), "utf8");

  process.env.APP_DATA_DIR = root;
  process.env.APP_CONFIG_PATH = configPath;
  process.env.UPDATE_FEED_URL = "https://raw.githubusercontent.com/namct2610/coopeditor/main/release.json";
  process.env.UPDATE_TRIGGER_URL = "http://watchtower:8080/v1/update";
  process.env.UPDATE_TRIGGER_TOKEN = "token-demo";

  const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/runtime-config.js")).href + "?runtime=" + Date.now());
  const cfg = mod.readRuntimeConfig();
  assert.equal(!!cfg, true);
  mod.applyRuntimeEnvFromConfig(cfg);

  assert.equal(process.env.UPDATE_FEED_URL, "https://raw.githubusercontent.com/namct2610/coopeditor/main/release.json");
  assert.equal(process.env.UPDATE_TRIGGER_URL, "http://watchtower:8080/v1/update");
  assert.equal(process.env.UPDATE_TRIGGER_TOKEN, "token-demo");
});

test("publicRuntimeSummary exposes default updater feed for legacy config", async () => {
  const root = await mkdtemp(join(tmpdir(), "coopeditor-config-summary-"));
  const configPath = join(root, "system", "config.json");
  await mkdir(join(root, "system"), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    publicUrl: "https://review.example.com",
    dsmHost: "https://nas.example.com:5001",
    dsmMountRoot: "/nas",
    dsmDevLogin: false,
    dsmInsecure: false,
    scheme: "https",
  }), "utf8");

  process.env.APP_DATA_DIR = root;
  process.env.APP_CONFIG_PATH = configPath;
  process.env.UPDATE_FEED_URL = "";
  process.env.UPDATE_TRIGGER_URL = "";

  const mod = await import(pathToFileURL(join(process.cwd(), "apps/api/src/runtime-config.js")).href + "?summary=" + Date.now());
  const summary = mod.publicRuntimeSummary();
  assert.equal(summary.updater.feedUrl, "https://raw.githubusercontent.com/namct2610/coopeditor/main/release.json");
  assert.equal(summary.updater.triggerUrl, "http://watchtower:8080/v1/update");
});
