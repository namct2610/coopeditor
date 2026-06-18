const PERMANENT_TRANSODE_ERROR_RE = /ENOENT|EACCES|not mounted|source file not found|cannot read source path|khong tim thay|khong du quyen|ffmpeg exit 127|spawn .*ffmpeg/i;

export function isPermanentTranscodeError(err) {
  const text = String(err && err.message || err || "");
  return PERMANENT_TRANSODE_ERROR_RE.test(text);
}

export function shouldAutoRequeueFailedJob(errorText) {
  return !isPermanentTranscodeError(errorText || "");
}
