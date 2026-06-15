// DSM (Synology DiskStation) API client.
//
// Auth flow: SYNO.API.Auth login → sid (cookie-style session token).
// FileStation calls reuse the same sid via ?_sid=...&SynoToken=... when needed.
//
// Config via env:
//   DSM_HOST=https://dsm.example.com:5001
//   DSM_INSECURE=1   (skip TLS verify; only for self-signed dev)
//   DSM_DEV_LOGIN=1  (offline dev: accept any account/passwd; useful when DSM is not reachable)

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DSM_HOST = process.env.DSM_HOST || "";
const DSM_DEV_LOGIN = process.env.DSM_DEV_LOGIN === "1";
const DSM_MOUNT_ROOT = process.env.DSM_MOUNT_ROOT || "";
const DSM_FETCH_TIMEOUT_MS = Math.max(3000, Number.parseInt(process.env.DSM_FETCH_TIMEOUT_MS || "15000", 10) || 15000);
if (process.env.DSM_INSECURE === "1") {
  // dev-only escape hatch for self-signed DSM certs
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export function isDevMode() { return DSM_DEV_LOGIN || !DSM_HOST; }

async function dsmGet(path, params) {
  if (!DSM_HOST) throw new Error("DSM_HOST not configured");
  const u = new URL(DSM_HOST.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const signal = AbortSignal.timeout ? AbortSignal.timeout(DSM_FETCH_TIMEOUT_MS) : undefined;
  let res;
  try {
    res = await fetch(u, { signal });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error("DSM request timed out after " + DSM_FETCH_TIMEOUT_MS + "ms");
    }
    throw err;
  }
  if (!res.ok) throw new Error("DSM HTTP " + res.status);
  return res.json();
}

// Returns { ok, sid, uid, name, email } OR { needsOtp: true } OR { error }
export async function dsmLogin({ account, passwd, otp_code }) {
  if (isDevMode()) {
    // dev shim: accept anything, fake a stable uid based on the username
    const uid = (account || "dev").split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 10000 + 1000;
    return { ok: true, sid: "dev-sid-" + account, uid, name: account || "Dev User", email: account + "@dev.local" };
  }
  const params = {
    api: "SYNO.API.Auth", version: "6", method: "login",
    account, passwd, session: "FileStation", format: "sid",
    enable_syno_token: "yes",
  };
  if (otp_code) params.otp_code = otp_code;
  const body = await dsmGet("/webapi/auth.cgi", params);
  if (body && body.success && body.data && body.data.sid) {
    // Fetch user info — DSM exposes it via SYNO.Core.User or SYNO.API.OTP; use Core.User.
    let name = account, email = undefined, uid = 0;
    try {
      const info = await dsmGet("/webapi/entry.cgi", {
        api: "SYNO.Core.NormalUser", version: "1", method: "get", _sid: body.data.sid,
      });
      if (info && info.success && info.data) {
        name = info.data.username || account;
        email = info.data.email;
        uid = info.data.uid || 0;
      }
    } catch (_) {}
    return { ok: true, sid: body.data.sid, uid, name, email };
  }
  const code = body && body.error && body.error.code;
  // DSM 2FA codes:
  //   403 = OTP code required (first attempt without otp_code)
  //   404 = OTP code invalid (second attempt với otp_code sai)
  //   400 = account/password invalid
  //   401 = "guest account disabled" / no permission
  //   407 = IP banned by auto-block
  if (code === 403) return { needsOtp: true };
  if (code === 404) return { needsOtp: true, otpInvalid: true, error: "Mã OTP sai hoặc đã hết hạn — thử mã mới" };
  if (code === 400) return { error: "Tài khoản hoặc mật khẩu DSM không đúng" };
  if (code === 407) return { error: "IP đã bị DSM chặn tự động — đăng nhập vào DSM gỡ chặn trước" };
  return { error: "DSM login failed (code " + (code || "?") + ")" };
}

export async function dsmLogout(sid) {
  if (isDevMode() || !sid) return;
  try {
    await dsmGet("/webapi/auth.cgi", {
      api: "SYNO.API.Auth", version: "6", method: "logout", session: "FileStation", _sid: sid,
    });
  } catch (_) {}
}

// List a NAS folder using the user's sid. Returns NasListing-shaped object.
export async function dsmListFolder(sid, path) {
  if (isDevMode()) return devNasListing(path);
  if (path === "/") {
    // top level: list shared folders
    const body = await dsmGet("/webapi/entry.cgi", {
      api: "SYNO.FileStation.List", version: "2", method: "list_share", _sid: sid,
      additional: '["real_path","size"]',
    });
    if (!body || !body.success) throw new Error("FileStation list_share failed");
    return {
      path: "/",
      crumbs: [{ label: "/", path: "/" }],
      entries: (body.data.shares || []).map((s) => ({ type: "folder", name: s.name, path: s.path, childCount: 0 })),
    };
  }
  const body = await dsmGet("/webapi/entry.cgi", {
    api: "SYNO.FileStation.List", version: "2", method: "list", _sid: sid,
    folder_path: path, additional: '["size","type"]',
  });
  if (!body || !body.success) throw new Error("FileStation list failed");
  const entries = (body.data.files || []).map((f) => {
    if (f.isdir) return { type: "folder", name: f.name, path: f.path, childCount: 0 };
    const ext = f.name.split(".").pop().toLowerCase();
    const codec = /mov|mp4|mxf/.test(ext) ? "ProRes 422" : ext.toUpperCase();
    return { type: "file", name: f.name, path: f.path, sizeLabel: humanSize(f.additional && f.additional.size), codec, durationMs: 0 };
  });
  return { path, crumbs: buildCrumbs(path), entries };
}

export async function getFileMeta(sid, path) {
  if (isDevMode()) {
    const file = devLookupFile(path);
    if (!file || file.type !== "file") return null;
    return {
      type: "file",
      name: file.name,
      path,
      bytes: parseHumanSize(file.sizeLabel),
      sizeLabel: file.sizeLabel,
      codec: file.codec,
      durationMs: file.durationMs,
    };
  }

  const entry = await dsmGetFileEntry(sid, path);
  if (!entry) return null;

  const bytes = Number(entry.additional && entry.additional.size) || 0;
  const meta = {
    type: "file",
    name: entry.name,
    path,
    bytes,
    sizeLabel: humanSize(bytes),
    codec: guessCodecFromName(entry.name),
    durationMs: 0,
  };

  const probePath = resolveProbePath(path, entry.additional && entry.additional.real_path);
  if (!probePath) return meta;

  try {
    const probed = await ffprobeFile(probePath);
    return {
      ...meta,
      codec: probed.codec || meta.codec,
      durationMs: probed.durationMs || 0,
    };
  } catch (_) {
    return meta;
  }
}

function buildCrumbs(path) {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  let acc = "";
  const crumbs = [{ label: "/", path: "/" }];
  for (const p of parts) { acc += "/" + p; crumbs.push({ label: p, path: acc }); }
  return crumbs;
}
function humanSize(bytes) {
  if (!bytes) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + u[i];
}

function parseHumanSize(label) {
  if (!label || label === "—") return 0;
  const match = String(label).trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return Math.round(Number(match[1]) * 1024 ** powers[match[2].toUpperCase()]);
}

async function dsmGetFileEntry(sid, path) {
  const parent = path.replace(/\/[^/]+$/, "") || "/";
  const body = await dsmGet("/webapi/entry.cgi", {
    api: "SYNO.FileStation.List",
    version: "2",
    method: "list",
    _sid: sid,
    folder_path: parent,
    additional: '["real_path","size","type"]',
  });
  if (!body || !body.success) throw new Error("FileStation list failed");
  return (body.data.files || []).find((file) => file.path === path && !file.isdir) || null;
}

function resolveProbePath(dsmPath, realPath) {
  if (DSM_MOUNT_ROOT) return DSM_MOUNT_ROOT.replace(/\/+$/, "") + dsmPath;
  if (realPath && realPath.startsWith("/")) return realPath;
  return null;
}

function guessCodecFromName(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (ext === "mov") return "ProRes 422";
  if (ext === "mp4") return "H.264";
  if (ext === "mxf") return "MXF";
  return ext.toUpperCase() || "unknown";
}

async function ffprobeFile(path) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,codec_name",
    "-of", "json",
    path,
  ]);
  const data = JSON.parse(stdout || "{}");
  const video = (data.streams || []).find((stream) => stream.codec_type === "video");
  const durationSec = Number(data.format && data.format.duration) || 0;
  return {
    codec: normalizeCodec(video && video.codec_name),
    durationMs: Math.round(durationSec * 1000),
  };
}

function normalizeCodec(codecName) {
  if (!codecName) return "";
  if (codecName === "prores") return "ProRes";
  if (codecName === "hevc") return "H.265";
  if (codecName === "h264") return "H.264";
  return String(codecName).toUpperCase();
}

// --- dev shim NAS tree (mirrors the frontend NAS_TREE so dev login still works end-to-end) ---
const DEV_TREE = {
  name: "/", type: "folder", children: [
    { type: "folder", name: "Footage", children: [
      { type: "folder", name: "TVC Q3 2026", children: [
        { type: "folder", name: "Hero", children: [
          { type: "file", name: "Hero_take7.mov", sizeLabel: "52.1 GB", codec: "ProRes 422 HQ", durationMs: 148000 },
          { type: "file", name: "Hero_take8.mov", sizeLabel: "49.3 GB", codec: "ProRes 422 HQ", durationMs: 151000 },
          { type: "file", name: "Balcony_dusk_take5.mov", sizeLabel: "60.2 GB", codec: "ProRes 4444", durationMs: 69000 },
        ] },
        { type: "folder", name: "Product", children: [
          { type: "file", name: "Product_U05_demo_v3.mov", sizeLabel: "33.0 GB", codec: "ProRes 422", durationMs: 96000 },
          { type: "file", name: "Product_S038_demo.mov", sizeLabel: "28.4 GB", codec: "ProRes 422", durationMs: 88000 },
        ] },
        { type: "folder", name: "Interview", children: [
          { type: "file", name: "CEO_master_reel.mov", sizeLabel: "110 GB", codec: "ProRes 422 HQ", durationMs: 312000 },
        ] },
        { type: "file", name: "Slate_reference.mov", sizeLabel: "2.1 GB", codec: "ProRes 422", durationMs: 12000 },
      ] },
      { type: "folder", name: "Product Launch U05", children: [
        { type: "file", name: "Launch_film_master.mov", sizeLabel: "74.5 GB", codec: "ProRes 4444", durationMs: 205000 },
        { type: "file", name: "Teaser_15s.mov", sizeLabel: "5.8 GB", codec: "ProRes 422", durationMs: 15000 },
      ] },
      { type: "folder", name: "Archive 2025", children: [
        { type: "file", name: "Brand_sizzle_2025.mov", sizeLabel: "41.2 GB", codec: "H.265", durationMs: 124000 },
      ] },
    ] },
  ],
};

function devNasListing(path) {
  const segs = path.replace(/^\/+/, "").split("/").filter(Boolean);
  let node = DEV_TREE;
  for (const s of segs) {
    const child = (node.children || []).find((c) => c.name === s);
    if (!child) return { path, crumbs: buildCrumbs(path), entries: [] };
    node = child;
  }
  return {
    path,
    crumbs: buildCrumbs(path),
    entries: (node.children || []).map((c) => {
      const childPath = (path === "/" ? "" : path) + "/" + c.name;
      if (c.type === "folder") return { type: "folder", name: c.name, path: childPath, childCount: (c.children || []).length };
      return { type: "file", name: c.name, path: childPath, sizeLabel: c.sizeLabel, codec: c.codec, durationMs: c.durationMs };
    }),
  };
}

export function devLookupFile(path) {
  const segs = path.replace(/^\/+/, "").split("/").filter(Boolean);
  let node = DEV_TREE;
  for (const s of segs) {
    const child = (node.children || []).find((c) => c.name === s);
    if (!child) return null;
    node = child;
  }
  return node;
}
