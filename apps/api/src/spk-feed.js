// Synology Package Center "package source" endpoint.
//
// Add  http://<nas>:<port>/spkserver  once in Package Center → Settings →
// Package Sources. DSM then polls this URL (form-encoded POST with the NAS
// arch codename, e.g. arch=geminilake) and expects {"packages":[...]} back.
// When the version here is newer than the installed one, Package Center shows
// a native Update button — no more manual .spk uploads.
//
// The catalog is proxied from the latest GitHub release of this repo: the
// publish-spk workflow attaches the per-arch .spk files plus checksums.json
// (md5 + size, which DSM verifies after download).

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = process.env.SPK_FEED_REPO || "namct2610/coopeditor";
// Keep in sync with synology/spk-src/INFO (description).
export const PACKAGE_DESC = "Coopeditor — công cụ giao tiếp cho người sáng tạo. Review video ngay trên NAS với bình luận và vẽ ghi chú chính xác tới từng khung hình, proxy HLS tự tạo để xem mượt qua mạng, lịch lên sóng theo dự án và soạn kịch bản cùng cả nhóm.";
// 5 min: a fresh release shows up in Package Center quickly, while the public
// /spkserver can still only cost GitHub's unauthenticated API (60/h per IP)
// ~2 requests per refresh (release + checksums) → ≤24/h.
const CACHE_TTL_MS = 5 * 60_000;

// Same DSM arch-codename lists as synology/build-spk.sh — keep in sync.
const X86_64 = new Set("apollolake avoton braswell broadwell broadwellnk broadwellnkv2 broadwellntbap bromolow cedarview denverton epyc7002 geminilake geminilakenext grantley kvmx64 purley v1000 x86_64".split(" "));
const AARCH64 = new Set("armadaxp armada37xx armada38x alpine alpine4k rtd1296 rtd1619b monaco aarch64".split(" "));

// v1.0.0-spk-rc42 / 1.0.0-rc42 / v1.2.3 → DSM INFO version ("1.0.0-42",
// "1.2.3-1"). Mirrors the normalisation in synology/build-spk.sh so DSM
// compares apples to apples against the installed package.
export function infoVersionFromTag(tag) {
  const label = String(tag || "").trim().replace(/^v/, "");
  const m = label.match(/^(\d+\.\d+\.\d+)(?:-(?:spk-)?rc(\d+)|-(\d+))?$/);
  if (!m) return null;
  return m[1] + "-" + (m[2] || m[3] || "1");
}

export function archBucket(arch) {
  const a = String(arch || "").trim().toLowerCase();
  if (X86_64.has(a)) return "x86_64";
  if (AARCH64.has(a)) return "aarch64";
  return null;
}

let _cache = null; // { at, data }
const UA = { "user-agent": "coopeditor-spk-feed" };
// What the last refresh found, for Cài đặt → Cập nhật.
const _feed = { checkedAt: null, tag: null, via: null, error: null };

// The latest release without the GitHub API: github.com/<repo>/releases/latest
// redirects to the tag, and checksums.json (attached by publish-spk) already
// lists every .spk with md5 + size. The unauthenticated API allows only 60
// calls/hour per public IP — an office NAT shares that with every other
// device, and a 403 there left Package Center with an empty catalog.
async function releaseFromDownloads() {
  const r = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15000) });
  const loc = r.headers.get("location") || "";
  const m = loc.match(/\/releases\/tag\/([^/?#]+)$/);
  if (!m) throw new Error("releases/latest: HTTP " + r.status + (loc ? " → " + loc : ""));
  const tag = decodeURIComponent(m[1]);
  const base = `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/`;
  const c = await fetch(base + "checksums.json", { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!c.ok) throw new Error("checksums.json: HTTP " + c.status);
  const checksums = await c.json();
  const assets = Object.entries(checksums || {}).map(([name, sum]) => ({ name, size: Number(sum && sum.size) || 0, browser_download_url: base + encodeURIComponent(name) }));
  return { release: { tag_name: tag, body: "", assets }, checksums };
}
async function releaseFromApi() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", ...UA }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("api.github.com: HTTP " + res.status + (res.status === 403 ? " (rate limit)" : ""));
  const release = await res.json();
  let checksums = {};
  const checksumAsset = (release.assets || []).find((a) => a.name === "checksums.json");
  if (checksumAsset) {
    try {
      const r = await fetch(checksumAsset.browser_download_url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.ok) checksums = await r.json();
    } catch (_) {}
  }
  return { release, checksums };
}

async function fetchLatestRelease({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;
  let found = null;
  const errors = [];
  for (const [via, get] of [["github.com", releaseFromDownloads], ["api.github.com", releaseFromApi]]) {
    try { found = { ...(await get()), via }; break; } catch (err) { errors.push(String(err && err.message || err)); }
  }
  _feed.checkedAt = new Date().toISOString();
  // GitHub unreachable: keep serving the last good catalog rather than an
  // empty one (DSM would show "no update" until the next poll).
  if (!found) {
    _feed.error = errors.join(" · ");
    if (_cache) return _cache.data;
    throw new Error(_feed.error);
  }
  _feed.error = null; _feed.tag = found.release.tag_name; _feed.via = found.via;
  // "What's new" in Package Center: the summary + changes from release.json
  // at that tag (the GitHub release body is generic install docs).
  let notes = null;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(found.release.tag_name)}/release.json`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (r.ok) notes = await r.json();
  } catch (_) {}
  const data = { release: found.release, checksums: found.checksums, notes };
  _cache = { at: Date.now(), data };
  return data;
}

// release.json → plain text: DSM shows the changelog as-is (markdown would
// come out raw), so it's the summary followed by " • "-separated changes.
export function changelogFromNotes(notes, fallback) {
  if (notes && (notes.summary || (Array.isArray(notes.changes) && notes.changes.length))) {
    return [notes.summary, ...(Array.isArray(notes.changes) ? notes.changes : [])].filter(Boolean).map(String).join(" • ").slice(0, 2000);
  }
  return String(fallback || "").slice(0, 2000);
}

// opts.link(asset) may swap the download URL (the NAS-local mirror below).
export function catalogFromRelease(release, checksums, bucket, notes = null, opts = {}) {
  const version = infoVersionFromTag(release && release.tag_name);
  if (!version || !bucket) return { packages: [] };
  const asset = (release.assets || []).find((a) => a.name.includes("-" + bucket + "-") && a.name.endsWith(".spk"));
  if (!asset) return { packages: [] };
  const sum = (checksums && checksums[asset.name]) || {};
  const pkg = {
    package: "coopeditor",
    version,
    dname: "Coopeditor",
    desc: PACKAGE_DESC,
    link: (opts.link && opts.link(asset)) || asset.browser_download_url,
    size: sum.size || asset.size || 0,
    thumbnail: [],
    snapshot: [],
    qinst: false,
    qupgrade: true,
    qstart: true,
    deppkgs: null,
    conflictpkgs: null,
    changelog: changelogFromNotes(notes, release.body),
    distributor: "namct2610",
    maintainer: "namct2610",
    support_url: "https://github.com/" + REPO + "/issues",
    beta: false,
    download_count: 0,
    recent_download_count: 0,
  };
  if (sum.md5) pkg.md5 = sum.md5;
  return { packages: [pkg] };
}

// ---- NAS-local mirror of the .spk -------------------------------------------
// Handing DSM the GitHub URL stalled Package Center at "1% Downloading": DSM's
// downloader has to follow a redirect to a short-lived signed CDN URL, and the
// NAS→CDN path can be slow. So the app downloads the release itself (Node
// fetch follows redirects; retried in the background), verifies md5/size, and
// only then advertises it with a link back to itself — DSM's download becomes
// a LAN copy. Until the mirror is ready the catalog is empty (the Update button
// appears once it can actually finish); after MAX_MIRROR_FAILURES it falls back
// to the GitHub link so updates can't get stuck behind a broken mirror.
export const SPK_NAME_RE = /^coopeditor-(x86_64|aarch64)-[0-9A-Za-z.+-]+\.spk$/;
const MAX_MIRROR_FAILURES = 3;
const MIRROR_RETRY_MS = 60_000;
// GitHub's asset CDN sometimes stops sending mid-file (seen in testing: stuck
// at ~650 KB of 81 MB). Abort when no byte arrives for this long, then retry.
export const MIRROR_IDLE_MS = 45_000;
const _mirror = new Map(); // name → { promise, failures, lastFailAt }

export async function mirrorPath(dir, name) {
  if (!dir || !SPK_NAME_RE.test(name)) return null;
  const path = join(dir, name);
  return (await stat(path).catch(() => null)) ? path : null; // present ⇒ verified (renamed only after the check)
}

export async function downloadSpk({ dir, name, url, md5, size, idleMs = MIRROR_IDLE_MS, onProgress }) {
  if (!SPK_NAME_RE.test(name)) throw new Error("bad spk name");
  await mkdir(dir, { recursive: true });
  const part = join(dir, name + ".part");
  const idle = new AbortController();
  let idleTimer = setTimeout(() => idle.abort(new Error("spk download stalled")), idleMs);
  const kick = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error("spk download stalled")), idleMs); };
  const hash = createHash("md5");
  let bytes = 0;
  const tap = new Transform({ transform(chunk, _e, cb) { kick(); hash.update(chunk); bytes += chunk.length; if (onProgress) onProgress(bytes); cb(null, chunk); } });
  try {
    const res = await fetch(url, { headers: { "user-agent": "coopeditor-spk-mirror" }, signal: AbortSignal.any([idle.signal, AbortSignal.timeout(30 * 60_000)]) });
    if (!res.ok || !res.body) throw new Error("spk download http " + res.status);
    await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(part));
    if (size && bytes !== Number(size)) throw new Error(`spk size mismatch: ${bytes} != ${size}`);
    if (md5 && hash.digest("hex") !== String(md5).toLowerCase()) throw new Error("spk md5 mismatch");
    await rename(part, join(dir, name));
  } catch (err) {
    await rm(part, { force: true });
    throw idle.signal.aborted ? idle.signal.reason : err;
  } finally {
    clearTimeout(idleTimer);
  }
  // keep only the newest .spk per arch
  const arch = name.match(SPK_NAME_RE)[1];
  for (const f of await readdir(dir)) {
    if (f !== name && SPK_NAME_RE.test(f) && f.match(SPK_NAME_RE)[1] === arch) await rm(join(dir, f), { force: true });
  }
  return join(dir, name);
}

function startMirror(dir, asset, sum) {
  const st = _mirror.get(asset.name) || { promise: null, failures: 0, lastFailAt: 0 };
  _mirror.set(asset.name, st);
  if (st.promise || (st.lastFailAt && Date.now() - st.lastFailAt < MIRROR_RETRY_MS)) return st;
  st.size = sum.size || asset.size || 0;
  st.bytes = 0;
  st.promise = downloadSpk({ dir, name: asset.name, url: asset.browser_download_url, md5: sum.md5, size: st.size, onProgress: (n) => { st.bytes = n; } })
    .then(() => { st.error = null; })
    .catch((err) => { st.failures += 1; st.lastFailAt = Date.now(); st.error = String(err && err.message || err); })
    .finally(() => { st.promise = null; });
  return st;
}

// opts.mirrorDir: enable the local mirror; opts.baseUrl: how DSM reached us
// (scheme://host[/api]) so the link it gets back is one it can reach.
export async function buildSpkCatalog(archParam, opts = {}) {
  const bucket = archBucket(archParam);
  if (!bucket) return { packages: [] };
  const { release, checksums, notes } = await fetchLatestRelease({ force: opts.force });
  if (!opts.mirrorDir || !opts.baseUrl) return catalogFromRelease(release, checksums, bucket, notes);
  const asset = (release.assets || []).find((a) => a.name.includes("-" + bucket + "-") && a.name.endsWith(".spk"));
  if (!asset) return { packages: [] };
  if (await mirrorPath(opts.mirrorDir, asset.name)) {
    return catalogFromRelease(release, checksums, bucket, notes, { link: (a) => opts.baseUrl + "/spkserver/spk/" + encodeURIComponent(a.name) });
  }
  const st = startMirror(opts.mirrorDir, asset, (checksums && checksums[asset.name]) || {});
  if (st.failures >= MAX_MIRROR_FAILURES) return catalogFromRelease(release, checksums, bucket, notes);
  return { packages: [], preparing: asset.name };
}

// Warm the mirror for this machine's own arch so the update is usually ready
// before anyone opens Package Center.
export function warmSpkMirror(mirrorDir) {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch) return;
  buildSpkCatalog(arch, { mirrorDir, baseUrl: "http://local" }).catch(() => {});
}

// What Package Center would get for this machine's arch right now, and why —
// shown in Cài đặt → Cập nhật so an empty catalog isn't a silent mystery.
export async function packageFeedStatus(mirrorDir, { force = false } = {}) {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  const out = { arch, offered: null, tag: null, via: null, checkedAt: null, error: null, mirror: null };
  try {
    const cat = await buildSpkCatalog(arch || "", { mirrorDir, baseUrl: "http://local", force });
    const pkg = (cat.packages || [])[0];
    out.offered = pkg ? pkg.version : null;
    if (cat.preparing) {
      const st = _mirror.get(cat.preparing) || {};
      out.mirror = { name: cat.preparing, state: st.promise ? "downloading" : st.error ? "failed" : "waiting", bytes: st.bytes || 0, size: st.size || 0, failures: st.failures || 0, error: st.error || null };
    } else if (pkg) {
      out.mirror = { state: pkg.link.startsWith("http://local/") ? "ready" : "github" };
    }
  } catch (err) {
    out.error = String(err && err.message || err);
  }
  Object.assign(out, { tag: _feed.tag, via: _feed.via, checkedAt: _feed.checkedAt, error: out.error || _feed.error });
  return out;
}
