import test from "node:test";
import assert from "node:assert/strict";

import { parseCookies, isSecureRequest, cookieSetHeader, cookieClearHeader } from "../src/sessions.js";

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

test("isSecureRequest trusts x-forwarded-proto over the socket", () => {
  // DSM's reverse proxy terminates TLS then forwards over http: the socket is
  // not encrypted but x-forwarded-proto says https → cookie must be Secure.
  assert.equal(isSecureRequest({ headers: { "x-forwarded-proto": "https" }, socket: {} }), true);
  assert.equal(isSecureRequest({ headers: { "x-forwarded-proto": "https, http" }, socket: {} }), true);
  // Plain LAN access over http → not Secure, so the browser keeps the cookie.
  assert.equal(isSecureRequest({ headers: { "x-forwarded-proto": "http" }, socket: {} }), false);
  assert.equal(isSecureRequest({ headers: {}, socket: {} }), false);
  // Direct TLS socket with no proxy header still counts as https.
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(isSecureRequest({ headers: { "x-forwarded-ssl": "on" }, socket: {} }), true);
});

test("cookieSetHeader adds Secure only when the request is https", () => {
  assert.ok(cookieSetHeader("tok", 3600, true).includes("; Secure"));
  assert.ok(!cookieSetHeader("tok", 3600, false).includes("Secure"));
  assert.ok(cookieClearHeader(true).includes("; Secure"));
  assert.ok(!cookieClearHeader(false).includes("Secure"));
});
