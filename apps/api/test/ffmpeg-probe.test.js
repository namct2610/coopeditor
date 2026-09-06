import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// dsm.js reads env at import; load it fresh from the repo root like the other
// dsm tests do.
const dsm = await import(pathToFileURL(join(process.cwd(), "apps/api/src/dsm.js")).href);

// Captured from a real `ffmpeg -hide_banner -i clip.mp4` on a file with no
// output specified (ffmpeg prints input info, then exits 1).
const SAMPLE = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  "  Metadata:",
  "    major_brand     : isom",
  "  Duration: 00:01:03.52, start: 0.000000, bitrate: 112 kb/s",
  "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 108 kb/s, 25 fps, 25 tbr, 12800 tbn (default)",
  "At least one output file must be specified",
].join("\n");

test("parseFfmpegProbeStderr extracts duration, resolution, fps and codec", () => {
  const r = dsm.parseFfmpegProbeStderr(SAMPLE);
  assert.equal(r.hasVideo, true);
  assert.equal(r.durationMs, 63520); // 1:03.52
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.frameRate, 25);
  assert.equal(r.codec, "H.264");
});

test("parseFfmpegProbeStderr falls back cleanly on audio-only / empty input", () => {
  const audioOnly = "  Duration: 00:00:30.00, bitrate: 128 kb/s\n  Stream #0:0: Audio: aac, 48000 Hz, stereo";
  const r = dsm.parseFfmpegProbeStderr(audioOnly);
  assert.equal(r.durationMs, 30000);
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
  // hasVideo is true here only because a duration was found — buildVideoEntry
  // still guards on name/extension upstream, so this is acceptable.
  assert.equal(r.hasVideo, true);

  const empty = dsm.parseFfmpegProbeStderr("");
  assert.equal(empty.durationMs, 0);
  assert.equal(empty.hasVideo, false);
});
