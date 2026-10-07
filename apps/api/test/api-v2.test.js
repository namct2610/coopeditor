// Endpoints added for the v2 UI: video review status, the "Chờ bạn review"
// queue, per-account UI prefs, workspace roles and proxy settings.
// Memory store + dev-DSM, same harness as api.test.js on its own port.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PORT = 4398;
const BASE = "http://localhost:" + PORT;
let proc;

let cookie = "";
async function http(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (cookie) headers["cookie"] = cookie;
  const r = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const login = (account) => http("/auth/dsm/login", { method: "POST", body: { account, passwd: "x" } });

before(async () => {
  const appDataDir = await mkdtemp(join(tmpdir(), "coopeditor-api-v2-"));
  proc = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), APP_DATA_DIR: appDataDir, DSM_DEV_LOGIN: "1", ALLOWED_ORIGINS: "http://localhost:3000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write("[api!] " + d));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch (_) {}
    await wait(100);
  }
  assert.equal((await login("minh")).status, 200);
});
after(() => { proc && proc.kill(); });

test("/me carries prefs and capability flags; prefs are validated and merged", async () => {
  const me = await http("/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.user.prefs, {});
  assert.equal(me.json.canManageWorkspace, true);
  assert.equal(me.json.canBrowseNas, true);

  let r = await http("/me/prefs", { method: "PATCH", body: { theme: "light", hue: 45, defaultView: "list" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.prefs, { theme: "light", hue: 45, defaultView: "list" });
  r = await http("/me/prefs", { method: "PATCH", body: { theme: "neon", hue: 999, defaultView: "grid" } });
  assert.deepEqual(r.json.prefs, { theme: "light", hue: 45, defaultView: "grid" }, "bad values are ignored, good ones merge");
  assert.equal((await http("/me")).json.user.prefs.defaultView, "grid");
});

test("projects carry review status mix, open notes, air dates and size", async () => {
  const list = (await http("/projects")).json;
  const p1 = list.find((p) => p.id === "p1");
  assert.ok(p1);
  const mixTotal = Object.values(p1.statusMix).reduce((a, b) => a + b, 0);
  assert.equal(mixTotal, p1.sourcesCount);
  assert.ok(["edit", "wait", "fix", "ok", "air"].includes(p1.reviewStatus));
  assert.ok(p1.openCommentsCount >= 1, "p1s1 has seeded unresolved comments");
  assert.ok(Array.isArray(p1.airDates));
  assert.match(p1.totalSizeLabel, /GB|TB|MB/);
});

test("video review status: validated, recorded with author, feeds the review queue", async () => {
  let r = await http("/assets/p1s2", { method: "PATCH", body: { reviewStatus: "nope" } });
  assert.equal(r.status, 400);

  r = await http("/assets/p1s2", { method: "PATCH", body: { reviewStatus: "wait", reviewStatusBy: "u_khach" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.reviewStatus, "wait");
  assert.notEqual(r.json.reviewStatusBy, "u_khach", "author comes from the session, not the body");
  assert.ok(r.json.reviewStatusAt);

  const q = await http("/review-queue");
  assert.equal(q.status, 200);
  const item = q.json.find((x) => x.assetId === "p1s2");
  assert.ok(item, "queued video appears");
  assert.equal(item.projectId, "p1");
  assert.equal(item.sentBy, "minh");
  assert.equal(q.json[0].assetId, "p1s2", "most recently sent first");

  r = await http("/assets/p1s2", { method: "PATCH", body: { reviewStatus: "ok" } });
  assert.equal(r.status, 200);
  assert.ok(!(await http("/review-queue")).json.some((x) => x.assetId === "p1s2"));
});

test("workspace members: roles across owned projects, bulk role change", async () => {
  const r = await http("/workspace/members");
  assert.equal(r.status, 200);
  assert.ok(r.json.ownedProjects >= 1);
  const lan = r.json.members.find((m) => m.user.id === "u_lan");
  assert.ok(lan && lan.projects >= 1);

  assert.equal((await http("/workspace/members/u_lan", { method: "PATCH", body: { role: "owner" } })).status, 400);
  const ch = await http("/workspace/members/u_lan", { method: "PATCH", body: { role: "reviewer" } });
  assert.equal(ch.status, 200);
  assert.ok(ch.json.changed >= 1);
  const after = (await http("/workspace/members")).json.members.find((m) => m.user.id === "u_lan");
  assert.equal(after.role, "reviewer");
  assert.equal(after.mixed, false);
  // put it back for later tests
  await http("/workspace/members/u_lan", { method: "PATCH", body: { role: "editor" } });
});

test("proxy settings: read, validate and apply in-process without runtime config", async () => {
  let r = await http("/admin/proxy-settings");
  assert.equal(r.status, 200);
  assert.equal(r.json.hlsSegmentSeconds, 4);
  assert.deepEqual(r.json.autoRungs, []);
  r = await http("/admin/proxy-settings", { method: "PATCH", body: { hlsSegmentSeconds: 6, autoRungs: [1080, 540, 720, 720] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.hlsSegmentSeconds, 6);
  assert.deepEqual(r.json.autoRungs, [720, 1080]);
  assert.equal(r.json.persisted, false);
});

test("transcode queue lists running renditions", async () => {
  const r = await http("/transcode-queue");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
});

test("scripts list carries plain-text preview lines for the page thumbnail", async () => {
  const s = (await http("/scripts", { method: "POST", body: { title: "Preview" } })).json;
  const saved = await http("/scripts/" + s.id, { method: "PATCH", body: { baseVersion: s.version, body: "<h2>Bếp, ban ngày</h2><p>Ánh nắng &amp; tiếng nước</p><blockquote><p>Mỗi sớm mai</p></blockquote><p></p>" } });
  assert.equal(saved.status, 200);
  const row = (await http("/scripts")).json.find((x) => x.id === s.id);
  assert.deepEqual(row.previewLines, ["Bếp, ban ngày", "Ánh nắng & tiếng nước", "Mỗi sớm mai"]);
  assert.equal(row.excerpt, undefined, "raw HTML stays server-side");
});

test("filmstrip frame endpoint is access-checked and 404s without a source", async () => {
  assert.equal((await http("/assets/nope/frame?i=0&n=18")).status, 404);
  const r = await http("/assets/p1s1/frame?i=3&n=18");
  assert.equal(r.status, 404, "demo NAS path does not exist in tests");
});

test("sketch: images upload + serve with sniffed type, comment sketch can be edited", async () => {
  const vs = (await http("/assets/p1s1/versions")).json;
  const vid = vs[vs.length - 1].id;
  // 1×1 transparent PNG
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  let r = await http("/asset-versions/" + vid + "/annotation-images", { method: "POST", body: { dataUrl: "data:image/png;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64") } });
  assert.equal(r.status, 400, "non-image bytes are refused whatever the declared type");
  r = await http("/asset-versions/" + vid + "/annotation-images", { method: "POST", body: { dataUrl: "data:image/webp;base64," + png } });
  assert.equal(r.status, 201);
  assert.match(r.json.id, /^[a-f0-9]{24}\.png$/, "extension comes from the bytes");
  const img = await fetch(BASE + "/asset-versions/" + vid + "/annotation-images/" + r.json.id, { headers: { cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await fetch(BASE + "/asset-versions/" + vid + "/annotation-images/..%2F..%2Fx.png", { headers: { cookie } })).status, 404);

  const annotation = { items: [
    { id: "t1", type: "text", x: 0.1, y: 0.8, text: "Phụ đề", style: "box" },
    { id: "m1", type: "image", x: 0.7, y: 0.05, w: 0.2, h: 0.1, src: r.json.id },
  ] };
  const c = (await http("/asset-versions/" + vid + "/comments", { method: "POST", body: { content: "logo góc phải", timestampMs: 1000, annotation } })).json;
  assert.equal(c.annotation.items.length, 2);
  r = await http("/comments/" + c.id, { method: "PATCH", body: { annotation: { items: [annotation.items[0]] } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.annotation.items.map((i) => i.id), ["t1"]);
  assert.equal((await http("/comments/" + c.id, { method: "PATCH", body: { annotation: { items: [{ type: "nope" }] } } })).status, 400);
  r = await http("/comments/" + c.id, { method: "PATCH", body: { annotation: null } });
  assert.equal(r.json.annotation, null);
});

test("non-owners cannot change workspace roles or proxy settings", async () => {
  assert.equal((await login("khach")).status, 200);
  assert.equal((await http("/workspace/members/u_lan", { method: "PATCH", body: { role: "client" } })).status, 403);
  assert.equal((await http("/admin/proxy-settings", { method: "PATCH", body: { hlsSegmentSeconds: 4 } })).status, 403);
});
