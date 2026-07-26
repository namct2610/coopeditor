// Annotation payload validation. Lives outside server.js so tests can import it
// without the server's top-level bootstrap (initDb + listen) firing.
//
// Payload:
// {
//   strokes: [{ tool: "pen"|"highlight"|"arrow"|"rect"|"ellipse", color: "#RRGGBB", width: 1..24, points: [[x01, y01], ...] }],
//   texts: [{ x: 0..1, y: 0..1, color: "#RRGGBB", text: "..." }]
// }
// Coordinates are normalized 0..1 so they survive scaling. Size cap = 50 strokes × 256 points.

const TOOLS = ["pen", "highlight", "arrow", "rect", "ellipse"];
const HEX = /^#[0-9a-fA-F]{3,8}$/;

export function validateAnnotation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes.slice(0, 50).map((s) => {
    if (!s || typeof s !== "object") return null;
    const tool = TOOLS.includes(s.tool) ? s.tool : "pen";
    const color = typeof s.color === "string" && HEX.test(s.color) ? s.color : "#ef4d57";
    const width = Math.max(1, Math.min(24, Number(s.width) || 3));
    if (!Array.isArray(s.points)) return null;
    const points = s.points.slice(0, 256).map((p) => {
      if (!Array.isArray(p) || p.length < 2) return null;
      const x = Math.max(0, Math.min(1, Number(p[0]) || 0));
      const y = Math.max(0, Math.min(1, Number(p[1]) || 0));
      return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    }).filter(Boolean);
    if (!points.length) return null;
    return { tool, color, width, points };
  }).filter(Boolean) : [];
  const texts = Array.isArray(raw.texts) ? raw.texts.slice(0, 32).map((t) => {
    if (!t || typeof t !== "object") return null;
    const color = typeof t.color === "string" && HEX.test(t.color) ? t.color : "#ef4d57";
    const x = Math.round(Math.max(0, Math.min(1, Number(t.x) || 0)) * 1000) / 1000;
    const y = Math.round(Math.max(0, Math.min(1, Number(t.y) || 0)) * 1000) / 1000;
    const text = String(t.text || "").trim().slice(0, 120);
    if (!text) return null;
    return { x, y, color, text };
  }).filter(Boolean) : [];
  if (!strokes.length && !texts.length) return null;
  return { strokes, texts };
}
