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

const REPO = process.env.SPK_FEED_REPO || "namct2610/coopeditor";
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
async function fetchLatestRelease() {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "coopeditor-spk-feed" },
  }).catch(() => null);
  // GitHub down / rate-limited: keep serving the last good catalog rather
  // than an empty one (DSM would show "no update" until the next poll).
  if (!res || !res.ok) {
    if (_cache) return _cache.data;
    throw new Error("github_release_http_" + (res ? res.status : "network"));
  }
  const release = await res.json();
  let checksums = {};
  const checksumAsset = (release.assets || []).find((a) => a.name === "checksums.json");
  if (checksumAsset) {
    try {
      const r = await fetch(checksumAsset.browser_download_url, { headers: { "user-agent": "coopeditor-spk-feed" } });
      if (r.ok) checksums = await r.json();
    } catch (_) {}
  }
  const data = { release, checksums };
  _cache = { at: Date.now(), data };
  return data;
}

export function catalogFromRelease(release, checksums, bucket) {
  const version = infoVersionFromTag(release && release.tag_name);
  if (!version || !bucket) return { packages: [] };
  const asset = (release.assets || []).find((a) => a.name.includes("-" + bucket + "-") && a.name.endsWith(".spk"));
  if (!asset) return { packages: [] };
  const sum = (checksums && checksums[asset.name]) || {};
  const pkg = {
    package: "coopeditor",
    version,
    dname: "Coopeditor",
    desc: "Frame.io-style review studio for video editors, native on DSM.",
    link: asset.browser_download_url,
    size: sum.size || asset.size || 0,
    thumbnail: [],
    snapshot: [],
    qinst: false,
    qupgrade: true,
    qstart: true,
    deppkgs: null,
    conflictpkgs: null,
    changelog: String(release.body || "").slice(0, 1000),
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

export async function buildSpkCatalog(archParam) {
  const bucket = archBucket(archParam);
  if (!bucket) return { packages: [] };
  const { release, checksums } = await fetchLatestRelease();
  return catalogFromRelease(release, checksums, bucket);
}
