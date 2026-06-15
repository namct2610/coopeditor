// OIDC SSO using the Authorization Code flow with PKCE.
// Works with Google, Keycloak, Auth0, Okta, Azure AD — anything that exposes
// /.well-known/openid-configuration.
//
// Env:
//   OIDC_ISSUER_URL=https://accounts.google.com
//   OIDC_CLIENT_ID=...
//   OIDC_CLIENT_SECRET=...
//   OIDC_REDIRECT_URI=https://your-domain/api/auth/oidc/callback
//   OIDC_SCOPES=openid email profile (default)
//
// The flow:
//   1. FE → /auth/oidc/start → 302 to IdP authorize URL
//   2. IdP → /auth/oidc/callback?code=... → we exchange for id_token, create session, 302 to PUBLIC_URL
//
// State + PKCE are stored in a short-lived in-memory map keyed by `state`.

import { createHash, randomBytes } from "node:crypto";
import { logger } from "./logger.js";

const ISSUER = (process.env.OIDC_ISSUER_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.OIDC_CLIENT_ID || "";
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "";
const SCOPES = process.env.OIDC_SCOPES || "openid email profile";
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");

const pending = new Map(); // state -> { codeVerifier, createdAt }
const PENDING_TTL_MS = 10 * 60_000;
setInterval(() => { const cut = Date.now() - PENDING_TTL_MS; for (const [k, v] of pending) if (v.createdAt < cut) pending.delete(k); }, 60_000).unref?.();

let discoveryPromise = null;
async function discover() {
  if (!ISSUER) return null;
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      try {
        const r = await fetch(ISSUER + "/.well-known/openid-configuration");
        if (!r.ok) throw new Error("discovery HTTP " + r.status);
        return await r.json();
      } catch (err) {
        logger.error({ err: err.message, issuer: ISSUER }, "OIDC discovery failed");
        discoveryPromise = null;
        return null;
      }
    })();
  }
  return discoveryPromise;
}

export function enabled() { return !!(ISSUER && CLIENT_ID && CLIENT_SECRET && REDIRECT_URI); }

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function challengeFromVerifier(v) { return b64url(createHash("sha256").update(v).digest()); }

export async function startUrl() {
  const cfg = await discover();
  if (!cfg) throw new Error("OIDC issuer not reachable");
  const state = b64url(randomBytes(18));
  const codeVerifier = b64url(randomBytes(32));
  pending.set(state, { codeVerifier, createdAt: Date.now() });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challengeFromVerifier(codeVerifier),
    code_challenge_method: "S256",
  });
  return cfg.authorization_endpoint + "?" + params.toString();
}

export async function exchange(code, state) {
  const cfg = await discover();
  if (!cfg) throw new Error("OIDC issuer not reachable");
  const slot = pending.get(state);
  if (!slot) throw new Error("Invalid or expired state");
  pending.delete(state);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: slot.codeVerifier,
  });
  const r = await fetch(cfg.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error("Token exchange failed: " + r.status + " " + text.slice(0, 200));
  }
  const tokens = await r.json();
  if (!tokens.id_token) throw new Error("No id_token in token response");
  const claims = decodeIdToken(tokens.id_token);
  if (!claims.sub) throw new Error("id_token missing sub claim");
  return {
    issuer: cfg.issuer || ISSUER,
    sub: claims.sub,
    email: claims.email,
    name: claims.name || claims.preferred_username || (claims.email ? claims.email.split("@")[0] : "User"),
    emailVerified: !!claims.email_verified,
    raw: claims,
  };
}

// NOTE: we trust the issuer because we just fetched id_token from the
// discovery-authenticated token_endpoint over TLS — full JWT signature
// verification would need JWKS handling; acceptable trade-off for now.
function decodeIdToken(token) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

export function callbackUrl() { return PUBLIC_URL; }
