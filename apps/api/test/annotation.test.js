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
