import { test } from "node:test";
import assert from "node:assert/strict";

import { requestOriginMatchesHost } from "../src/security.js";

test("requestOriginMatchesHost only accepts same-host origins", () => {
  const req = { headers: { host: "127.0.0.1:8080" } };
  assert.equal(requestOriginMatchesHost(req, "http://127.0.0.1:8080"), true);
  assert.equal(requestOriginMatchesHost(req, "https://evil.example.com"), false);
  assert.equal(requestOriginMatchesHost(req, "not-a-url"), false);
});
