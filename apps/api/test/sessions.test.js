import test from "node:test";
import assert from "node:assert/strict";

import { parseCookies } from "../src/sessions.js";

test("parseCookies tolerates malformed percent-encoding", () => {
  const parsed = parseCookies("fe_sess=abc%ZZ; theme=dark");
  assert.equal(parsed.fe_sess, "abc%ZZ");
  assert.equal(parsed.theme, "dark");
});

test("parseCookies decodes valid cookie values", () => {
  const parsed = parseCookies("name=Coop%20Editor; role=owner");
  assert.equal(parsed.name, "Coop Editor");
  assert.equal(parsed.role, "owner");
});
