import { join } from "node:path";
import { tmpdir } from "node:os";

export function resolveFfmpegOutputDir(baseDir, renditionId) {
  return join(baseDir || join(tmpdir(), "co-out"), renditionId);
}
