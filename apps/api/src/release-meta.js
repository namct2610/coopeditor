import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RELEASE_PATH = process.env.RELEASE_METADATA_PATH || resolve(ROOT_DIR, "release.json");

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function cleanText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function cleanChanges(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item)).filter(Boolean).slice(0, 12);
}

function readReleaseRaw() {
  if (!existsSync(RELEASE_PATH)) return null;
  return parseJson(readFileSync(RELEASE_PATH, "utf8")) || {};
}

export function readReleaseManifest() {
  const parsed = readReleaseRaw();
  if (!parsed) {
    return {
      version: "0.0.0",
      summary: "Release manifest missing",
      changes: [],
      publishedAt: null,
    };
  }
  return {
    version: cleanText(parsed.version, "0.0.0"),
    summary: cleanText(parsed.summary, "No summary provided"),
    changes: cleanChanges(parsed.changes),
    publishedAt: cleanText(parsed.publishedAt, null),
  };
}

export function buildLocalReleaseMeta() {
  const manifest = readReleaseManifest();
  const raw = readReleaseRaw() || {};
  // Prefer the build-time env (Docker / CI), fall back to whatever the
  // workflow stamped into release.json (SPK build path runs that stamp
  // step the same way the GHCR workflow does). Last resort: "unknown",
  // which trips a permanent "Cần cập nhật" banner — both sources should
  // agree in normal deployments.
  return {
    ...manifest,
    sha: cleanText(process.env.BUILD_SHA, "") || cleanText(raw.sha, "unknown"),
    builtAt: cleanText(process.env.BUILT_AT, "") || cleanText(raw.builtAt, "unknown"),
  };
}

export function normalizeRemoteReleaseMeta(payload) {
  if (!payload || typeof payload !== "object") return null;
  const sha = cleanText(payload.sha || payload.id || (payload.commit && payload.commit.sha), "");
  const version = cleanText(payload.version, "");
  const summary = cleanText(payload.summary || payload.description || payload.title, "");
  const changes = cleanChanges(payload.changes);
  const publishedAt = cleanText(payload.publishedAt || payload.builtAt || payload.updatedAt, "");
  if (!(sha || version || summary || changes.length || publishedAt)) return null;
  return {
    version: version || "unknown",
    summary: summary || "Remote release metadata available",
    changes,
    publishedAt: publishedAt || null,
    builtAt: cleanText(payload.builtAt, null),
    sha: sha || "unknown",
  };
}

export function hasRemoteUpdate(localMeta, remoteMeta) {
  // SHA is the authoritative signal — it's stamped at build time by CI from
  // the actual commit. Version strings drift because nobody bumps them on
  // every push. Only consider an update available when both sides have a
  // real SHA AND they differ; otherwise return false to avoid a sticky
  // "Cần cập nhật" banner after a successful pull.
  if (!remoteMeta) return false;
  if (remoteMeta.sha && localMeta.sha && remoteMeta.sha !== "unknown" && localMeta.sha !== "unknown") {
    return remoteMeta.sha.slice(0, 7) !== localMeta.sha.slice(0, 7);
  }
  return false;
}
