import test from "node:test";
import assert from "node:assert/strict";

import { isPermanentTranscodeError, shouldAutoRequeueFailedJob } from "../src/error-policy.js";

test("isPermanentTranscodeError detects mount and permission failures", () => {
  assert.equal(isPermanentTranscodeError(new Error("Source path not mounted in worker: /nas/clip.mp4")), true);
  assert.equal(isPermanentTranscodeError(new Error("Source file not found in worker: /nas/clip.mp4")), true);
  assert.equal(isPermanentTranscodeError(new Error("Worker cannot read source path: /nas/clip.mp4")), true);
  assert.equal(isPermanentTranscodeError(new Error("Duplicate active transcode job was superseded by a newer claim.")), true);
  assert.equal(isPermanentTranscodeError(new Error("ffmpeg exit 127")), true);
  assert.equal(isPermanentTranscodeError(new Error("ffmpeg exit 254")), false);
});

test("shouldAutoRequeueFailedJob skips permanent failures but keeps transient ones", () => {
  assert.equal(shouldAutoRequeueFailedJob("Source path not mounted in worker: /nas/clip.mp4"), false);
  assert.equal(shouldAutoRequeueFailedJob("Source file not found in worker: /nas/clip.mp4"), false);
  assert.equal(shouldAutoRequeueFailedJob("Duplicate active transcode job was superseded by a newer claim."), false);
  assert.equal(shouldAutoRequeueFailedJob("spawn ffmpeg ENOENT"), false);
  assert.equal(shouldAutoRequeueFailedJob("ffmpeg exit 254"), true);
  assert.equal(shouldAutoRequeueFailedJob(""), true);
});
