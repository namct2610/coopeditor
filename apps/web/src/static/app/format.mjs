// Labels, colours and formatting shared by every screen.

// Editorial status of a video — same five colours everywhere (cards, filters,
// calendar bars, review header).
export const ST = {
  edit: { label: "Đang dựng", c: "var(--s-edit)" },
  wait: { label: "Chờ duyệt", c: "var(--s-wait)" },
  fix: { label: "Cần sửa", c: "var(--s-fix)" },
  ok: { label: "Đã duyệt", c: "var(--s-ok)" },
  air: { label: "Đã lên sóng", c: "var(--s-air)" },
};
export const ORDER = ["edit", "wait", "fix", "ok", "air"];
// Status lives on the project and follows its final video (see server.js
// projectStatus); FST is the same map, kept for the Final screens.
export const FST = ST;

export const SST = {
  draft: { label: "Nháp", c: "var(--s-edit)" },
  review: { label: "Chờ duyệt", c: "var(--s-wait)" },
  approved: { label: "Đã duyệt", c: "var(--s-ok)" },
};

// Project roles in the API → wording used in the UI.
export const ROLE_LABEL = { owner: "Chủ dự án", editor: "Quản lý", reviewer: "Ghi chú", client: "Xem" };
export const ROLE_OPTS = [["client", "Xem"], ["reviewer", "Ghi chú"], ["editor", "Quản lý"]];

export const HUES = [["Tím", 285], ["Cam", 45], ["Xanh dương", 245], ["Xanh lục", 160]];

export const tint = (c, p) => `color-mix(in oklch, ${c} ${p}%, transparent)`;
export const pillStyle = (c) => `background:${tint(c, 16)};color:${c}`;

export const PAL = [["#24343a", "#6f8b85"], ["#3b2a20", "#b0794b"], ["#1e2838", "#5876a3"], ["#2c2925", "#8c8070"], ["#36202c", "#a05a72"], ["#2c3120", "#8a9752"], ["#1d2e2c", "#4c877c"], ["#272240", "#7066ab"]];

function hashStr(s) { let h = 5381; for (const ch of String(s || "")) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h; }
export function palFor(key) { return PAL[hashStr(key) % PAL.length]; }

// Editorial placeholder behind every thumbnail: the real poster loads on top.
export function thumbBg(a, b) {
  return `repeating-linear-gradient(135deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 9px), radial-gradient(120% 90% at 28% 18%, rgba(255,255,255,0.13), transparent 60%), linear-gradient(155deg, ${a}, ${b})`;
}
export const flatBg = (a, b) => `linear-gradient(155deg, ${a}, ${b})`;
export const AUDIO_BG = "repeating-linear-gradient(90deg, rgba(255,255,255,0.10) 0 2px, transparent 2px 6px), linear-gradient(155deg, #1c1c1a, #3a3934)";

// The backend's palettes are dark navy pairs from the old UI; remap by key so
// cards get the warmer v2 palette while staying stable per project/video.
export function paletteOf(entity) {
  return palFor((entity && entity.id) || "");
}

// ---- people ----
export function shortName(name) {
  const parts = String(name || "?").replace(/[·—-].*$/, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
export function avatarBg(key) { return `oklch(0.80 0.08 ${hashStr(key) % 360})`; }

// ---- time ----
const p2 = (n) => String(n).padStart(2, "0");
export { p2 };
export function fmtTc(ms, fps = 24) {
  const f = fps > 0 ? fps : 24;
  const totalFrames = Math.max(0, Math.round((ms / 1000) * f));
  const ff = totalFrames % Math.round(f);
  const s = Math.floor(totalFrames / Math.round(f));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}:${p2(ff)}`;
}
export function fmtShort(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}` : `${Math.floor(s / 60)}:${p2(s % 60)}`;
}
export const fmtDur = fmtShort;

export function parseIso(v) {
  if (!v) return null;
  // SQLite's datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? v.replace(" ", "T") + "Z" : v;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}
// "8 phút trước" style. Legacy rows store free text in updated_at
// ("vừa xong", "12 phút trước") — those pass through untouched.
export function fmtAgo(v, { suffix = true } = {}) {
  const d = parseIso(v);
  if (!d) return v ? String(v) : "";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  const tail = suffix ? " trước" : "";
  if (sec < 60) return "vừa xong";
  if (sec < 3600) return Math.floor(sec / 60) + " phút" + tail;
  if (sec < 86400) return Math.floor(sec / 3600) + " giờ" + tail;
  const days = Math.floor(sec / 86400);
  if (days === 1) return "hôm qua";
  if (days < 7) return days + " ngày" + tail;
  return dm(d);
}

export const WD = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
export const WD_LONG = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
export const dm = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
export const isoDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export function dayFromIso(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); }
export const daysBetween = (a, b) => Math.round((b - a) / 864e5);
export function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function todayLabel() { const t = today(); return WD_LONG[t.getDay()].toUpperCase() + " · " + dm(t) + "/" + t.getFullYear(); }

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + " TB";
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + " GB";
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + " MB";
  return Math.round(b / 1024) + " KB";
}

export function resLabel(a) {
  if (!a) return "";
  if (a.resolutionLabel) return a.resolutionLabel;
  const h = a.height || 0, w = a.width || 0;
  if (h >= 2160 || w >= 3840) return "4K";
  if (h >= 1080) return "HD";
  return h ? h + "p" : "";
}
export function isAudio(a) { return /\.(wav|aif|aiff|mp3|m4a|flac)$/i.test((a && (a.nasPath || a.title)) || ""); }

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
