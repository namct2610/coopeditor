import { test } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { infoVersionFromTag, archBucket, catalogFromRelease, changelogFromNotes, downloadSpk, mirrorPath } from "../src/spk-feed.js";

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
