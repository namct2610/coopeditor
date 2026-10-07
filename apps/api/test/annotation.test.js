import test from "node:test";
import assert from "node:assert/strict";
import { validateAnnotation } from "../src/annotation.js";

test("keeps the full tool set and passes width through", () => {
  const out = validateAnnotation({
    strokes: [
      { tool: "highlight", color: "#9184d9", width: 14, points: [[0.1, 0.2], [0.3, 0.4]] },
      { tool: "ellipse", color: "#2bbe6e", width: 3, points: [[0, 0], [1, 1]] },
    ],
  });
  assert.deepEqual(out.strokes.map((s) => s.tool), ["highlight", "ellipse"]);
  assert.deepEqual(out.strokes.map((s) => s.width), [14, 3]);
});

test("coerces unknown tools to pen and clamps width", () => {
  const out = validateAnnotation({
    strokes: [
      { tool: "laser", color: "#fff", width: 999, points: [[0.5, 0.5]] },
      { tool: "pen", color: "#fff", points: [[0.5, 0.5]] },
      { tool: "pen", color: "#fff", width: -4, points: [[0.5, 0.5]] },
    ],
  });
  assert.equal(out.strokes[0].tool, "pen");
  assert.deepEqual(out.strokes.map((s) => s.width), [24, 3, 1]);
});

test("clamps coordinates to 0..1 and drops empty payloads", () => {
  const out = validateAnnotation({ strokes: [{ tool: "rect", color: "#ef4d57", points: [[-2, 5]] }] });
  assert.deepEqual(out.strokes[0].points, [[0, 1]]);
  assert.equal(validateAnnotation({ strokes: [], texts: [] }), null);
  assert.equal(validateAnnotation(null), null);
});

test("sketch items: every type validated, junk dropped, order kept", () => {
  const out = validateAnnotation({
    items: [
      { id: "a1", type: "pen", color: "#fff", width: 99, points: [[0.1, 0.1], [0.2, 0.2], [2, -1]] },
      { id: "a2", type: "arrow", points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]] },
      { id: "a3", type: "rect", x: 0.1, y: 0.1, w: 0.3, h: 0.2, fill: "soft", color: "#4c9aff" },
      { id: "a4", type: "text", x: 0.1, y: 0.8, text: "  Phụ đề\ndòng 2 ", size: 999, style: "box", align: "center", bold: 1 },
      { id: "a5", type: "frame", x: 0.3, y: 0, w: 0.3, h: 1, ratio: "9:16" },
      { id: "a6", type: "image", x: 0, y: 0, w: 0.2, h: 0.2, src: "../../etc/passwd" },
      { id: "a7", type: "image", x: 0, y: 0, w: 0.2, h: 0.2, src: "0123456789abcdef01234567.webp", opacity: 0 },
      { id: "a8", type: "text", x: 0, y: 0, text: "   " },
      { id: "bad id!", type: "blur", x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
      { type: "laser" },
    ],
  });
  assert.deepEqual(out.items.map((i) => i.id), ["a1", "a2", "a3", "a4", "a5", "a7", "i8"]);
  assert.equal(out.items[0].width, 48);
  assert.deepEqual(out.items[0].points[2], [1, 0]);
  assert.equal(out.items[1].points.length, 2, "arrows keep two points");
  assert.equal(out.items[2].fill, "soft");
  assert.equal(out.items[3].text, "Phụ đề\ndòng 2");
  assert.equal(out.items[3].size, 200);
  assert.equal(out.items[3].bold, true);
  assert.equal(out.items[4].dim, true);
  assert.equal(out.items[5].opacity, 0.1);
  assert.deepEqual(out.strokes, []);
});
