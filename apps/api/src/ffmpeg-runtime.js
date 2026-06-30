import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const probeCache = new Map();

function normalizeText(value) {
  return String(value || "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastArg(args = []) {
  return args.length ? args[args.length - 1] : "";
}

function hasListEntry(output, name) {
  return new RegExp("^\\s*[A-Z\\.]{1,8}\\s+" + escapeRegExp(name) + "\\b", "mi").test(String(output || ""));
}

function uniqueCandidates(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const path = normalizeText(item && item.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, source: item && item.source || "unknown" });
  }
  return out;
}

export function listFfmpegCandidates(env = process.env) {
  const explicitLibDir = normalizeText(env.COOPEDITOR_LIB_DIR);
  const derivedLibDir = explicitLibDir || deriveRuntimeLibDir();
  const allowSystemLookup = String(env.COOPEDITOR_FFMPEG_DISABLE_SYSTEM_LOOKUP || "").trim() !== "1";
  return uniqueCandidates([
    { path: env.FFMPEG_PATH, source: "env" },
    { path: derivedLibDir ? join(derivedLibDir, "bin", "ffmpeg") : "", source: "bundled" },
    { path: allowSystemLookup ? "/var/packages/CodecPack/target/bin/ffmpeg" : "", source: "codecpack" },
    { path: allowSystemLookup ? "ffmpeg" : "", source: "path" },
  ]);
}

function deriveRuntimeLibDir() {
  const runtimeNode = normalizeText(process.execPath);
  if (!runtimeNode) return "";
  if (/\/lib\/node\/bin\/node$/.test(runtimeNode)) {
    return dirname(dirname(dirname(runtimeNode)));
  }
  return "";
}

async function commandExists(bin) {
  if (bin.includes("/")) {
    try {
      await access(bin, constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  }
  try {
    await execFileAsync("sh", ["-lc", "command -v " + bin], { timeout: 3000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function runFfmpegList(bin, listFlag) {
  const { stdout, stderr } = await execFileAsync(bin, ["-hide_banner", listFlag], {
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return [stdout, stderr].filter(Boolean).join("\n");
}

async function probeFfmpegBinary(bin) {
  const key = normalizeText(bin);
  const cached = probeCache.get(key);
  if (cached) return cached;

  const resultPromise = (async () => {
    if (!await commandExists(key)) {
      return {
        ok: false,
        reason: "Không tìm thấy ffmpeg binary tại " + key,
        path: key,
        decodersOutput: "",
        encodersOutput: "",
      };
    }
    try {
      const [decodersOutput, encodersOutput] = await Promise.all([
        runFfmpegList(key, "-decoders"),
        runFfmpegList(key, "-encoders"),
      ]);
      return {
        ok: true,
        reason: "",
        path: key,
        decodersOutput,
        encodersOutput,
      };
    } catch (err) {
      return {
        ok: false,
        reason: "FFmpeg tại " + key + " không đọc được danh sách codec: " + ((err && err.message) || err),
        path: key,
        decodersOutput: "",
        encodersOutput: "",
      };
    }
  })();

  probeCache.set(key, resultPromise);
  return resultPromise;
}

function resolveRequirements(profile = "proxy") {
  if (profile === "thumbnail") {
    return {
      label: "thumbnail",
      needDecoders: ["h264"],
      needEncoders: ["mjpeg"],
      needAnyVideoEncoder: [],
    };
  }
  return {
    label: "proxy",
    needDecoders: ["h264"],
    needEncoders: ["aac"],
    needAnyVideoEncoder: ["libx264", "h264_nvenc", "h264_qsv", "h264_vaapi", "libopenh264"],
  };
}

function validateProbe(probe, requirements) {
  if (!probe.ok) return probe;
  const missingDecoders = requirements.needDecoders.filter((name) => !hasListEntry(probe.decodersOutput, name));
  const missingEncoders = requirements.needEncoders.filter((name) => !hasListEntry(probe.encodersOutput, name));
  const hasVideoEncoder = requirements.needAnyVideoEncoder.length === 0
    || requirements.needAnyVideoEncoder.some((name) => hasListEntry(probe.encodersOutput, name));
  if (!missingDecoders.length && !missingEncoders.length && hasVideoEncoder) {
    return {
      ...probe,
      ok: true,
      reason: "",
    };
  }
  const parts = [];
  if (missingDecoders.length) parts.push("thiếu decoder " + missingDecoders.join(", "));
  if (missingEncoders.length) parts.push("thiếu encoder " + missingEncoders.join(", "));
  if (!hasVideoEncoder && requirements.needAnyVideoEncoder.length) {
    parts.push("thiếu video encoder phù hợp (" + requirements.needAnyVideoEncoder.join(" / ") + ")");
  }
  return {
    ...probe,
    ok: false,
    reason: "FFmpeg tại " + probe.path + " chưa đủ codec cho " + requirements.label + ": " + parts.join("; "),
  };
}

export async function resolveUsableFfmpeg(profile = "proxy", env = process.env) {
  const requirements = resolveRequirements(profile);
  const candidates = listFfmpegCandidates(env);
  const failures = [];
  for (const candidate of candidates) {
    const validated = validateProbe(await probeFfmpegBinary(candidate.path), requirements);
    if (validated.ok) {
      return {
        usable: true,
        path: candidate.path,
        source: candidate.source,
        reason: "",
      };
    }
    failures.push(candidate.source + ": " + validated.reason);
  }
  return {
    usable: false,
    path: candidates[0] ? candidates[0].path : "",
    source: candidates[0] ? candidates[0].source : "",
    reason: failures.length
      ? ("Không tìm thấy FFmpeg usable cho " + requirements.label + ". " + failures.join(" | "))
      : ("Không có candidate FFmpeg nào cho " + requirements.label + "."),
  };
}

export function clearFfmpegProbeCache() {
  probeCache.clear();
}

export { lastArg };
