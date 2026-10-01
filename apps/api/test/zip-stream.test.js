import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, createWriteStream, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";

import { writeZip, zipLength } from "../src/zip-stream.js";

const has = (bin) => spawnSync(bin, ["--version"]).status !== null;

// limit=1 forces every ZIP64 path (per-entry extra + zip64 end records)
// without needing a 4 GiB fixture.
for (const [label, limit] of [["plain", undefined], ["zip64", 1]]) {
  test(`writeZip (${label}) matches zipLength and is readable by unzip/python`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-stream-"));
    try {
      const files = [
        { name: "Tết 2026 — bản dựng.mp4", data: Buffer.alloc(200_000, 7) },
        { name: "empty.mov", data: Buffer.alloc(0) },
        { name: "b.mp4", data: Buffer.from("hello zip") },
      ];
      const entries = files.map((f, i) => {
        const path = join(dir, "src" + i);
        writeFileSync(path, f.data);
        return { name: f.name, path, size: f.data.length };
      });
      const out = join(dir, "out.zip");
      const ws = createWriteStream(out);
      await writeZip(ws, entries, { limit });
      ws.end(); await finished(ws);
      assert.equal(statSync(out).size, zipLength(entries, { limit }));

      if (has("unzip")) {
        const r = spawnSync("unzip", ["-t", out], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stdout + r.stderr);
      }
      if (has("python3")) {
        const py = "import sys,zipfile,hashlib\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nfor i in z.infolist(): print(i.filename, len(z.read(i)))";
        const r = spawnSync("python3", ["-c", py, out], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), files.map((f) => f.name + " " + f.data.length).join("\n"));
      }
      assert.ok(readFileSync(out).includes(Buffer.from("hello zip")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("writeZip throws when a file is shorter than planned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-stream-"));
  try {
    const path = join(dir, "a"); writeFileSync(path, "abc");
    const ws = createWriteStream(join(dir, "o.zip"));
    await assert.rejects(writeZip(ws, [{ name: "a", path, size: 10 }]), /changed while zipping/);
    ws.destroy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
