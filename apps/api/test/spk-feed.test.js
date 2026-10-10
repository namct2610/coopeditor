import { test } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { infoVersionFromTag, archBucket, catalogFromRelease, changelogFromNotes, downloadSpk, mirrorPath, buildSpkCatalog, packageFeedStatus, currentCatalog } from "../src/spk-feed.js";

test("infoVersionFromTag normalises tags the same way build-spk.sh does", () => {
  assert.equal(infoVersionFromTag("v1.0.0-spk-rc42"), "1.0.0-42");
  assert.equal(infoVersionFromTag("1.0.0-rc7"), "1.0.0-7");
  assert.equal(infoVersionFromTag("v1.2.3"), "1.2.3-1");
  assert.equal(infoVersionFromTag("1.2.3-5"), "1.2.3-5");
  assert.equal(infoVersionFromTag("not-a-version"), null);
  assert.equal(infoVersionFromTag(""), null);
});

test("archBucket maps DSM codenames to spk arch labels", () => {
  assert.equal(archBucket("geminilake"), "x86_64");
  assert.equal(archBucket("Purley"), "x86_64");
  assert.equal(archBucket("rtd1296"), "aarch64");
  assert.equal(archBucket("armada38x"), "aarch64");
  assert.equal(archBucket("noarch"), null);
  assert.equal(archBucket(""), null);
});

const fakeRelease = {
  tag_name: "v1.0.0-spk-rc42",
  body: "changelog here",
  assets: [
    { name: "coopeditor-x86_64-1.0.0-spk-rc42.spk", browser_download_url: "https://gh.test/x86.spk", size: 111 },
    { name: "coopeditor-aarch64-1.0.0-spk-rc42.spk", browser_download_url: "https://gh.test/arm.spk", size: 222 },
    { name: "checksums.json", browser_download_url: "https://gh.test/checksums.json", size: 10 },
  ],
};
const fakeChecksums = {
  "coopeditor-x86_64-1.0.0-spk-rc42.spk": { md5: "aaa111", size: 1111 },
};

test("catalogFromRelease picks the right asset per arch and applies checksums", () => {
  const x86 = catalogFromRelease(fakeRelease, fakeChecksums, "x86_64");
  assert.equal(x86.packages.length, 1);
  assert.equal(x86.packages[0].package, "coopeditor");
  assert.equal(x86.packages[0].version, "1.0.0-42");
  assert.equal(x86.packages[0].link, "https://gh.test/x86.spk");
  assert.equal(x86.packages[0].md5, "aaa111");
  assert.equal(x86.packages[0].size, 1111); // checksums.json wins over asset size
  assert.equal(x86.packages[0].qupgrade, true);

  const arm = catalogFromRelease(fakeRelease, fakeChecksums, "aarch64");
  assert.equal(arm.packages[0].link, "https://gh.test/arm.spk");
  assert.equal(arm.packages[0].size, 222); // no checksum entry → asset size
  assert.equal("md5" in arm.packages[0], false);
});

test("catalogFromRelease returns empty catalog for unknown arch or bad tag", () => {
  assert.deepEqual(catalogFromRelease(fakeRelease, {}, null), { packages: [] });
  assert.deepEqual(catalogFromRelease({ tag_name: "garbage", assets: [] }, {}, "x86_64"), { packages: [] });
});

test("changelog comes from release.json notes as plain text, falling back to the release body", () => {
  const notes = { summary: "RC 42 summary", changes: ["first change", "second change"] };
  const x86 = catalogFromRelease(fakeRelease, fakeChecksums, "x86_64", notes);
  assert.equal(x86.packages[0].changelog, "RC 42 summary • first change • second change");
  assert.equal(catalogFromRelease(fakeRelease, fakeChecksums, "x86_64").packages[0].changelog, "changelog here");
  assert.equal(changelogFromNotes({ summary: "x".repeat(3000) }).length, 2000);
  assert.ok(!/frame\.?io/i.test(x86.packages[0].desc), "description no longer references Frame.io");
});

test("downloadSpk follows the CDN redirect, verifies md5/size, keeps only the newest per arch", async () => {
  const payload = Buffer.alloc(300_000, 9);
  const md5 = createHash("md5").update(payload).digest("hex");
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/releases/")) { res.writeHead(302, { location: "/cdn/signed?sig=1" }); return res.end(); }
    res.writeHead(200, { "content-length": payload.length }); res.end(payload);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  const dir = mkdtempSync(join(tmpdir(), "spk-mirror-"));
  try {
    writeFileSync(join(dir, "coopeditor-x86_64-1.0.0-spk-rc50.spk"), "old");
    writeFileSync(join(dir, "coopeditor-aarch64-1.0.0-spk-rc50.spk"), "other arch");
    const name = "coopeditor-x86_64-1.0.0-spk-rc52.spk";
    assert.equal(await mirrorPath(dir, name), null);
    await downloadSpk({ dir, name, url: base + "/releases/x.spk", md5, size: payload.length });
    assert.ok(readFileSync(await mirrorPath(dir, name)).equals(payload));
    assert.deepEqual(readdirSync(dir).sort(), ["coopeditor-aarch64-1.0.0-spk-rc50.spk", name], "older x86_64 pruned, other arch kept");

    const bad = "coopeditor-x86_64-1.0.0-spk-rc53.spk";
    await assert.rejects(downloadSpk({ dir, name: bad, url: base + "/releases/x.spk", md5: "0".repeat(32) }), /md5 mismatch/);
    await assert.rejects(downloadSpk({ dir, name: bad, url: base + "/releases/x.spk", size: 5 }), /size mismatch/);
    assert.equal(await mirrorPath(dir, bad), null, "a failed download never becomes servable");
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".part")), "partial file cleaned up");

    assert.equal(await mirrorPath(dir, "../../etc/passwd"), null);
    await assert.rejects(downloadSpk({ dir, name: "../x.spk", url: base }), /bad spk name/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFromRelease can point DSM at the local mirror", () => {
  const c = catalogFromRelease(fakeRelease, fakeChecksums, "x86_64", null, { link: (a) => "http://nas:13000/spkserver/spk/" + a.name });
  assert.equal(c.packages[0].link, "http://nas:13000/spkserver/spk/coopeditor-x86_64-1.0.0-spk-rc42.spk");
  assert.equal(c.packages[0].md5, "aaa111");
});

test("downloadSpk aborts a stalled transfer instead of hanging", async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-length": 1000 }); res.write(Buffer.alloc(100)); /* then silence */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "spk-mirror-"));
  try {
    const t0 = Date.now();
    await assert.rejects(downloadSpk({ dir, name: "coopeditor-x86_64-1.0.0-spk-rc9.spk", url: "http://127.0.0.1:" + srv.address().port + "/x", idleMs: 300 }), /stalled/);
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(readdirSync(dir), [], "no partial file left behind");
  } finally {
    srv.closeAllConnections(); srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog is found without the GitHub API (rate-limited) via releases/latest + checksums.json", async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url); seen.push(url);
    if (url.includes("api.github.com")) return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    if (url.endsWith("/releases/latest")) {
      assert.equal(opts.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://github.com/namct2610/coopeditor/releases/tag/v1.0.0-spk-rc58" } });
    }
    if (url.endsWith("/releases/download/v1.0.0-spk-rc58/checksums.json")) {
      return Response.json({ "coopeditor-x86_64-1.0.0-spk-rc58.spk": { md5: "abc", size: 123 }, "coopeditor-aarch64-1.0.0-spk-rc58.spk": { md5: "def", size: 456 } });
    }
    if (url.includes("raw.githubusercontent.com")) return Response.json({ summary: "Video Final", changes: ["a"] });
    return new Response("nope", { status: 404 });
  };
  try {
    const cat = await buildSpkCatalog("geminilake", { force: true });
    assert.equal(cat.packages.length, 1);
    const pkg = cat.packages[0];
    assert.equal(pkg.version, "1.0.0-58");
    assert.equal(pkg.md5, "abc");
    assert.equal(pkg.size, 123);
    assert.equal(pkg.link, "https://github.com/namct2610/coopeditor/releases/download/v1.0.0-spk-rc58/coopeditor-x86_64-1.0.0-spk-rc58.spk");
    assert.match(pkg.changelog, /Video Final/);
    assert.ok(!seen.some((u) => u.includes("api.github.com")), "API not needed when the redirect works");
    const st = await packageFeedStatus(null);
    assert.equal(st.tag, "v1.0.0-spk-rc58");
    assert.equal(st.via, "github.com");
    assert.equal(st.error, null);
  } finally {
    globalThis.fetch = real;
  }
});

test("currentCatalog lists the running version, so the source is never empty", () => {
  const cat = currentCatalog("x86_64", { version: "1.0.0-rc63", summary: "Sửa lỗi chữ", changes: ["a"] });
  assert.equal(cat.packages.length, 1);
  assert.equal(cat.packages[0].version, "1.0.0-63");
  assert.equal(cat.packages[0].link, "https://github.com/namct2610/coopeditor/releases/download/v1.0.0-spk-rc63/coopeditor-x86_64-1.0.0-spk-rc63.spk");
  assert.match(cat.packages[0].changelog, /Sửa lỗi chữ/);
  assert.equal(currentCatalog("x86_64", { version: "1.0.0-spk-rc63" }).packages[0].version, "1.0.0-63");
  assert.deepEqual(currentCatalog("x86_64", { version: "unknown" }), { packages: [] });
  assert.deepEqual(currentCatalog(null, { version: "1.0.0-rc63" }), { packages: [] });
});

test("while a new release is still on its way to the mirror, Package Center keeps seeing the installed one", async () => {
  const real = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), "spk-prep-"));
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.endsWith("/releases/latest")) return new Response(null, { status: 302, headers: { location: "https://github.com/namct2610/coopeditor/releases/tag/v1.0.0-spk-rc64" } });
    if (url.endsWith("/releases/download/v1.0.0-spk-rc64/checksums.json")) return Response.json({ "coopeditor-x86_64-1.0.0-spk-rc64.spk": { md5: "abc", size: 123 } });
    if (url.includes("raw.githubusercontent.com")) return Response.json({ summary: "Nhắc chữ" });
    return new Response("nope", { status: 404 }); // the .spk itself isn't there yet
  };
  try {
    const cat = await buildSpkCatalog("geminilake", { force: true, mirrorDir: dir, baseUrl: "http://nas:13000", current: { version: "1.0.0-rc63" } });
    assert.equal(cat.preparing, "coopeditor-x86_64-1.0.0-spk-rc64.spk");
    assert.equal(cat.packages.length, 1, "not an empty catalog: DSM would drop the Community tab");
    assert.equal(cat.packages[0].version, "1.0.0-63");
    // and without knowing what runs here it can only say "nothing yet"
    const bare = await buildSpkCatalog("geminilake", { mirrorDir: dir, baseUrl: "http://nas:13000" });
    assert.deepEqual(bare.packages, []);
    // an arch codename missing from the lists falls back to this machine's own
    const own = await buildSpkCatalog("somenewcodename", { mirrorDir: dir, baseUrl: "http://nas:13000", current: { version: "1.0.0-rc63" } });
    assert.equal(own.packages.length, process.arch === "x64" || process.arch === "arm64" ? 1 : 0);
  } finally {
    globalThis.fetch = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadSpk fetches ranges over several connections, retries a failed range, falls back without Range", async () => {
  const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
  const md5 = createHash("md5").update(payload).digest("hex");
  let flaky = true, ranged = 0, open = 0, maxOpen = 0;
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/releases/")) { res.writeHead(302, { location: "/cdn" + req.url.slice(9) }); return res.end(); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    if (req.url.includes("norange") || !m) { res.writeHead(200, { "content-length": payload.length }); return res.end(payload); }
    const a = +m[1], b = +m[2];
    ranged++; open++; maxOpen = Math.max(maxOpen, open);
    res.on("close", () => { open--; });
    res.writeHead(206, { "content-length": b - a + 1, "content-range": `bytes ${a}-${b}/${payload.length}` });
    if (flaky && a === 65536) { flaky = false; res.write(payload.subarray(a, a + 100)); return setTimeout(() => res.destroy(), 20); } // drops mid-range once
    setTimeout(() => res.end(payload.subarray(a, b + 1)), 15);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  const dir = mkdtempSync(join(tmpdir(), "spk-ranged-"));
  try {
    const name = "coopeditor-x86_64-1.0.0-spk-rc70.spk";
    let last = 0;
    await downloadSpk({ dir, name, url: base + "/releases/x.spk", md5, size: payload.length, chunkBytes: 65536, parallel: 3, onProgress: (n) => { last = n; } });
    assert.ok(readFileSync(await mirrorPath(dir, name)).equals(payload));
    assert.equal(last, payload.length, "progress reaches the full size");
    assert.equal(ranged, 6, "5 ranges + 1 retry of the range that dropped");
    assert.ok(maxOpen > 1 && maxOpen <= 3, "several connections at once, never more than asked: " + maxOpen);

    const plain = "coopeditor-x86_64-1.0.0-spk-rc71.spk";
    await downloadSpk({ dir, name: plain, url: base + "/releases/norange.spk", md5, size: payload.length, chunkBytes: 65536 });
    assert.ok(readFileSync(await mirrorPath(dir, plain)).equals(payload), "server without Range: one-stream download");

    await assert.rejects(downloadSpk({ dir, name: "coopeditor-x86_64-1.0.0-spk-rc72.spk", url: base + "/releases/x.spk", md5: "0".repeat(32), size: payload.length, chunkBytes: 65536 }), /md5 mismatch/);
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".part")), "partial file cleaned up");
  } finally {
    srv.closeAllConnections(); srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
