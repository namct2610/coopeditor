// Annotation payload validation. Lives outside server.js so tests can import it
// without the server's top-level bootstrap (initDb + listen) firing.
//
// Legacy payload (still accepted and returned as-is):
// {
//   strokes: [{ tool: "pen"|"highlight"|"arrow"|"rect"|"ellipse", color: "#RRGGBB", width: 1..24, points: [[x01, y01], ...] }],
//   texts: [{ x: 0..1, y: 0..1, color: "#RRGGBB", text: "..." }]
// }
//
// Sketch payload (draft editor on the frame), drawn bottom → top:
// {
//   items: [
//     { id, type: "pen"|"highlight"|"line"|"arrow", color, width, points },
//     { id, type: "rect"|"ellipse", x, y, w, h, color, width, fill: "none"|"soft"|"solid" },
//     { id, type: "placeholder", x, y, w, h, color, text },        // "B-roll here" box
//     { id, type: "frame", x, y, w, h, color, ratio, dim },         // reframe / crop guide
//     { id, type: "blur", x, y, w, h },                             // "blur this" region
//     { id, type: "text", x, y, w?, color, text, size, bold, style: "shadow"|"box"|"fill", align },
//     { id, type: "image", x, y, w, h, src: "<image id>", opacity },
//   ]
// }
// Coordinates are normalized 0..1 so they survive scaling; lengths (width,
// size) are pixels on a 1280×720 reference frame.

const TOOLS = ["pen", "highlight", "arrow", "rect", "ellipse"];
const HEX = /^#[0-9a-fA-F]{3,8}$/;
export const SKETCH_TYPES = ["pen", "highlight", "line", "arrow", "rect", "ellipse", "placeholder", "frame", "blur", "text", "image"];
export const SKETCH_RATIOS = ["free", "16:9", "9:16", "1:1", "4:5", "4:3"];
export const ANNOTATION_IMAGE_ID = /^[a-f0-9]{24}\.(png|jpg|webp)$/;
const MAX_ITEMS = 80;

const r3 = (n) => Math.round(n * 1000) / 1000;
const unit = (v, lo = 0, hi = 1) => r3(Math.max(lo, Math.min(hi, Number(v) || 0)));
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const color = (v, dflt = "#ef4d57") => (typeof v === "string" && HEX.test(v) ? v : dflt);

function points(raw, max) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).map((p) => (Array.isArray(p) && p.length >= 2 ? [unit(p[0]), unit(p[1])] : null)).filter(Boolean);
}

function sketchItem(it, i) {
  if (!it || typeof it !== "object" || !SKETCH_TYPES.includes(it.type)) return null;
  const type = it.type;
  const id = typeof it.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(it.id) ? it.id : "i" + i;
  if (type === "pen" || type === "highlight" || type === "line" || type === "arrow") {
    const pts = points(it.points, type === "line" || type === "arrow" ? 2 : 512);
    if (pts.length < 2) return null;
    return { id, type, color: color(it.color), width: num(it.width, 1, 48, 4), points: pts };
  }
  const x = unit(it.x), y = unit(it.y);
  if (type === "text") {
    const text = String(it.text || "").replace(/\r/g, "").trim().slice(0, 500);
    if (!text) return null;
    const out = {
      id, type, x, y, color: color(it.color, "#ffffff"), text,
      size: num(it.size, 10, 200, 36), bold: !!it.bold,
      style: ["shadow", "box", "fill"].includes(it.style) ? it.style : "shadow",
      align: ["left", "center", "right"].includes(it.align) ? it.align : "left",
    };
    if (it.w != null && Number(it.w) > 0) out.w = unit(it.w, 0.02, 1);
    return out;
  }
  const w = unit(it.w, 0.005, 1), h = unit(it.h, 0.005, 1);
  const box = { id, type, x, y, w, h };
  if (type === "rect" || type === "ellipse") return { ...box, color: color(it.color), width: num(it.width, 0, 48, 4), fill: ["none", "soft", "solid"].includes(it.fill) ? it.fill : "none" };
  if (type === "placeholder") return { ...box, color: color(it.color, "#ffffff"), text: String(it.text || "").replace(/\r/g, "").trim().slice(0, 120) };
  if (type === "frame") return { ...box, color: color(it.color, "#ffffff"), ratio: SKETCH_RATIOS.includes(it.ratio) ? it.ratio : "free", dim: it.dim !== false };
  if (type === "blur") return box;
  if (type === "image") {
    if (typeof it.src !== "string" || !ANNOTATION_IMAGE_ID.test(it.src)) return null;
    return { ...box, src: it.src, opacity: num(it.opacity, 0.1, 1, 1) };
  }
  return null;
}

export function validateAnnotation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes.slice(0, 50).map((s) => {
    if (!s || typeof s !== "object") return null;
    const tool = TOOLS.includes(s.tool) ? s.tool : "pen";
    const width = Math.max(1, Math.min(24, Number(s.width) || 3));
    const pts = points(s.points, 256);
    if (!pts.length) return null;
    return { tool, color: color(s.color), width, points: pts };
  }).filter(Boolean) : [];
  const texts = Array.isArray(raw.texts) ? raw.texts.slice(0, 32).map((t) => {
    if (!t || typeof t !== "object") return null;
    const text = String(t.text || "").trim().slice(0, 120);
    if (!text) return null;
    return { x: unit(t.x), y: unit(t.y), color: color(t.color), text };
  }).filter(Boolean) : [];
  const items = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS).map(sketchItem).filter(Boolean) : [];
  if (!strokes.length && !texts.length && !items.length) return null;
  const out = { strokes, texts };
  if (items.length) out.items = items;
  return out;
}

// Image ids referenced by an annotation (for cleanup / access checks).
export function annotationImageIds(a) {
  return ((a && a.items) || []).filter((it) => it.type === "image").map((it) => it.src);
}
