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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PORT = 4398;
const BASE = "http://localhost:" + PORT;
let proc;
let appDataDir = "";

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
  appDataDir = await mkdtemp(join(tmpdir(), "coopeditor-api-v2-"));
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

test("projects carry their status, open notes, air dates and size", async () => {
  const list = (await http("/projects")).json;
  const p1 = list.find((p) => p.id === "p1");
  assert.ok(p1);
  assert.equal(p1.statusMix, undefined, "no per-video status any more");
  assert.equal(p1.reviewStatus, "edit", "no final yet → Đang dựng");
  assert.equal(p1.final, null);
  assert.ok(p1.openCommentsCount >= 1, "p1s1 has seeded unresolved comments");
  assert.ok(Array.isArray(p1.airDates));
  assert.match(p1.totalSizeLabel, /GB|TB|MB/);
});

test("source videos have no status of their own; the review queue holds finals only", async () => {
  const r = await http("/assets/p1s2", { method: "PATCH", body: { reviewStatus: "wait" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /dự án/);
  assert.equal((await http("/assets/p1s2", { method: "PATCH", body: { reviewStatus: "nope" } })).status, 400);
  assert.ok((await http("/review-queue")).json.every((x) => x.kind === "final"), "seeded per-video 'wait' sources stay out of the queue");
  assert.equal((await http("/assets/p1s2", { method: "PATCH", body: { title: "Glass_Filling_CU" } })).status, 200, "other edits still work");
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

test("scripts: images in the text upload + serve, go away with the script, clients can't read them", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const s = (await http("/scripts", { method: "POST", body: { title: "Storyboard" } })).json;
  let r = await http("/scripts/" + s.id + "/images", { method: "POST", body: { dataUrl: "data:image/png;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64") } });
  assert.equal(r.status, 400, "non-image bytes are refused");
  r = await http("/scripts/" + s.id + "/images", { method: "POST", body: { dataUrl: "data:image/png;base64," + png } });
  assert.equal(r.status, 201);
  assert.match(r.json.id, /^[a-f0-9]{24}\.png$/);
  const url = BASE + "/scripts/" + s.id + "/images/" + r.json.id;
  let img = await fetch(url, { headers: { cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await fetch(BASE + "/scripts/" + s.id + "/images/..%2F..%2Fx.png", { headers: { cookie } })).status, 404);
  assert.equal((await http("/scripts/nope/images", { method: "POST", body: { dataUrl: "data:image/png;base64," + png } })).status, 404);
  assert.equal((await fetch(url)).status, 401, "needs a session");

  const own = cookie;
  cookie = "";
  await login("client");
  assert.equal((await fetch(url, { headers: { cookie } })).status, 403, "clients can't use scripts");
  await http("/auth/logout", { method: "POST" });
  cookie = own;

  assert.equal((await http("/scripts/" + s.id, { method: "DELETE" })).status, 200);
  img = await fetch(url, { headers: { cookie } });
  assert.equal(img.status, 404);
  assert.equal(existsSync(join(appDataDir, "system", "script-images", s.id)), false, "files are deleted with the script");
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

test("final from NAS: waits for the owner, approval confirms the air date, a new round un-confirms it", async () => {
  assert.equal((await login("minh")).status, 200);
  let r = await http("/projects/p2/final", { method: "POST", body: { nasPath: "/Footage/TVC Q3 2026/Hero/Hero_take7.mov" } });
  assert.equal(r.status, 403, "minh is not a manager of p2");
  r = await http("/projects/p1/final", { method: "POST", body: { nasPath: "/Footage/TVC Q3 2026/Hero/Hero_take7.mov" } });
  assert.equal(r.status, 201);
  assert.equal(r.json.kind, "final");
  assert.equal(r.json.reviewStatus, "wait");
  const finalId = r.json.id;
  let p1 = (await http("/projects/p1")).json;
  assert.equal(p1.final.assetId, finalId);
  assert.equal(p1.final.round, 1);
  assert.equal(p1.reviewStatus, "wait", "the project now waits on its final (Chờ duyệt)");
  assert.equal(p1.airConfirmed, false);
  assert.ok((await http("/review-queue")).json.some((x) => x.assetId === finalId && x.kind === "final"));
  const cal0 = (await http("/projects/p1")).json;
  assert.equal(cal0.sourcesCount, (await http("/projects/p1/sources")).json.filter((a) => a.kind !== "final").length);

  // approve needs a date when none is planned … and only the owner may give it
  await http("/projects/p1", { method: "PATCH", body: { airDate: null } });
  assert.equal((await http("/projects/p1/final/approve", { method: "POST", body: {} })).status, 400);
  r = await http("/projects/p1/final/approve", { method: "POST", body: { airDate: "2026-11-20" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.final.reviewStatus, "ok");
  assert.equal(r.json.airDate, "2026-11-20");
  assert.equal(r.json.airConfirmed, true);
  assert.equal(r.json.reviewStatus, "ok", "future confirmed date → Đã duyệt");
  const past = await http("/projects/p1/final/approve", { method: "POST", body: { airDate: "2026-01-02" } });
  assert.equal(past.json.reviewStatus, "air", "approved and the confirmed date has come → Đã lên sóng");
  await http("/projects/p1/final/approve", { method: "POST", body: { airDate: "2026-11-20" } });
  const cal = (await http("/calendar?from=2026-11-01&to=2026-11-30")).json.find((x) => x.projectId === "p1");
  assert.equal(cal.confirmed, true);
  assert.equal(cal.finalStatus, "ok");

  r = await http("/projects/p1/final", { method: "POST", body: { nasPath: "/Footage/TVC Q3 2026/Hero/Hero_take8.mov" } });
  assert.equal(r.json.title, "Final v2");
  p1 = (await http("/projects/p1")).json;
  assert.equal(p1.final.round, 2);
  assert.equal(p1.airConfirmed, false, "a new delivery needs approving again");
  assert.equal(p1.airDate, "2026-11-20", "the planned date stays");
  r = await http("/projects/p1/final/reject", { method: "POST" });
  assert.equal(r.json.final.reviewStatus, "fix");

  // editors can't pass a verdict on a final through the generic status patch
  assert.equal((await login("lan")).status, 200);
  assert.equal((await http("/assets/" + p1.final.assetId, { method: "PATCH", body: { reviewStatus: "ok" } })).status, 403);
  assert.equal((await http("/projects/p1/final/approve", { method: "POST", body: { airDate: "2026-11-21" } })).status, 403);
  assert.equal((await http("/assets/" + p1.final.assetId, { method: "PATCH", body: { reviewStatus: "wait" } })).status, 200);
  assert.equal((await login("minh")).status, 200);
});

test("final upload: chunked, resumable, rejects wrong offsets and non-video files", async () => {
  const clip = join(appDataDir, "clip.mp4");
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-t", "2", "-pix_fmt", "yuv420p", clip]);
  } catch (_) { return; } // no ffmpeg on this machine
  const bytes = readFileSync(clip);
  assert.equal((await http("/projects/p1/final-uploads", { method: "POST", body: { name: "notes.txt", size: 10 } })).status, 400);
  const init = await http("/projects/p1/final-uploads", { method: "POST", body: { name: "Karofi_Final.mp4", size: bytes.length } });
  assert.equal(init.status, 201);
  const id = init.json.id;
  const chunk = (offset, buf) => fetch(BASE + "/final-uploads/" + id + "/chunk?offset=" + offset, { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: buf });
  const half = Math.floor(bytes.length / 2);
  assert.equal((await chunk(0, bytes.subarray(0, half))).status, 200);
  const stale = await chunk(0, bytes.subarray(0, half));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).offset, half, "server tells the client where to resume");
  assert.equal((await http("/final-uploads/" + id)).json.offset, half);
  assert.equal((await http("/final-uploads/" + id + "/complete", { method: "POST" })).status, 409, "incomplete");
  assert.equal((await chunk(half, Buffer.concat([bytes.subarray(half), Buffer.alloc(10)]))).status, 400, "past the declared size");
  assert.equal((await http("/final-uploads/" + id)).json.offset, half, "rolled back");
  assert.equal((await chunk(half, bytes.subarray(half))).status, 200);
  const done = await http("/final-uploads/" + id + "/complete", { method: "POST" });
  assert.equal(done.status, 201);
  assert.equal(done.json.asset.kind, "final");
  assert.equal(done.json.asset.reviewStatus, "wait");
  assert.ok(done.json.asset.durationMs >= 1900, "probed from the uploaded bytes");
  assert.equal((await http("/final-uploads/" + id)).status, 404, "session is gone");
  const src = await fetch(BASE + "/assets/" + done.json.asset.id + "/source", { headers: { cookie } });
  assert.equal(src.status, 200);
  assert.equal(Buffer.from(await src.arrayBuffer()).length, bytes.length);
});

test("non-owners cannot change workspace roles or proxy settings", async () => {
  assert.equal((await login("khach")).status, 200);
  assert.equal((await http("/workspace/members/u_lan", { method: "PATCH", body: { role: "client" } })).status, 403);
  assert.equal((await http("/admin/proxy-settings", { method: "PATCH", body: { hlsSegmentSeconds: 4 } })).status, 403);
});
