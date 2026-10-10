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
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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

// A single connection to GitHub's asset CDN is slow from here (and a drop
// meant starting the 80 MB over), so the file is fetched as 8 MB ranges over
// a few connections at once; a range that fails is fetched again on its own.
// Servers that ignore Range get the plain one-stream download.
const PARALLEL = 4;
const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_TRIES = 4;
const MIRROR_UA = { "user-agent": "coopeditor-spk-mirror" };
const stalled = () => new Error("spk download stalled");

async function streamDownload(url, part, { idleMs, onProgress }) {
  const idle = new AbortController();
  let idleTimer = setTimeout(() => idle.abort(stalled()), idleMs);
  const kick = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(stalled()), idleMs); };
  const hash = createHash("md5");
  let bytes = 0;
  const tap = new Transform({ transform(chunk, _e, cb) { kick(); hash.update(chunk); bytes += chunk.length; if (onProgress) onProgress(bytes); cb(null, chunk); } });
  try {
    const res = await fetch(url, { headers: MIRROR_UA, signal: AbortSignal.any([idle.signal, AbortSignal.timeout(30 * 60_000)]) });
    if (!res.ok || !res.body) throw new Error("spk download http " + res.status);
    await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(part));
    return { bytes, md5: hash.digest("hex") };
  } catch (err) {
    throw idle.signal.aborted ? idle.signal.reason : err;
  } finally {
    clearTimeout(idleTimer);
  }
}

async function rangedDownload(url, part, size, { idleMs, onProgress, parallel, chunkBytes }) {
  const chunks = [];
  for (let a = 0; a < size; a += chunkBytes) chunks.push([a, Math.min(size, a + chunkBytes) - 1]);
  const got = new Array(chunks.length).fill(0);
  const report = () => { if (onProgress) onProgress(got.reduce((x, y) => x + y, 0)); };
  const stop = new AbortController();
  const fh = await open(part, "w");
  try {
    await fh.truncate(size);
    const fetchChunk = async (i) => {
      const [a, b] = chunks[i];
      for (let attempt = 1; ; attempt++) {
        const idle = new AbortController();
        let t = setTimeout(() => idle.abort(stalled()), idleMs);
        const kick = () => { clearTimeout(t); t = setTimeout(() => idle.abort(stalled()), idleMs); };
        let pos = a;
        got[i] = 0;
        try {
          const res = await fetch(url, { headers: { ...MIRROR_UA, range: "bytes=" + a + "-" + b }, signal: AbortSignal.any([idle.signal, stop.signal]) });
          if (res.status === 200) {
            if (res.body) res.body.cancel().catch(() => {});
            throw Object.assign(new Error("no range support"), { noRange: true });
          }
          if (res.status !== 206 || !res.body) throw new Error("spk download http " + res.status);
          for await (const data of res.body) {
            kick();
            if (pos + data.length > b + 1) throw new Error("spk range overflow");
            await fh.write(data, 0, data.length, pos);
            pos += data.length;
            got[i] = pos - a;
            report();
          }
          if (pos !== b + 1) throw new Error("spk range cut short");
          return;
        } catch (err) {
          const e = idle.signal.aborted ? idle.signal.reason : err;
          if (e.noRange || stop.signal.aborted || attempt >= CHUNK_TRIES) throw e;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        } finally {
          clearTimeout(t);
        }
      }
    };
    let next = 0, failure = null;
    const worker = async () => {
      while (!failure && next < chunks.length) {
        const i = next++;
        try { await fetchChunk(i); } catch (err) { if (!failure) { failure = err; stop.abort(err); } }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
    if (failure) throw failure;
  } finally {
    await fh.close();
  }
  const hash = createHash("md5");
  for await (const data of createReadStream(part)) hash.update(data);
  return { bytes: (await stat(part)).size, md5: hash.digest("hex") };
}

export async function downloadSpk({ dir, name, url, md5, size, idleMs = MIRROR_IDLE_MS, onProgress, parallel = PARALLEL, chunkBytes = CHUNK_BYTES }) {
  if (!SPK_NAME_RE.test(name)) throw new Error("bad spk name");
  await mkdir(dir, { recursive: true });
  const part = join(dir, name + ".part");
  try {
    let got = null;
    if (size && Number(size) > chunkBytes && parallel > 1) {
      try { got = await rangedDownload(url, part, Number(size), { idleMs, onProgress, parallel, chunkBytes }); }
      catch (err) { if (!err.noRange) throw err; await rm(part, { force: true }); }
    }
    if (!got) got = await streamDownload(url, part, { idleMs, onProgress });
    if (size && got.bytes !== Number(size)) throw new Error(`spk size mismatch: ${got.bytes} != ${size}`);
    if (md5 && got.md5 !== String(md5).toLowerCase()) throw new Error("spk md5 mismatch");
    await rename(part, join(dir, name));
  } catch (err) {
    await rm(part, { force: true });
    throw err;
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

// The version this NAS runs (release.json), as a catalog entry. Package
// Center hides its whole Community tab when the sources list nothing, so the
// feed falls back to this while a newer release is still on its way to the
// mirror, or GitHub can't be reached: the package stays listed (as installed)
// and Update appears once the new one is ready.
export function currentCatalog(bucket, current) {
  const label = String((current && current.version) || "").trim().replace(/^v/, "");
  if (!bucket || !infoVersionFromTag(label)) return { packages: [] };
  const tag = "v" + label.replace(/-(?:spk-)?rc(\d+)$/, "-spk-rc$1");
  const name = "coopeditor-" + bucket + "-" + tag.slice(1) + ".spk";
  const asset = { name, size: 0, browser_download_url: `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` };
  return catalogFromRelease({ tag_name: tag, body: "", assets: [asset] }, {}, bucket, current);
}

// This machine's own arch: the NAS asking is almost always the one serving
// the feed, so an arch codename missing from the lists above still works.
const OWN_BUCKET = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;

// opts.mirrorDir: enable the local mirror; opts.baseUrl: how DSM reached us
// (scheme://host[/api]) so the link it gets back is one it can reach;
// opts.current: the running release (release.json), listed while there's
// nothing newer to offer yet.
export async function buildSpkCatalog(archParam, opts = {}) {
  const bucket = archBucket(archParam) || OWN_BUCKET;
  if (!bucket) return { packages: [] };
  const fallback = (extra) => ({ ...(opts.current ? currentCatalog(bucket, opts.current) : { packages: [] }), ...extra });
  let latest;
  try { latest = await fetchLatestRelease({ force: opts.force }); }
  catch (err) {
    if (opts.current) return fallback({ error: String(err && err.message || err) });
    throw err;
  }
  const { release, checksums, notes } = latest;
  if (!opts.mirrorDir || !opts.baseUrl) return catalogFromRelease(release, checksums, bucket, notes);
  const asset = (release.assets || []).find((a) => a.name.includes("-" + bucket + "-") && a.name.endsWith(".spk"));
  if (!asset) return fallback();
  if (await mirrorPath(opts.mirrorDir, asset.name)) {
    return catalogFromRelease(release, checksums, bucket, notes, { link: (a) => opts.baseUrl + "/spkserver/spk/" + encodeURIComponent(a.name) });
  }
  const st = startMirror(opts.mirrorDir, asset, (checksums && checksums[asset.name]) || {});
  if (st.failures >= MAX_MIRROR_FAILURES) return catalogFromRelease(release, checksums, bucket, notes);
  return fallback({ preparing: asset.name });
}

// Warm the mirror for this machine's own arch so the update is usually ready
// before anyone opens Package Center.
export function warmSpkMirror(mirrorDir) {
  if (!OWN_BUCKET) return;
  buildSpkCatalog(OWN_BUCKET, { mirrorDir, baseUrl: "http://local" }).catch(() => {});
}

// What Package Center would get for this machine's arch right now, and why —
// shown in Cài đặt → Cập nhật so an empty catalog isn't a silent mystery.
export async function packageFeedStatus(mirrorDir, { force = false, current = null } = {}) {
  const arch = OWN_BUCKET;
  const out = { arch, offered: null, tag: null, via: null, checkedAt: null, error: null, mirror: null };
  try {
    const cat = await buildSpkCatalog(arch || "", { mirrorDir, baseUrl: "http://local", force, current });
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
