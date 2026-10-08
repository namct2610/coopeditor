// Sketch editor on the video frame: a rough "draft editor" so a note can show
// the idea, not just point at it — text (subtitle, title, lower third), boxes,
// placeholders for B-roll/logo, reframe guides (9:16, 1:1…), blur regions,
// images, arrows and freehand. Everything is drawn rough on top of the frame;
// nothing is rendered into the video.
//
// Coordinates are normalized 0..1 over the 16:9 stage; lengths (stroke width,
// font size) are pixels on a 1280×720 reference frame and scale with the
// stage through container units, so the same sketch renders on the stage, in
// a note's thumbnail and on any screen size. Payload is validated by
// apps/api/src/annotation.js.

import { html, useState, useEffect, useLayoutEffect, useRef } from "./lib.mjs";
import { clamp } from "./format.mjs";
import { mediaUrl, enc, post } from "./api.mjs";
import { S, toast, errMsg } from "./store.mjs";
import { Menu, MenuItem, useContextMenu, ContextMenu } from "./ui.mjs";

const RW = 1280, RH = 720;
const U = (n) => `calc(${n} * 100cqh / ${RH})`;
const r3 = (n) => Math.round(n * 1000) / 1000;
const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_ITEMS = 80;

export const COLORS = ["#f0644f", "#e9b949", "#5ac48a", "#4c9aff", "#b48cff", "#ffffff", "#141413"];
const WIDTHS = { pen: [3, 6, 12], highlight: [18, 30, 48], line: [3, 6, 10], arrow: [3, 6, 10], rect: [2, 4, 8], ellipse: [2, 4, 8] };
const SIZES = [["24", "S"], ["36", "M"], ["56", "L"], ["84", "XL"]];
const RATIOS = [["9:16", "9:16"], ["1:1", "1:1"], ["4:5", "4:5"], ["16:9", "16:9"], ["free", "Tự do"]];
const ratioN = (r) => { const m = /^(\d+):(\d+)$/.exec(r || ""); return m ? (m[1] / m[2]) * (RH / RW) : 0; };
// Text, placeholders and reframe guides read best in white; marks in red.
const colorKey = (type) => (type === "text" || type === "placeholder" || type === "frame" ? "tcolor" : "color");

const DEFAULT_PROPS = { color: COLORS[0], tcolor: "#ffffff", wi: 1, fill: "none", size: 36, bold: true, style: "shadow", align: "left", ratio: "9:16", dim: true, opacity: 1 };

export const TOOLS = [
  { k: "select", label: "Chọn & di chuyển", key: "V" },
  { k: "pen", label: "Bút", key: "P" },
  { k: "highlight", label: "Bút dạ quang", key: "H" },
  { k: "arrow", label: "Mũi tên", key: "A" },
  { k: "line", label: "Đường thẳng", key: "L" },
  { k: "rect", label: "Khung chữ nhật", key: "R" },
  { k: "ellipse", label: "Elip", key: "O" },
  { k: "text", label: "Chữ", key: "T" },
  { k: "image", label: "Chèn ảnh (hoặc dán / kéo thả)", key: "I" },
  { k: "placeholder", label: "Ô giữ chỗ — B-roll, logo, đồ hoạ", key: "N" },
  { k: "frame", label: "Khung crop — 9:16, 1:1, 4:5", key: "F" },
  { k: "blur", label: "Vùng che mờ", key: "B" },
];
const SHORTCUTS = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.k]));
// "Chèn ảnh (hoặc dán…)" → "Chèn ảnh": the tool's name as an object's name.
const typeLabel = (type) => { const t = TOOLS.find((x) => x.k === type); return t ? t.label.split(/ \(| — /)[0] : "Đối tượng"; };
const MOD = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl ";

const frameAt = (ratio, h = 1) => { const w = Math.min(1, h * ratioN(ratio)); return { type: "frame", x: r3((1 - w) / 2), y: r3((1 - h) / 2), w: r3(w), h, color: "#ffffff", ratio, dim: true }; };
export const TEMPLATES = [
  { label: "Phụ đề", hint: "giữa, dưới", make: () => [{ type: "text", x: 0.1, y: 0.82, w: 0.8, align: "center", style: "box", size: 34, bold: false, color: "#ffffff", text: "Phụ đề hiển thị ở đây" }] },
  { label: "Tiêu đề lớn", hint: "giữa khung", make: () => [{ type: "text", x: 0.1, y: 0.4, w: 0.8, align: "center", style: "shadow", size: 84, bold: true, color: "#ffffff", text: "TIÊU ĐỀ" }] },
  { label: "Lower third", hint: "tên + chức danh", make: () => [
    { type: "text", x: 0.06, y: 0.7, style: "fill", size: 34, bold: true, color: "#e9b949", text: "Nguyễn Văn A" },
    { type: "text", x: 0.06, y: 0.785, style: "box", size: 24, bold: false, color: "#ffffff", text: "Đạo diễn hình ảnh" },
  ] },
  { label: "Logo góc", hint: "trên, phải", make: () => [{ type: "placeholder", x: 0.83, y: 0.06, w: 0.11, h: 0.13, color: "#ffffff", text: "LOGO" }] },
  { label: "Chèn B-roll", hint: "ô giữ chỗ", make: () => [{ type: "placeholder", x: 0.2, y: 0.15, w: 0.6, h: 0.7, color: "#ffffff", text: "B-roll" }] },
  { label: "Hình trong hình", hint: "PiP 16:9", make: () => [{ type: "placeholder", x: 0.64, y: 0.6, w: 0.32, h: 0.32, color: "#4c9aff", text: "PiP" }] },
  { sep: true },
  { label: "Crop dọc 9:16", hint: "Reels · TikTok", make: () => [frameAt("9:16")] },
  { label: "Crop vuông 1:1", hint: "", make: () => [frameAt("1:1")] },
  { label: "Crop 4:5", hint: "feed", make: () => [frameAt("4:5")] },
  { sep: true },
  { label: "Che mờ", hint: "logo, biển số…", make: () => [{ type: "blur", x: 0.42, y: 0.38, w: 0.16, h: 0.24 }] },
];

// ---------------------------------------------------------------------------
// Old notes stored { strokes, texts }; show them through the same renderer.
export function sketchItems(a) {
  if (!a) return [];
  const out = [];
  (a.strokes || []).forEach((s, i) => {
    const pts = s.points || [];
    if (!pts.length) return;
    const p = pts[0], q = pts[pts.length - 1];
    const base = { id: "ls" + i, color: s.color || COLORS[0] };
    if (s.tool === "rect" || s.tool === "ellipse") {
      out.push({ ...base, type: s.tool, x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1]), width: s.width || 3, fill: "none" });
    } else if (s.tool === "arrow") out.push({ ...base, type: "arrow", width: s.width || 3, points: [p, q] });
    else if (s.tool === "highlight") out.push({ ...base, type: "highlight", width: (s.width || 3) * 6, points: pts });
    else out.push({ ...base, type: "pen", width: s.width || 3, points: pts });
  });
  (a.texts || []).forEach((t, i) => out.push({ id: "lt" + i, type: "text", x: t.x, y: Math.max(0, t.y - 0.024), color: t.color, text: t.text, size: 22, bold: true, style: "box", align: "left" }));
  return out.concat(a.items || []);
}
export const hasSketch = (a) => sketchItems(a).length > 0;
const imageUrl = (vid, src) => (vid && src ? mediaUrl("/asset-versions/" + enc(vid) + "/annotation-images/" + src) : "");

// ---------------------------------------------------------------------------
// renderer
const pathOf = (pts) => {
  const P = pts.map((p) => [p[0] * RW, p[1] * RH]);
  if (P.length < 3) return "M" + P.map((p) => p.join(" ")).join(" L");
  let d = "M" + P[0].join(" ");
  for (let i = 1; i < P.length - 1; i++) d += ` Q${P[i][0]} ${P[i][1]} ${(P[i][0] + P[i + 1][0]) / 2} ${(P[i][1] + P[i + 1][1]) / 2}`;
  return d + " L" + P[P.length - 1].join(" ");
};
const lum = (hex) => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const boxCss = (it) => `left:${it.x * 100}%;top:${it.y * 100}%;width:${it.w * 100}%;height:${it.h * 100}%;`;

export function textCss(it) {
  return `left:${it.x * 100}%;top:${it.y * 100}%;${it.w ? `width:${it.w * 100}%;` : `width:max-content;max-width:${(1 - it.x) * 100}%;`}text-align:${it.align || "left"};font-size:${U(it.size || 36)};font-weight:${it.bold ? 700 : 500};`;
}
export function textSpanCss(it) {
  const c = it.color || "#ffffff";
  if (it.style === "box") return `color:${c};background:rgba(10,10,9,.68);padding:.12em .45em;border-radius:.22em;`;
  if (it.style === "fill") return `color:${lum(c) > 0.55 ? "#141413" : "#fff"};background:${c};padding:.12em .45em;border-radius:.22em;`;
  return `color:${c};text-shadow:0 ${U(2)} ${U(10)} rgba(0,0,0,.75),0 0 ${U(2)} rgba(0,0,0,.6);`;
}

function Item({ it, vid, hidden }) {
  const vis = hidden ? "visibility:hidden;" : "";
  const c = it.color || COLORS[0];
  const t = it.type;
  if (it.points) {
    const w = it.width || 4;
    const common = { fill: "none", stroke: c, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" };
    let body;
    if (t === "arrow" || t === "line") {
      const [a, b] = [it.points[0], it.points[it.points.length - 1]].map((p) => [p[0] * RW, p[1] * RH]);
      if (t === "line") body = html`<line x1=${a[0]} y1=${a[1]} x2=${b[0]} y2=${b[1]} ...${common} />`;
      else {
        // filled head; the shaft stops short so the round cap doesn't poke through
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const L = Math.max(16, w * 4), sp = 0.45;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = len > 0 ? Math.max(0, len - L * 0.6) / len : 0;
        const head = [[b[0], b[1]], [b[0] - Math.cos(ang - sp) * L, b[1] - Math.sin(ang - sp) * L], [b[0] - Math.cos(ang + sp) * L, b[1] - Math.sin(ang + sp) * L]];
        body = html`<line x1=${a[0]} y1=${a[1]} x2=${a[0] + (b[0] - a[0]) * k} y2=${a[1] + (b[1] - a[1]) * k} ...${common} />
          <polygon points=${head.map((p) => p.join(",")).join(" ")} fill=${c} stroke=${c} stroke-width=${Math.max(1, w / 2)} stroke-linejoin="round" />`;
      }
    } else body = html`<path d=${pathOf(it.points)} ...${common} stroke-opacity=${t === "highlight" ? 0.38 : 1} />`;
    return html`<svg class="sk-svg" data-sk=${it.id} style=${vis} viewBox=${`0 0 ${RW} ${RH}`} preserveAspectRatio="none">${body}</svg>`;
  }
  if (t === "text") {
    return html`<div class="sk-text" data-sk=${it.id} style=${textCss(it) + vis}><span class="sk-tx" style=${textSpanCss(it)}>${it.text}</span></div>`;
  }
  if (t === "rect" || t === "ellipse") {
    const bg = it.fill === "solid" ? c : it.fill === "soft" ? `color-mix(in srgb, ${c} 26%, transparent)` : "transparent";
    return html`<div class="sk-box" data-sk=${it.id} style=${boxCss(it) + vis + `border:${U(it.width == null ? 4 : it.width)} solid ${c};background:${bg};border-radius:${t === "ellipse" ? "50%" : U(6)};`}></div>`;
  }
  if (t === "placeholder") {
    return html`<div class="sk-ph" data-sk=${it.id} style=${boxCss(it) + vis + `border:${U(2.5)} dashed ${c};color:${c};background:color-mix(in srgb, ${c} 10%, rgba(10,10,9,.35));`}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"><line x1="0" y1="0" x2="100" y2="100" stroke=${c} stroke-opacity=".35" vector-effect="non-scaling-stroke" /><line x1="100" y1="0" x2="0" y2="100" stroke=${c} stroke-opacity=".35" vector-effect="non-scaling-stroke" /></svg>
      ${it.text && html`<span style=${`font-size:${U(clamp(Math.min(it.h * RH * 0.2, it.w * RW * 0.16), 13, 44))}`}>${it.text}</span>`}
    </div>`;
  }
  if (t === "frame") {
    return html`<div class="sk-frame" data-sk=${it.id} style=${boxCss(it) + vis + `border:${U(2.5)} solid ${c};${it.dim !== false ? "box-shadow:0 0 0 2000px rgba(8,8,7,.58);" : ""}`}>
      <span style=${`background:${c};color:${lum(c) > 0.55 ? "#141413" : "#fff"};font-size:${U(15)}`}>${it.ratio === "free" ? "Crop" : it.ratio}</span>
    </div>`;
  }
  if (t === "blur") return html`<div class="sk-blur" data-sk=${it.id} style=${boxCss(it) + vis + `backdrop-filter:blur(${U(18)});-webkit-backdrop-filter:blur(${U(18)});`}></div>`;
  if (t === "image") {
    return html`<img class="sk-img" data-sk=${it.id} alt="" draggable="false" src=${imageUrl(vid, it.src)} style=${boxCss(it) + vis + `opacity:${it.opacity == null ? 1 : it.opacity}`} />`;
  }
  return null;
}

export function SketchLayer({ items, vid, hideId, layerRef, cls = "" }) {
  return html`<div class=${"sk-layer " + cls} ref=${layerRef}>${items.map((it) => html`<${Item} key=${it.id} it=${it} vid=${vid} hidden=${it.id === hideId} />`)}</div>`;
}

// ---------------------------------------------------------------------------
// geometry
function itemBox(it, layerEl) {
  if (it.points) {
    const xs = it.points.map((p) => p[0]), ys = it.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (it.type === "text") {
    const el = layerEl && layerEl.querySelector(`[data-sk="${it.id}"]`);
    if (el) {
      const L = layerEl.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (L.width) return { x: (r.left - L.left) / L.width, y: (r.top - L.top) / L.height, w: r.width / L.width, h: r.height / L.height };
    }
    return { x: it.x, y: it.y, w: 0.1, h: 0.06 };
  }
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// Topmost item under the point. Reframe guides only catch their border so
// whatever sits inside them stays clickable.
function hitTest(items, p, layerEl) {
  const L = layerEl.getBoundingClientRect();
  const px = (q) => [q[0] * L.width, q[1] * L.height];
  const P = px(p), k = L.height / RH;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.points) {
      const tol = Math.max(7, ((it.width || 4) * k) / 2 + 5);
      const pts = it.points.map(px);
      for (let j = 0; j < pts.length - 1; j++) if (segDist(P, pts[j], pts[j + 1]) <= tol) return it;
      continue;
    }
    const b = itemBox(it, layerEl);
    const [x1, y1] = px([b.x, b.y]), [x2, y2] = px([b.x + b.w, b.y + b.h]);
    const pad = 5;
    const inside = P[0] >= x1 - pad && P[0] <= x2 + pad && P[1] >= y1 - pad && P[1] <= y2 + pad;
    if (!inside) continue;
    if (it.type === "frame") {
      const nearEdge = Math.min(P[0] - x1, x2 - P[0], P[1] - y1, y2 - P[1]) <= 10;
      const onTag = P[0] - x1 < 60 && P[1] - y1 < 30;
      if (!nearEdge && !onTag) continue;
    }
    return it;
  }
  return null;
}
function moveItem(it, box, dx, dy) {
  dx = clamp(dx, -box.x, Math.max(-box.x, 1 - box.x - box.w));
  dy = clamp(dy, -box.y, Math.max(-box.y, 1 - box.y - box.h));
  if (it.points) return { ...it, points: it.points.map((p) => [r3(p[0] + dx), r3(p[1] + dy)]) };
  return { ...it, x: r3(it.x + dx), y: r3(it.y + dy) };
}
function resizeBox(ob, handle, p, ratio) {
  let x1 = ob.x, y1 = ob.y, x2 = ob.x + ob.w, y2 = ob.y + ob.h;
  const min = 0.01;
  if (handle.includes("w")) x1 = Math.min(p[0], x2 - min);
  if (handle.includes("e")) x2 = Math.max(p[0], x1 + min);
  if (handle.includes("n")) y1 = Math.min(p[1], y2 - min);
  if (handle.includes("s")) y2 = Math.max(p[1], y1 + min);
  if (ratio && handle.length === 2) {
    let w = x2 - x1, h = y2 - y1;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    if (handle.includes("w")) x1 = x2 - w; else x2 = x1 + w;
    if (handle.includes("n")) y1 = y2 - h; else y2 = y1 + h;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function applyResize(it, ob, nb, handle) {
  if (it.points) {
    const sx = ob.w ? nb.w / ob.w : 1, sy = ob.h ? nb.h / ob.h : 1;
    return { ...it, points: it.points.map(([x, y]) => [r3(clamp(nb.x + (x - ob.x) * sx, 0, 1)), r3(clamp(nb.y + (y - ob.y) * sy, 0, 1))]) };
  }
  if (it.type === "text") {
    if (handle === "e" || handle === "w") return { ...it, x: r3(nb.x), w: r3(clamp(nb.w, 0.03, 1)) };
    const s = ob.w ? nb.w / ob.w : 1;
    return { ...it, x: r3(nb.x), y: r3(nb.y), size: clamp(Math.round((it.size || 36) * s), 10, 200), ...(it.w ? { w: r3(clamp(it.w * s, 0.03, 1)) } : {}) };
  }
  return { ...it, x: r3(nb.x), y: r3(nb.y), w: r3(nb.w), h: r3(nb.h) };
}
function fitBox(b) {
  const w = clamp(b.w, 0.005, 1), h = clamp(b.h, 0.005, 1);
  return { x: r3(clamp(b.x, 0, 1 - w)), y: r3(clamp(b.y, 0, 1 - h)), w: r3(w), h: r3(h) };
}
const handlesFor = (it) => {
  if (it.type === "line" || it.type === "arrow") return [];
  const corners = ["nw", "ne", "se", "sw"];
  if (it.points || (it.type === "frame" && it.ratio !== "free")) return corners;
  if (it.type === "text") return [...corners, "e", "w"];
  return [...corners, "n", "e", "s", "w"];
};
const handlePos = (b, h) => [h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : b.x + b.w / 2, h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : b.y + b.h / 2];

// ---------------------------------------------------------------------------
// images: re-encoded in the browser (≤1600 px, WebP when available) so a
// phone photo doesn't travel to the NAS at 12 MB.
async function readImage(file) {
  if (typeof createImageBitmap === "function" && !/svg/.test(file.type)) {
    try { return await createImageBitmap(file); } catch (_) { /* fall through */ }
  }
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Không đọc được ảnh")); r.readAsDataURL(file); });
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Không đọc được ảnh")); i.src = dataUrl; });
}
async function encodeImage(file) {
  const img = await readImage(file);
  const iw = img.width || img.naturalWidth || 800, ih = img.height || img.naturalHeight || 600;
  const s = Math.min(1, 1600 / Math.max(iw, ih));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(iw * s)); cv.height = Math.max(1, Math.round(ih * s));
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  let data = cv.toDataURL("image/webp", 0.88);
  if (!data.startsWith("data:image/webp")) data = cv.toDataURL("image/png");
  if (data.length > 3_900_000) data = cv.toDataURL("image/jpeg", 0.85);
  return { data, w: cv.width, h: cv.height };
}

// ---------------------------------------------------------------------------
// editor state: document + undo history + tool/style. Lives in the review
// screen so the draft survives toggling the editor and goes out with the note.
export function useSketchEditor(vid) {
  const [items, setItemsS] = useState([]);
  const cur = useRef(items);
  const hist = useRef({ past: [], future: [] });
  const [tool, setToolS] = useState("pen");
  const [sel, setSel] = useState(null);
  const [props, setProps] = useState(DEFAULT_PROPS);
  const [uploading, setUploading] = useState(0);
  const [editReq, setEditReq] = useState(null);

  const apply = (next) => { cur.current = next; setItemsS(next); };
  const pushPast = (before) => {
    const h = hist.current;
    h.past.push(before);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
  };
  const change = (fn, before = cur.current) => {
    const next = fn(cur.current);
    if (next === cur.current) return;
    pushPast(before);
    apply(next.slice(-MAX_ITEMS));
  };
  const selected = items.find((i) => i.id === sel) || null;
  const update = (id, patch) => change((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const ed = {
    vid, items, tool, sel, selected, props, uploading, editReq,
    requestEdit: (id) => setEditReq({ id }),
    clearEditReq: () => setEditReq(null),
    canUndo: hist.current.past.length > 0,
    canRedo: hist.current.future.length > 0,
    setSel,
    setTool: (t) => { setToolS(t); if (t !== "select") setSel(null); },
    change, update, pushPast, apply,
    reset: (list = []) => { hist.current = { past: [], future: [] }; apply(list); setSel(null); },
    undo: () => { const h = hist.current; if (!h.past.length) return; h.future.push(cur.current); apply(h.past.pop()); },
    redo: () => { const h = hist.current; if (!h.future.length) return; h.past.push(cur.current); apply(h.future.pop()); },
    add: (list, { keepTool } = {}) => {
      const withIds = list.map((it) => ({ ...it, id: it.id || uid() }));
      change((l) => [...l, ...withIds]);
      setSel(withIds[withIds.length - 1].id);
      if (!keepTool) setToolS("select");
    },
    remove: (id) => { change((l) => l.filter((i) => i.id !== id)); setSel(null); },
    duplicate: (id) => {
      const it = cur.current.find((i) => i.id === id);
      if (!it) return;
      const b = itemBox(it, null);
      const copy = { ...moveItem(it, b, 0.025, 0.04), id: uid() };
      change((l) => [...l, copy]);
      setSel(copy.id);
    },
    layer: (id, dir) => change((l) => {
      const i = l.findIndex((x) => x.id === id);
      const j = dir === "top" ? l.length - 1 : dir === "bottom" ? 0 : i + dir;
      if (i < 0 || j < 0 || j >= l.length || i === j) return l;
      const next = l.slice();
      const [x] = next.splice(i, 1);
      next.splice(j, 0, x);
      return next;
    }),
    // Style controls edit the selection and become the default for new items.
    setProp: (k, v) => {
      const type = selected ? selected.type : tool;
      setProps((p) => ({ ...p, [k === "color" ? colorKey(type) : k]: v }));
      if (!selected) return;
      if (k === "wi") { if (WIDTHS[selected.type]) update(selected.id, { width: WIDTHS[selected.type][v] }); return; }
      if (k === "ratio" && selected.type === "frame") {
        const rn = ratioN(v);
        if (!rn) { update(selected.id, { ratio: v }); return; }
        let h = selected.h, w = h * rn;
        if (w > 1) { w = 1; h = w / rn; }
        const cx = selected.x + selected.w / 2, cy = selected.y + selected.h / 2;
        update(selected.id, { ratio: v, ...fitBox({ x: cx - w / 2, y: cy - h / 2, w, h }) });
        return;
      }
      update(selected.id, { [k]: v });
    },
    insertImageFile: async (file, at) => {
      if (!file || !/^image\//.test(file.type)) { toast("Chỉ chèn được file ảnh (PNG, JPEG, WebP…)", "error"); return; }
      if (!vid) return;
      setUploading((n) => n + 1);
      try {
        const img = await encodeImage(file);
        const r = await post("/asset-versions/" + enc(vid) + "/annotation-images", { dataUrl: img.data }, { timeout: 60000 });
        const ar = img.w / img.h;
        let w = 0.32, h = (w * RW) / RH / ar;
        if (h > 0.6) { h = 0.6; w = (h * RH * ar) / RW; }
        const c = at || [0.5, 0.5];
        ed.add([{ type: "image", src: r.id, opacity: 1, ...fitBox({ x: c[0] - w / 2, y: c[1] - h / 2, w, h }) }]);
      } catch (e) { toast(errMsg(e, "Không tải được ảnh lên"), "error", 5200); }
      setUploading((n) => n - 1);
    },
    pickImage: (at) => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*";
      inp.onchange = () => { if (inp.files && inp.files[0]) ed.insertImageFile(inp.files[0], at); };
      inp.click();
    },
  };
  return ed;
}

function newItem(type, p, props) {
  const id = uid();
  const W = WIDTHS[type] ? WIDTHS[type][props.wi] : undefined;
  if (type === "pen" || type === "highlight") return { id, type, color: props.color, width: W, points: [p] };
  if (type === "line" || type === "arrow") return { id, type, color: props.color, width: W, points: [p, p] };
  const box = { id, type, x: p[0], y: p[1], w: 0, h: 0 };
  if (type === "rect" || type === "ellipse") return { ...box, color: props.color, width: W, fill: props.fill };
  if (type === "placeholder") return { ...box, color: props.tcolor, text: "B-roll" };
  if (type === "frame") return { ...box, color: props.tcolor, ratio: props.ratio, dim: props.dim };
  return box; // blur
}
const DEFAULT_SIZE = { rect: [0.16, 0.284], ellipse: [0.16, 0.284], placeholder: [0.3, 0.3], blur: [0.16, 0.24] };

// ---------------------------------------------------------------------------
// The editing surface inside the stage. Gestures stay local (draft item,
// move/resize override) and land in the document once, on pointer up.
export function SketchCanvas({ ed }) {
  const layerRef = useRef(null);
  const edRef = useRef(ed);
  edRef.current = ed;
  const [draft, setDraft] = useState(null);
  const [ovr, setOvr] = useState(null);
  const [editing, setEditing] = useState(null); // { item, isNew } text, or { item, label: true } placeholder
  const [selBox, setSelBox] = useState(null);
  const drag = useRef(null);
  const clip = useRef(null);
  const cm = useContextMenu();
  const cmAt = useRef({ id: null, p: [0.5, 0.5] });   // object + point under the right-click

  let shown = ovr ? ed.items.map((i) => (i.id === ovr.id ? ovr.item : i)) : ed.items;
  if (draft) shown = [...shown, draft];
  const sel = ed.sel ? shown.find((i) => i.id === ed.sel) || null : null;

  useLayoutEffect(() => {
    setSelBox(sel && layerRef.current ? itemBox(sel, layerRef.current) : null);
  }, [sel, editing]);

  const pt = (e) => {
    const r = layerRef.current.getBoundingClientRect();
    return [r3(clamp((e.clientX - r.left) / r.width, 0, 1)), r3(clamp((e.clientY - r.top) / r.height, 0, 1))];
  };

  const startDrag = (d) => {
    drag.current = d;
    const move = (e) => onDragMove(e);
    const up = (e) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); onDragEnd(e); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const pasteClip = () => {
    const it = clip.current;
    if (!it) return;
    const copy = { ...moveItem(it, itemBox(it, layerRef.current), 0.025, 0.04), id: uid() };
    clip.current = copy;
    edRef.current.add([copy]);
  };
  const startEdit = (it) => setEditing(it.type === "text" ? { item: it, isNew: false } : { item: it, label: true });

  // Right-click: actions for the object under the pointer, or what can be
  // inserted on an empty spot.
  const onContext = (e) => {
    if (drag.current) { e.preventDefault(); return; }
    if (editing) return; // typing in a text box: the browser's own menu (paste, spelling)
    const ed = edRef.current;
    const p = pt(e);
    const hit = hitTest(ed.items, p, layerRef.current);
    if (hit) { ed.setTool("select"); ed.setSel(hit.id); }
    cmAt.current = { id: hit ? hit.id : null, p };
    cm.open(e);
  };
  const ctxItems = () => {
    const it = cmAt.current.id ? ed.items.find((i) => i.id === cmAt.current.id) : null;
    if (it) {
      return [
        (it.type === "text" || it.type === "placeholder") && { label: it.type === "text" ? "Sửa chữ" : "Đổi nhãn", hint: "↵", onClick: () => startEdit(it) },
        { label: "Nhân bản", hint: MOD + "D", onClick: () => ed.duplicate(it.id) },
        { label: "Sao chép", hint: MOD + "C", onClick: () => { clip.current = it; } },
        "-",
        { label: "Đưa lên trên cùng", onClick: () => ed.layer(it.id, "top") },
        { label: "Lên một lớp", hint: "]", onClick: () => ed.layer(it.id, 1) },
        { label: "Xuống một lớp", hint: "[", onClick: () => ed.layer(it.id, -1) },
        { label: "Đưa xuống dưới cùng", onClick: () => ed.layer(it.id, "bottom") },
        "-",
        { label: "Xoá", hint: "Del", danger: true, onClick: () => ed.remove(it.id) },
      ];
    }
    return [
      clip.current && { label: "Dán", hint: MOD + "V", onClick: pasteClip },
      { label: "Chèn ảnh…", hint: "I", onClick: () => ed.pickImage(cmAt.current.p) },
      "-",
      ...TEMPLATES.map((t) => (t.sep ? "-" : { label: t.label, hint: t.hint, onClick: () => ed.add(t.make()) })),
      "-",
      ed.items.length > 0 && { label: "Xoá hết phác thảo", danger: true, onClick: () => { ed.change(() => []); ed.setSel(null); } },
    ];
  };

  const onDown = (e) => {
    if (e.button !== 0 || editing) return;
    e.preventDefault(); e.stopPropagation();
    const ed = edRef.current;
    const p = pt(e);
    const hit = hitTest(ed.items, p, layerRef.current);
    if (ed.tool === "select") {
      if (!hit) { ed.setSel(null); return; }
      ed.setSel(hit.id);
      startDrag({ mode: "move", start: p, id: hit.id, orig: hit, box: itemBox(hit, layerRef.current), before: ed.items, moved: false });
      return;
    }
    if (ed.tool === "text") {
      if (hit && hit.type === "text") { ed.setSel(hit.id); setEditing({ item: hit, isNew: false }); return; }
      const size = ed.props.size;
      setEditing({ isNew: true, item: { id: uid(), type: "text", x: p[0], y: r3(clamp(p[1] - (size * 0.65) / RH, 0, 1)), color: ed.props.tcolor, text: "", size, bold: ed.props.bold, style: ed.props.style, align: "left" } });
      return;
    }
    if (ed.tool === "image") { ed.pickImage(p); return; }
    const it = newItem(ed.tool, p, ed.props);
    setDraft(it);
    startDrag({ mode: "create", start: p, item: it });
  };

  const onDragMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const p = pt(e);
    const ed = edRef.current;
    if (d.mode === "create") {
      const it = d.item;
      let next;
      if (it.type === "pen" || it.type === "highlight") {
        const last = it.points[it.points.length - 1];
        if (Math.hypot((p[0] - last[0]) * RW, (p[1] - last[1]) * RH) < 3 || it.points.length >= 512) return;
        next = { ...it, points: [...it.points, p] };
      } else if (it.type === "line" || it.type === "arrow") {
        let q = p;
        if (e.shiftKey) { // snap to 45°
          const dx = (p[0] - d.start[0]) * RW, dy = (p[1] - d.start[1]) * RH;
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
          q = [r3(clamp(d.start[0] + (Math.cos(a) * len) / RW, 0, 1)), r3(clamp(d.start[1] + (Math.sin(a) * len) / RH, 0, 1))];
        }
        next = { ...it, points: [d.start, q] };
      } else {
        const ratio = it.type === "frame" ? ratioN(it.ratio) : e.shiftKey ? RH / RW : 0;
        const b = resizeBox({ x: d.start[0], y: d.start[1], w: 0, h: 0 }, (p[1] < d.start[1] ? "n" : "s") + (p[0] < d.start[0] ? "w" : "e"), p, ratio);
        next = { ...it, ...fitBox(b) };
      }
      d.item = next;
      setDraft(next);
      return;
    }
    if (d.mode === "move") {
      const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      if (!d.moved && Math.hypot(dx * RW, dy * RH) < 3) return;
      d.moved = true;
      d.cur = moveItem(d.orig, d.box, dx, dy);
      setOvr({ id: d.id, item: d.cur });
      return;
    }
    if (d.mode === "resize") {
      const it = d.orig;
      const keep = it.type === "frame" ? ratioN(it.ratio) : (it.type === "image" || it.type === "text") !== e.shiftKey ? d.box.w / d.box.h : 0;
      const nb = resizeBox(d.box, d.handle, p, keep);
      d.cur = applyResize(it, d.box, nb, d.handle);
      d.moved = true;
      setOvr({ id: d.id, item: d.cur });
      return;
    }
    if (d.mode === "end") {
      const pts = d.orig.points.slice();
      pts[d.idx] = p;
      d.cur = { ...d.orig, points: pts };
      d.moved = true;
      setOvr({ id: d.id, item: d.cur });
    }
    void ed;
  };

  const onDragEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const ed = edRef.current;
    if (d.mode === "create") {
      setDraft(null);
      let it = d.item;
      if (it.points) {
        const a = it.points[0], b = it.points[it.points.length - 1];
        const span = Math.max(...it.points.map((q) => Math.hypot((q[0] - a[0]) * RW, (q[1] - a[1]) * RH)));
        if (it.points.length < 2 || span < 6 || ((it.type === "line" || it.type === "arrow") && Math.hypot((b[0] - a[0]) * RW, (b[1] - a[1]) * RH) < 8)) return;
      } else if (it.w < 0.012 && it.h < 0.012) {
        // a click places a default-sized box centred on the pointer
        const rn = ratioN(it.ratio);
        let [w, h] = it.type === "frame" ? [0.9 * (rn || 1), 0.9] : DEFAULT_SIZE[it.type] || [0.2, 0.2];
        if (w > 1) { w = 1; h = 1 / rn; }
        it = { ...it, ...fitBox({ x: d.start[0] - w / 2, y: d.start[1] - h / 2, w, h }) };
      }
      ed.add([it], { keepTool: it.type === "pen" || it.type === "highlight" });
      if (it.type === "pen" || it.type === "highlight") ed.setSel(null);
      return;
    }
    setOvr(null);
    if (d.moved && d.cur) {
      ed.pushPast(d.before || ed.items);
      ed.apply(ed.items.map((i) => (i.id === d.id ? d.cur : i)));
    }
  };

  const onHandleDown = (e, handle, idx) => {
    if (e.button !== 0) return; // right-click on a handle opens the object menu
    e.preventDefault(); e.stopPropagation();
    const ed = edRef.current;
    const it = ed.selected;
    if (!it) return;
    if (idx != null) startDrag({ mode: "end", id: it.id, idx, orig: it, before: ed.items });
    else startDrag({ mode: "resize", id: it.id, handle, orig: it, box: itemBox(it, layerRef.current), before: ed.items });
  };

  const onDbl = (e) => {
    const ed = edRef.current;
    const hit = hitTest(ed.items, pt(e), layerRef.current);
    if (!hit) return;
    if (hit.type === "text" || hit.type === "placeholder") { ed.setSel(hit.id); startEdit(hit); }
  };

  const commitText = (raw) => {
    const e = editing;
    setEditing(null);
    if (!e) return;
    const ed = edRef.current;
    const text = String(raw || "").replace(/ /g, " ").replace(/\r/g, "").replace(/^\n+|\s+$/g, "").slice(0, e.label ? 120 : 500);
    if (e.label) { if (text !== e.item.text) ed.update(e.item.id, { text }); return; }
    if (e.isNew) { if (text) ed.add([{ ...e.item, text }]); return; }
    if (!text) ed.remove(e.item.id);
    else if (text !== e.item.text) ed.update(e.item.id, { text });
  };

  useEffect(() => {
    if (!ed.editReq) return;
    const it = ed.items.find((i) => i.id === ed.editReq.id);
    ed.clearEditReq();
    if (it) setEditing(it.type === "text" ? { item: it, isNew: false } : { item: it, label: true });
  }, [ed.editReq]);

  // keyboard + paste while the editor is open; capture phase so the review
  // shortcuts (arrows = frame step) don't fire when a shape is being nudged.
  useEffect(() => {
    const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onKey = (e) => {
      if (typing(e.target) || S.overlay || drag.current) return;
      const ed = edRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const k = (e.key || "").toLowerCase();
      let done = true;
      if (mod && k === "z") (e.shiftKey ? ed.redo : ed.undo)();
      else if (mod && k === "y") ed.redo();
      else if (mod && k === "d" && ed.sel) ed.duplicate(ed.sel);
      else if (mod && k === "c" && ed.selected) clip.current = ed.selected;
      else if (mod && k === "a") ed.setTool("select");
      else if ((k === "delete" || k === "backspace") && ed.sel) ed.remove(ed.sel);
      else if (k === "escape" && ed.sel) ed.setSel(null);
      else if (k === "escape" && ed.tool !== "select") ed.setTool("select");
      else if (k === "enter" && ed.selected && (ed.selected.type === "text" || ed.selected.type === "placeholder")) startEdit(ed.selected);
      else if (k.startsWith("arrow") && ed.sel && !mod) {
        const st = e.shiftKey ? 10 : 1;
        const dx = k === "arrowleft" ? -st / RW : k === "arrowright" ? st / RW : 0;
        const dy = k === "arrowup" ? -st / RH : k === "arrowdown" ? st / RH : 0;
        const it = ed.selected;
        ed.update(it.id, moveItem(it, itemBox(it, layerRef.current), dx, dy));
      } else if ((k === "]" || k === "[") && ed.sel) ed.layer(ed.sel, k === "]" ? 1 : -1);
      else if (!mod && !e.altKey && SHORTCUTS[k]) { if (SHORTCUTS[k] === "image") ed.pickImage(); else ed.setTool(SHORTCUTS[k]); }
      else done = false;
      if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    const onPaste = (e) => {
      if (typing(e.target) || S.overlay) return;
      const ed = edRef.current;
      const file = [...((e.clipboardData && e.clipboardData.files) || [])].find((f) => /^image\//.test(f.type));
      if (file) { e.preventDefault(); ed.insertImageFile(file); return; }
      if (clip.current) { e.preventDefault(); pasteClip(); }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("paste", onPaste); };
  }, []);

  const cursor = ed.tool === "select" ? "default" : ed.tool === "text" ? "text" : ed.tool === "image" ? "copy" : "crosshair";
  const editItem = editing && !editing.label ? { ...editing.item, ...(editing.isNew ? { color: ed.props.tcolor, size: ed.props.size, bold: ed.props.bold, style: ed.props.style } : {}) } : null;
  const ends = sel && (sel.type === "line" || sel.type === "arrow") ? [sel.points[0], sel.points[sel.points.length - 1]] : null;

  return html`<div class="sk-edit-root" onClick=${(e) => e.stopPropagation()} onContextMenu=${onContext}>
    <${SketchLayer} items=${shown} vid=${ed.vid} layerRef=${layerRef} hideId=${editing && !editing.isNew && !editing.label ? editing.item.id : null} cls="editing" />
    <div class="sk-hit" style=${`cursor:${cursor}`} onPointerDown=${onDown} onDblClick=${onDbl}></div>
    <${ContextMenu} cm=${cm} width=${260} title=${cm.at ? (cmAt.current.id ? typeLabel((ed.items.find((i) => i.id === cmAt.current.id) || {}).type) : "Chèn vào khung") : ""} items=${cm.at ? ctxItems() : []} />
    <div class="sk-ui">
      ${sel && selBox && !ends && !editing && html`<div class="sk-sel" style=${boxCss(selBox)}></div>
        ${handlesFor(sel).map((h) => { const [x, y] = handlePos(selBox, h); return html`<div class=${"sk-h h-" + h} style=${`left:${x * 100}%;top:${y * 100}%`} onPointerDown=${(e) => onHandleDown(e, h)}></div>`; })}`}
      ${ends && ends.map((q, i) => html`<div class="sk-h round" style=${`left:${q[0] * 100}%;top:${q[1] * 100}%`} onPointerDown=${(e) => onHandleDown(e, null, i)}></div>`)}
      ${editItem && html`<${TextEditor} it=${editItem} onCommit=${commitText} onCancel=${() => setEditing(null)} />`}
      ${editing && editing.label && html`<${LabelEditor} it=${editing.item} onCommit=${commitText} onCancel=${() => setEditing(null)} />`}
    </div>
    ${ed.uploading > 0 && html`<div class="sk-busy">Đang tải ảnh lên…</div>`}
  </div>`;
}

function TextEditor({ it, onCommit, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    el.innerText = it.text || "";
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
  }, []);
  const finish = () => { if (done.current) return; done.current = true; onCommit(ref.current.innerText); };
  return html`<div class="sk-text sk-text-edit" style=${textCss(it)}>
    <span ref=${ref} class="sk-tx" contenteditable="true" spellcheck="false" style=${textSpanCss(it)} data-ph="Nhập chữ…"
      onPointerDown=${(e) => e.stopPropagation()}
      onPaste=${(e) => { e.preventDefault(); e.stopPropagation(); document.execCommand("insertText", false, (e.clipboardData && e.clipboardData.getData("text/plain")) || ""); }}
      onKeyDown=${(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(); }
        if (e.key === "Escape") { e.preventDefault(); if (it.text) finish(); else { done.current = true; onCancel(); } }
      }}
      onBlur=${finish}></span>
  </div>`;
}

function LabelEditor({ it, onCommit, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => { ref.current.focus(); ref.current.select(); }, []);
  const finish = () => { if (done.current) return; done.current = true; onCommit(ref.current.value); };
  return html`<input ref=${ref} class="sk-label-input" value=${it.text || ""} maxlength="120" placeholder="Nhãn ô giữ chỗ"
    style=${`left:${(it.x + it.w / 2) * 100}%;top:${(it.y + it.h / 2) * 100}%`}
    onPointerDown=${(e) => e.stopPropagation()}
    onKeyDown=${(e) => { e.stopPropagation(); if (e.key === "Enter") finish(); if (e.key === "Escape") { done.current = true; onCancel(); } }}
    onBlur=${finish} />`;
}

// ---------------------------------------------------------------------------
// toolbar above the stage
const I = (d, extra = "") => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ...${extra ? { style: extra } : {}}>${d}</svg>`;
const s = (strs, ...v) => html(strs, ...v);
export const ICONS = {
  select: () => I(s`<path d="M5 3.5l13 7.2-5.6 1.6-2.4 5.6z" />`),
  pen: () => I(s`<path d="M4 20l1.2-4.4L16.5 4.3a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z" />`),
  highlight: () => I(s`<path d="M14.5 4.5l5 5-7.5 7.5h-5v-5z" /><path d="M4 20h7" stroke-width="3" />`),
  arrow: () => I(s`<path d="M5 19L19 5" /><path d="M10 5h9v9" />`),
  line: () => I(s`<path d="M5 19L19 5" />`),
  rect: () => I(s`<rect x="3.5" y="6" width="17" height="12" rx="2" />`),
  ellipse: () => I(s`<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />`),
  text: () => I(s`<path d="M5 7V5h14v2" /><path d="M12 5v14" /><path d="M9 19h6" />`),
  image: () => I(s`<rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-5-5-8 8" />`),
  placeholder: () => I(s`<rect x="3.5" y="5" width="17" height="14" rx="1.5" stroke-dasharray="3 2.4" /><path d="M3.5 5l17 14M20.5 5l-17 14" stroke-opacity=".55" />`),
  frame: () => I(s`<path d="M7 3v14h14" /><path d="M3 7h14v14" />`),
  blur: () => I(s`<path d="M12 3.5c3 3.8 5.5 6.8 5.5 10a5.5 5.5 0 0 1-11 0c0-3.2 2.5-6.2 5.5-10z" /><path d="M9.5 14.5a2.6 2.6 0 0 0 2.5 2.5" />`),
  undo: () => I(s`<path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />`),
  redo: () => I(s`<path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />`),
  dup: () => I(s`<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />`),
  front: () => I(s`<rect x="8" y="8" width="12" height="12" rx="2" fill="currentColor" fill-opacity=".25" /><path d="M16 4H6a2 2 0 0 0-2 2v10" />`),
  back: () => I(s`<rect x="4" y="4" width="12" height="12" rx="2" /><path d="M20 8v10a2 2 0 0 1-2 2H8" fill="none" />`),
  trash: () => I(s`<path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" />`),
  alignL: () => I(s`<path d="M4 6h16M4 10h10M4 14h16M4 18h10" />`),
  alignC: () => I(s`<path d="M4 6h16M7 10h10M4 14h16M7 18h10" />`),
  alignR: () => I(s`<path d="M4 6h16M10 10h10M4 14h16M10 18h10" />`),
};

const Btn = ({ on, title, onClick, children, disabled, cls = "" }) => html`<button type="button" class=${"sk-btn " + cls + (on ? " on" : "")} title=${title} aria-label=${title} disabled=${disabled} onClick=${onClick}>${children}</button>`;
const Chip = ({ on, onClick, children, title }) => html`<button type="button" class=${"sk-chip" + (on ? " on" : "")} title=${title} onClick=${onClick}>${children}</button>`;
const nearest = (list, v) => list.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(list[bi] - v) ? i : bi), 0);

function StyleControls({ ed }) {
  const it = ed.selected;
  const type = it ? it.type : ed.tool;
  const P = ed.props;
  const v = (k, dflt) => (it ? (it[k] == null ? dflt : it[k]) : P[k]);
  const color = it ? it.color : P[colorKey(type)];
  const parts = [];
  if (type === "select" && !it) return html`<div class="sk-hint">Bấm chọn một đối tượng để sửa · kéo để di chuyển · bấm đúp vào chữ để sửa chữ</div>`;
  if (type === "blur" && !it) return html`<div class="sk-hint">Kéo một vùng để đánh dấu chỗ cần che mờ (logo, biển số, khuôn mặt…)</div>`;
  if (type === "image" && !it) return html`<div class="sk-hint">Chọn ảnh, dán (Ctrl/⌘ V) hoặc kéo thả ảnh vào khung hình</div>`;
  if (type !== "blur" && type !== "image") {
    parts.push(html`<div class="sk-colors">${COLORS.map((c) => html`<button type="button" class=${"sk-color" + (color && color.toLowerCase() === c ? " on" : "")} style=${`background:${c}`} title=${c} aria-label=${"Màu " + c} onClick=${() => ed.setProp("color", c)}></button>`)}</div>`);
  }
  if (WIDTHS[type]) {
    const wi = it ? nearest(WIDTHS[type], it.width || WIDTHS[type][1]) : P.wi;
    parts.push(html`<div class="sk-seg">${[0, 1, 2].map((i) => html`<${Chip} on=${wi === i} title=${["Mảnh", "Vừa", "Dày"][i]} onClick=${() => ed.setProp("wi", i)}><span class="sk-wdot" style=${`height:${[2, 4, 7][i]}px`}></span></${Chip}>`)}</div>`);
  }
  if (type === "rect" || type === "ellipse") {
    const f = v("fill", "none");
    parts.push(html`<div class="sk-seg">${[["none", "Viền"], ["soft", "Nền mờ"], ["solid", "Nền đặc"]].map(([k, l]) => html`<${Chip} on=${f === k} onClick=${() => ed.setProp("fill", k)}>${l}</${Chip}>`)}</div>`);
  }
  if (type === "text") {
    const size = v("size", 36);
    const si = nearest(SIZES.map((x) => +x[0]), size);
    parts.push(html`<div class="sk-seg">${SIZES.map(([n, l], i) => html`<${Chip} on=${si === i} title=${"Cỡ chữ " + l} onClick=${() => ed.setProp("size", +n)}>${l}</${Chip}>`)}</div>`);
    parts.push(html`<${Chip} on=${!!v("bold", true)} title="Đậm" onClick=${() => ed.setProp("bold", !v("bold", true))}><b>B</b></${Chip}>`);
    const st = v("style", "shadow");
    parts.push(html`<div class="sk-seg">${[["shadow", "Bóng"], ["box", "Nền tối"], ["fill", "Nền màu"]].map(([k, l]) => html`<${Chip} on=${st === k} onClick=${() => ed.setProp("style", k)}>${l}</${Chip}>`)}</div>`);
    if (it) {
      const al = v("align", "left");
      parts.push(html`<div class="sk-seg">${[["left", ICONS.alignL(), "Căn trái"], ["center", ICONS.alignC(), "Căn giữa"], ["right", ICONS.alignR(), "Căn phải"]].map(([k, ic, l]) => html`<${Chip} on=${al === k} title=${l} onClick=${() => ed.setProp("align", k)}>${ic}</${Chip}>`)}</div>`);
    }
  }
  if (type === "frame") {
    const r = v("ratio", "9:16");
    parts.push(html`<div class="sk-seg">${RATIOS.map(([k, l]) => html`<${Chip} on=${r === k} onClick=${() => ed.setProp("ratio", k)}>${l}</${Chip}>`)}</div>`);
    parts.push(html`<${Chip} on=${v("dim", true) !== false} title="Làm tối phần bị cắt" onClick=${() => ed.setProp("dim", !(v("dim", true) !== false))}>Tối ngoài</${Chip}>`);
  }
  if (type === "image" && it) {
    const o = v("opacity", 1);
    parts.push(html`<div class="sk-seg">${[[1, "100%"], [0.7, "70%"], [0.4, "40%"]].map(([k, l]) => html`<${Chip} on=${Math.abs(o - k) < 0.05} title="Độ đậm" onClick=${() => ed.setProp("opacity", k)}>${l}</${Chip}>`)}</div>`);
  }
  if ((type === "placeholder" || type === "text") && it) parts.push(html`<${Chip} title="Hoặc bấm đúp / Enter" onClick=${() => ed.requestEdit(it.id)}>${type === "text" ? "Sửa chữ" : "Đổi nhãn"}</${Chip}>`);
  if (it) {
    parts.push(html`<div class="sk-sep"></div>`);
    parts.push(html`<${Btn} title="Nhân bản (Ctrl/⌘ D)" onClick=${() => ed.duplicate(it.id)}>${ICONS.dup()}</${Btn}>`);
    parts.push(html`<${Btn} title="Đưa lên trên (])" onClick=${() => ed.layer(it.id, "top")}>${ICONS.front()}</${Btn}>`);
    parts.push(html`<${Btn} title="Đưa xuống dưới ([)" onClick=${() => ed.layer(it.id, "bottom")}>${ICONS.back()}</${Btn}>`);
    parts.push(html`<${Btn} title="Xoá (Delete)" cls="danger" onClick=${() => ed.remove(it.id)}>${ICONS.trash()}</${Btn}>`);
  }
  return html`<div class="sk-props">${parts}</div>`;
}

export function SketchToolbar({ ed, title, doneLabel = "Xong", onDone, onCancel }) {
  const [tpl, setTpl] = useState(false);
  const tplBtn = useRef(null);
  return html`<div class="sk-bar" onClick=${(e) => e.stopPropagation()}>
    <div class="sk-row">
      ${title && html`<div class="sk-title">${title}</div>`}
      <div class="sk-tools">${TOOLS.map((t) => html`<${Btn} on=${ed.tool === t.k} title=${t.label + " (" + t.key + ")"} onClick=${() => (t.k === "image" ? ed.pickImage() : ed.setTool(t.k))}>${ICONS[t.k]()}</${Btn}>`)}</div>
      <div class="sk-sep"></div>
      <div style="position:relative">
        <button type="button" ref=${tplBtn} class=${"sk-chip" + (tpl ? " on" : "")} onClick=${() => setTpl(!tpl)}>Mẫu nhanh ▾</button>
        <${Menu} open=${tpl} onClose=${() => setTpl(false)} anchorRef=${tplBtn} width=${270}>
          <div class="menu-title">Chèn mẫu</div>
          ${TEMPLATES.map((t) => (t.sep ? html`<div class="menu-sep"></div>` : html`<${MenuItem} hint=${t.hint} onClick=${() => { setTpl(false); ed.add(t.make()); }}>${t.label}</${MenuItem}>`))}
        </${Menu}>
      </div>
      <div class="sk-actions">
        <${Btn} title="Hoàn tác (Ctrl/⌘ Z)" disabled=${!ed.canUndo} onClick=${ed.undo}>${ICONS.undo()}</${Btn}>
        <${Btn} title="Làm lại (Ctrl/⌘ Shift Z)" disabled=${!ed.canRedo} onClick=${ed.redo}>${ICONS.redo()}</${Btn}>
        ${ed.items.length > 0 && html`<button type="button" class="sk-chip" onClick=${() => { ed.change(() => []); ed.setSel(null); }}>Xoá hết</button>`}
        ${onCancel && html`<button type="button" class="sk-chip" onClick=${onCancel}>Huỷ</button>`}
        <button type="button" class="btn btn-primary btn-xs" onClick=${onDone}>${doneLabel}</button>
      </div>
    </div>
    <div class="sk-row sk-row2"><${StyleControls} ed=${ed} /></div>
  </div>`;
}
