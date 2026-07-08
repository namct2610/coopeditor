import { test } from "node:test";
import assert from "node:assert/strict";

import { infoVersionFromTag, archBucket, catalogFromRelease } from "../src/spk-feed.js";

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
