import test from "node:test";
import assert from "node:assert/strict";

import { isTrustedMutationRequest, isOriginAllowed } from "../src/security.js";

test("isOriginAllowed keeps same-host fallback for alternate public URLs", () => {
  const reqOrigin = "https://review.example.com";
  assert.equal(isOriginAllowed(reqOrigin, true), true);
});

test("isTrustedMutationRequest rejects explicit cross-site mutation origin", () => {
  const req = {
    headers: {
      origin: "https://evil.example.com",
      host: "review.example.com",
    },
  };
  assert.equal(isTrustedMutationRequest(req), false);
});

test("isTrustedMutationRequest rejects cross-site sec-fetch-site without origin", () => {
  const req = {
    headers: {
      host: "review.example.com",
      "sec-fetch-site": "cross-site",
    },
  };
  assert.equal(isTrustedMutationRequest(req), false);
});

test("isTrustedMutationRequest accepts same-host referer fallback", () => {
  const req = {
    headers: {
      referer: "https://review.example.com/projects/p1",
      host: "review.example.com",
    },
  };
  assert.equal(isTrustedMutationRequest(req), true);
});
