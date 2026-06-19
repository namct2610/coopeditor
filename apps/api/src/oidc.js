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

import { createHash, createPublicKey, randomBytes, verify as verifySignature, constants as cryptoConstants } from "node:crypto";
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
let jwksCache = new Map();
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
function decodeBase64UrlJson(part, label) {
  try {
    return JSON.parse(Buffer.from(String(part || ""), "base64url").toString("utf8"));
  } catch (_) {
    throw new Error("Invalid " + label + " segment");
  }
}

function decodeBase64UrlBuffer(part, label) {
  try {
    return Buffer.from(String(part || ""), "base64url");
  } catch (_) {
    throw new Error("Invalid " + label + " segment");
  }
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid id_token format");
  return {
    header: decodeBase64UrlJson(parts[0], "JWT header"),
    payload: decodeBase64UrlJson(parts[1], "JWT payload"),
    signature: decodeBase64UrlBuffer(parts[2], "JWT signature"),
    signingInput: Buffer.from(parts[0] + "." + parts[1]),
  };
}

function pickVerifyOptions(alg, key) {
  switch (alg) {
    case "RS256": return { algorithm: "RSA-SHA256", key };
    case "RS384": return { algorithm: "RSA-SHA384", key };
    case "RS512": return { algorithm: "RSA-SHA512", key };
    case "PS256": return { algorithm: "sha256", key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST };
    case "PS384": return { algorithm: "sha384", key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST };
    case "PS512": return { algorithm: "sha512", key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST };
    default: return null;
  }
}

async function getJwks(jwksUri) {
  if (!jwksUri) throw new Error("OIDC discovery missing jwks_uri");
  const cached = jwksCache.get(jwksUri);
  if (cached && (Date.now() - cached.at) < 10 * 60_000) return cached.keys;
  const r = await fetch(jwksUri, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("JWKS fetch failed: HTTP " + r.status);
  const body = await r.json();
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  if (!keys.length) throw new Error("OIDC issuer returned empty JWKS");
  jwksCache.set(jwksUri, { at: Date.now(), keys });
  return keys;
}

export async function verifyIdToken(token, { issuer, clientId, jwksUri, jwks } = {}) {
  const parsed = parseJwt(token);
  const header = parsed.header || {};
  const claims = parsed.payload || {};
  const tokenIssuer = String(claims.iss || "");
  const expectedIssuer = String(issuer || "").trim();
  if (!expectedIssuer || tokenIssuer !== expectedIssuer) {
    throw new Error("id_token issuer mismatch");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud].filter(Boolean);
  if (!clientId || !audiences.includes(clientId)) {
    throw new Error("id_token audience mismatch");
  }
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || Number(claims.exp) <= now - 30) {
    throw new Error("id_token expired");
  }
  if (claims.nbf && Number(claims.nbf) > now + 30) {
    throw new Error("id_token not active yet");
  }
  const allKeys = Array.isArray(jwks) ? jwks : await getJwks(jwksUri);
  const jwk = allKeys.find((candidate) => candidate
    && candidate.kty === "RSA"
    && (!header.kid || candidate.kid === header.kid)
    && (!candidate.use || candidate.use === "sig"));
  if (!jwk) throw new Error("No matching OIDC signing key");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const verifyOptions = pickVerifyOptions(String(header.alg || ""), key);
  if (!verifyOptions) throw new Error("Unsupported OIDC signing algorithm: " + String(header.alg || "unknown"));
  const ok = verifySignature(
    verifyOptions.algorithm,
    parsed.signingInput,
    verifyOptions.padding
      ? { key: verifyOptions.key, padding: verifyOptions.padding, saltLength: verifyOptions.saltLength }
      : verifyOptions.key,
    parsed.signature,
  );
  if (!ok) throw new Error("Invalid OIDC token signature");
  if (!claims.sub) throw new Error("id_token missing sub claim");
  return claims;
}

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
  const claims = await verifyIdToken(tokens.id_token, {
    issuer: cfg.issuer || ISSUER,
    clientId: CLIENT_ID,
    jwksUri: cfg.jwks_uri,
  });
  return {
    issuer: cfg.issuer || ISSUER,
    sub: claims.sub,
    email: claims.email,
    name: claims.name || claims.preferred_username || (claims.email ? claims.email.split("@")[0] : "User"),
    emailVerified: !!claims.email_verified,
    raw: claims,
  };
}

export function callbackUrl() { return PUBLIC_URL; }
