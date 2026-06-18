// End-to-end smoke tests against the API in memory + dev-DSM mode.
// Run with: pnpm --filter @coopeditor/api test
// (requires Node 22+ for built-in node:test)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createSignedPlaybackToken } from "../src/hls-proxy.js";

const PORT = 4399;
const BASE = "http://localhost:" + PORT;
let proc;

async function waitReady(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch (_) {}
    await wait(100);
  }
  throw new Error("API never came up");
}

let cookie = "";
async function http(path, opts = {}) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (cookie) headers["cookie"] = cookie;
  const r = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
}

before(async () => {
  proc = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DSM_DEV_LOGIN: "1",
      ALLOWED_ORIGINS: "http://localhost:3000",
      HLS_CDN_PUBLIC_URL: "https://cdn.example.com/api/hls",
      HLS_CDN_SIGNING_SECRET: "test-hls-secret",
      HLS_CDN_TOKEN_TTL_SECONDS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stderr.write("[api] " + d));
  proc.stderr.on("data", (d) => process.stderr.write("[api!] " + d));
  await waitReady();
});
after(async () => { proc && proc.kill(); });

test("health reports memory backend", async () => {
  const r = await http("/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.backend, "memory");
  assert.ok(r.headers.get("x-request-id"));
});

test("CORS rejects unknown origin", async () => {
  const r = await fetch(BASE + "/projects", { headers: { origin: "http://evil.example.com" } });
  assert.equal(r.status, 403);
});

test("health includes strict CSP header", async () => {
  const r = await fetch(BASE + "/health");
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("x-request-id"));
  assert.equal(
    r.headers.get("content-security-policy"),
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'",
  );
});

test("/metrics exposes Prometheus counters and gauges", async () => {
  const r = await fetch(BASE + "/metrics");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /coopeditor_transcode_queue_depth \d+/);
  assert.match(text, /coopeditor_login_attempts_total \d+/);
  assert.match(text, /coopeditor_sse_subscribers \d+/);
});

test("unauth endpoints return 401", async () => {
  const r = await http("/me");
  assert.equal(r.status, 401);
});

test("DSM dev login + /me round trip", async () => {
  const r = await http("/auth/dsm/login", { method: "POST", body: { account: "minh", passwd: "x" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.name, "minh");
  const me = await http("/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.user.dsmUid > 0, true);
});

test("/version returns release metadata", async () => {
  const r = await http("/version");
  assert.equal(r.status, 200);
  assert.equal(r.json.version, "0.2.26");
  assert.equal(typeof r.json.summary, "string");
  assert.ok(Array.isArray(r.json.changes));
});

test("owner can read update status without feed", async () => {
  const r = await http("/admin/update-status");
  assert.equal(r.status, 200);
  assert.equal(r.json.local.version, "0.2.26");
  assert.equal(typeof r.json.checkAvailable, "boolean");
  assert.equal(r.json.triggerAvailable, false);
});

test("owner can read proxy storage status", async () => {
  const r = await http("/admin/proxy-storage");
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.backend, "string");
  assert.equal(typeof r.json.totalBytes, "number");
  assert.ok(Array.isArray(r.json.renditions));
});

test("authenticated user can read proxy storage summary", async () => {
  const r = await http("/proxy-storage-summary");
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.backend, "string");
  assert.equal(typeof r.json.totalBytes, "number");
  assert.equal(typeof r.json.renditionCount, "number");
  assert.ok(Array.isArray(r.json.renditions));
});

test("proxy storage endpoints accept refresh query", async () => {
  const summary = await http("/proxy-storage-summary?refresh=1");
  assert.equal(summary.status, 200);
  const full = await http("/admin/proxy-storage?refresh=1");
  assert.equal(full.status, 200);
});

test("authenticated user can read transcode runtime status", async () => {
  const r = await http("/transcode-runtime");
  assert.equal(r.status, 200);
  assert.equal(r.json.backend, "memory");
  assert.equal(typeof r.json.canTranscode, "boolean");
  assert.ok(Array.isArray(r.json.workers));
});

test("/projects decorates with team, sourcesCount, commentsCount", async () => {
  const r = await http("/projects");
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 6);
  const p1 = r.json.find((p) => p.id === "p1");
  assert.ok(p1.team.length >= 1);
  assert.equal(p1.sourcesCount, 8);
  assert.ok(p1.commentsCount > 0);
  assert.equal(p1.myRole, "owner");
});

test("project templates can be listed, created, and instantiated", async () => {
  const list = await http("/project-templates");
  assert.equal(list.status, 200);
  assert.ok(list.json.length >= 2);
  assert.ok(list.json.some((template) => template.id === "tpl_brand_tvc"));

  const createdTemplate = await http("/project-templates", {
    method: "POST",
    body: {
      name: "Social Cutdown",
      description: "Template tu project goc de bat dau nhanh hon.",
      sourceProjectId: "p1",
      defaultClient: "Karofi PH · Social",
    },
  });
  assert.equal(createdTemplate.status, 201);
  assert.equal(createdTemplate.json.name, "Social Cutdown");
  assert.equal(createdTemplate.json.sourceProjectId, "p1");

  const fromSource = await http(`/project-templates/${createdTemplate.json.id}/create`, {
    method: "POST",
    body: {
      name: "Social Cutdown - June Review",
      client: "Karofi PH · Growth",
    },
  });
  assert.equal(fromSource.status, 201);
  assert.equal(fromSource.json.name, "Social Cutdown - June Review");
  assert.equal(fromSource.json.client, "Karofi PH · Growth");
  assert.equal(fromSource.json.myRole, "owner");
  assert.deepEqual(
    fromSource.json.team.map((member) => member.id).sort(),
    ["u_lan", "u_minh", "u_tu"].sort(),
  );

  const blankTemplate = await http("/project-templates", {
    method: "POST",
    body: {
      name: "Blank Review Shell",
      description: "Khung project trong khong clone source.",
      defaultClient: "Internal",
    },
  });
  assert.equal(blankTemplate.status, 201);
  assert.equal(blankTemplate.json.sourceProjectId, null);

  const fromBlank = await http(`/project-templates/${blankTemplate.json.id}/create`, {
    method: "POST",
    body: {
      name: "Internal Review Pod",
    },
  });
  assert.equal(fromBlank.status, 201);
  assert.equal(fromBlank.json.name, "Internal Review Pod");
  assert.equal(fromBlank.json.client, "Internal");
  assert.equal(fromBlank.json.sourcesCount, 0);
  assert.equal(fromBlank.json.team.length, 1);
  assert.equal(fromBlank.json.team[0].id, "u_minh");
  assert.equal(fromBlank.json.myRole, "owner");
});

test("project members can be listed and invited", async () => {
  const before = await http("/projects/p1/members");
  assert.equal(before.status, 200);
  assert.equal(before.json.length, 3);

  const invited = await http("/projects/p1/members", { method: "POST", body: { userId: "u_phong", role: "reviewer" } });
  assert.equal(invited.status, 201);
  assert.equal(invited.json.role, "reviewer");

  const patched = await http("/projects/p1/members/u_phong", { method: "PATCH", body: { role: "client" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.role, "client");

  const removed = await http("/projects/p1/members/u_phong", { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.ok, true);
});

test("project access keeps at least one owner", async () => {
  const downgradeOnlyOwner = await http("/projects/p1/members/u_minh", { method: "PATCH", body: { role: "editor" } });
  assert.equal(downgradeOnlyOwner.status, 409);

  const removeOnlyOwner = await http("/projects/p1/members/u_minh", { method: "DELETE" });
  assert.equal(removeOnlyOwner.status, 409);

  const secondOwner = await http("/projects/p1/members", { method: "POST", body: { userId: "u_phong", role: "owner" } });
  assert.equal(secondOwner.status, 201);

  const downgradeFormerOnlyOwner = await http("/projects/p1/members/u_minh", { method: "PATCH", body: { role: "editor" } });
  assert.equal(downgradeFormerOnlyOwner.status, 200);
  assert.equal(downgradeFormerOnlyOwner.json.role, "editor");
});

test("only owner can manage project access", async () => {
  await http("/auth/logout", { method: "POST" });
  const loggedIn = await http("/auth/dsm/login", { method: "POST", body: { account: "lan", passwd: "x" } });
  assert.equal(loggedIn.status, 200);

  const invite = await http("/projects/p1/members", { method: "POST", body: { userId: "u_tu", role: "reviewer" } });
  assert.equal(invite.status, 403);

  const patchRole = await http("/projects/p1/members/u_phong", { method: "PATCH", body: { role: "client" } });
  assert.equal(patchRole.status, 403);

  const remove = await http("/projects/p1/members/u_phong", { method: "DELETE" });
  assert.equal(remove.status, 403);

  await http("/auth/logout", { method: "POST" });
  const ownerLogin = await http("/auth/dsm/login", { method: "POST", body: { account: "phong", passwd: "x" } });
  assert.equal(ownerLogin.status, 200);
});

test("PATCH project status moves it between groups", async () => {
  const r = await http("/projects/p1", { method: "PATCH", body: { status: "done" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "done");
  await http("/projects/p1", { method: "PATCH", body: { status: "progress" } });
});

test("reorder updates source positions", async () => {
  const initial = (await http("/projects/p1/sources")).json.map((s) => s.id);
  const reordered = [initial[1], initial[0], ...initial.slice(2)];
  const r = await http("/projects/p1/sources/reorder", { method: "PATCH", body: { orderedAssetIds: reordered } });
  assert.equal(r.status, 200);
  assert.equal(r.json[0].id, reordered[0]);
  assert.equal(r.json[0].position, 0);
});

test("comments: list + post + resolve", async () => {
  const before = (await http("/asset-versions/p1s1_v3/comments")).json;
  const baselineCount = before.length;
  const created = await http("/asset-versions/p1s1_v3/comments", { method: "POST", body: { content: "from test", timestampMs: 1234 } });
  assert.equal(created.status, 201);
  assert.equal(created.json.content, "from test");

  const edited = await http("/comments/" + created.json.id, { method: "PATCH", body: { content: "edited test" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.content, "edited test");

  const after = await http("/asset-versions/p1s1_v3/comments");
  assert.equal(after.json.length, baselineCount + 1);

  const patched = await http("/comments/" + created.json.id, { method: "PATCH", body: { resolved: true } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.resolved, true);

  const deleted = await http("/comments/" + created.json.id, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);

  const finalState = await http("/asset-versions/p1s1_v3/comments");
  assert.equal(finalState.json.length, baselineCount);
});

test("shared comment link is rate-limited per token/ip", async () => {
  const share = await http("/projects/p1/shares", {
    method: "POST",
    body: { accessLevel: "comment", ttlHours: 24, guestLabel: "Khach test" },
  });
  assert.equal(share.status, 201);
  assert.equal(share.json.accessLevel, "comment");

  const postShared = async (idx) => {
    const r = await fetch(BASE + "/shared/" + share.json.token + "/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetVersionId: "p1s1_v3",
        content: "Guest comment " + idx,
        timestampMs: 1000 + idx,
      }),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
  };

  for (let i = 0; i < 12; i++) {
    const ok = await postShared(i);
    assert.equal(ok.status, 201);
  }
  const blocked = await postShared(99);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after") !== null, true);
});

test("transcode request advances rendition", async () => {
  const r = await http("/asset-versions/p1s1_v3/renditions", { method: "POST", body: { height: 1080 } });
  assert.ok(r.status === 200 || r.status === 202);
  assert.equal(r.json.status === "processing" || r.json.status === "ready", true);
});

test("NAS list and import lifecycle", async () => {
  const ls = await http("/nas/ls?path=/Footage/TVC%20Q3%202026/Hero");
  assert.equal(ls.status, 200);
  const file = ls.json.entries.find((e) => e.type === "file");
  assert.ok(file);
  const before = (await http("/projects/p1/sources")).json.length;
  const r = await http("/projects/p1/import", { method: "POST", body: { nasPaths: [file.path] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported.length, 1);
  const after = (await http("/projects/p1/sources")).json.length;
  assert.equal(after, before + 1);
});

test("HLS sim mode returns valid empty playlist", async () => {
  const r = await fetch(BASE + "/hls/p1s1_v3_720p/master.m3u8", { headers: { cookie } });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /^#EXTM3U/);
  assert.match(text, /#EXT-X-ENDLIST/);
});

test("HLS signed URL can access playback without session cookie", async () => {
  const exp = String(Math.floor(Date.now() / 1000) + 120);
  const sig = createSignedPlaybackToken("p1s1_v3_720p", "master.m3u8", "test-hls-secret", exp);
  const r = await fetch(`${BASE}/hls/p1s1_v3_720p/master.m3u8?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /^#EXTM3U/);
});

test("HLS unsigned playback without session is rejected", async () => {
  const r = await fetch(BASE + "/hls/p1s1_v3_720p/master.m3u8");
  assert.equal(r.status, 401);
});

test("presence touch + snapshot", async () => {
  await http("/presence", { method: "POST", body: { focus: { kind: "source", id: "p1s1", projectId: "p1" } } });
  const r = await http("/presence");
  assert.equal(r.status, 200);
  assert.ok(r.json.some((u) => u.focus && u.focus.id === "p1s1"));
});

test("WebSocket upgrade authenticates and responds to ping", async () => {
  const ws = new WebSocket(BASE.replace("http://", "ws://") + "/ws", {
    headers: { cookie },
  });
  const messages = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket hello timeout")), 2000);
    ws.on("message", (buf) => {
      try {
        const payload = JSON.parse(String(buf));
        messages.push(payload);
        if (payload.type === "hello") {
          clearTimeout(timer);
          resolve();
        }
      } catch (_) {}
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  ws.send(JSON.stringify({ type: "ping" }));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket pong timeout")), 2000);
    ws.on("message", (buf) => {
      try {
        const payload = JSON.parse(String(buf));
        messages.push(payload);
        if (payload.type === "pong") {
          clearTimeout(timer);
          resolve();
        }
      } catch (_) {}
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  assert.ok(messages.some((message) => message.type === "hello"));
  assert.ok(messages.some((message) => message.type === "pong"));
  ws.close();
});

test("SSE delivers a rendition event", async () => {
  const ctrl = new AbortController();
  const events = [];
  const p = (async () => {
    const r = await fetch(BASE + "/events", { headers: { cookie }, signal: ctrl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const line of buf.split("\n\n")) {
        if (line.startsWith("data: ")) {
          try { events.push(JSON.parse(line.slice(6))); } catch (_) {}
        }
      }
      buf = buf.split("\n\n").pop();
      if (events.some((e) => e.type === "rendition")) break;
    }
  })();
  await wait(200);
  // make sure something is in flight
  await http("/asset-versions/p1s2_v1/renditions", { method: "POST", body: { height: 1080 } });
  await Promise.race([p, wait(4000).then(() => ctrl.abort())]);
  ctrl.abort();
  assert.ok(events.some((e) => e.type === "rendition"), "expected a rendition SSE event");
});

test("workspace and project APIs are filtered by membership", async () => {
  await http("/auth/logout", { method: "POST" });
  cookie = "";

  const login = await http("/auth/dsm/login", { method: "POST", body: { account: "qa_user", passwd: "x" } });
  assert.equal(login.status, 200);
  const projects = await http("/projects");
  assert.equal(projects.status, 200);
  assert.equal(projects.json.length, 0);

  const forbidden = await http("/projects/p1");
  assert.equal(forbidden.status, 403);

  await http("/auth/logout", { method: "POST" });
  cookie = "";
  await http("/auth/dsm/login", { method: "POST", body: { account: "minh", passwd: "x" } });
});

test("logout invalidates session", async () => {
  await http("/auth/logout", { method: "POST" });
  const r = await http("/me");
  assert.equal(r.status, 401);
});

test("login rate limit kicks in after 5 failures", async () => {
  cookie = "";
  for (let i = 0; i < 5; i++) {
    await http("/auth/dsm/login", { method: "POST", body: { account: "" } }); // 400
  }
  const r = await http("/auth/dsm/login", { method: "POST", body: { account: "" } });
  assert.equal(r.status, 429);
});
