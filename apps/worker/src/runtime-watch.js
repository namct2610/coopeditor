import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { configPath } from "../../api/src/runtime-config.js";

export async function readRuntimeConfigFingerprint(path = configPath()) {
  try {
    const raw = await readFile(path, "utf8");
    return createHash("sha1").update(raw).digest("hex");
  } catch (_) {
    return "";
  }
}

export function createRuntimeConfigWatcher({ intervalMs = 5000, readFingerprint = readRuntimeConfigFingerprint, onChange, logger = console } = {}) {
  let lastFingerprint = "";
  let timer = null;
  let polling = false;

  async function prime() {
    lastFingerprint = await readFingerprint();
    return lastFingerprint;
  }

  async function check() {
    if (polling) return false;
    polling = true;
    try {
      const nextFingerprint = await readFingerprint();
      if (!lastFingerprint) {
        lastFingerprint = nextFingerprint;
        return false;
      }
      if (nextFingerprint && nextFingerprint !== lastFingerprint) {
        const previousFingerprint = lastFingerprint;
        lastFingerprint = nextFingerprint;
        if (typeof onChange === "function") await onChange({ previousFingerprint, nextFingerprint });
        return true;
      }
      return false;
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer) return timer;
    timer = setInterval(() => {
      check().catch((err) => logger.warn("[worker-bootstrap] runtime config watch failed:", err && err.message || err));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { prime, check, start, stop };
}
