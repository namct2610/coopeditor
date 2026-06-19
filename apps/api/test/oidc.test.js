import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { verifyIdToken } from "../src/oidc.js";

function createJwt({ claims, privateKey, kid = "kid-1", alg = "RS256" }) {
  const header = { alg, typ: "JWT", kid };
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = head + "." + body;
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return input + "." + signature;
}

test("verifyIdToken accepts a valid RS256 token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "kid-1";
  jwk.use = "sig";
  const issuer = "https://issuer.example.com";
  const clientId = "coopeditor-web";
  const token = createJwt({
    privateKey,
    claims: {
      iss: issuer,
      aud: clientId,
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "user@example.com",
    },
  });

  const claims = await verifyIdToken(token, { issuer, clientId, jwks: [jwk] });
  assert.equal(claims.sub, "user-123");
  assert.equal(claims.email, "user@example.com");
});

test("verifyIdToken rejects audience mismatch", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "kid-1";
  const issuer = "https://issuer.example.com";
  const token = createJwt({
    privateKey,
    claims: {
      iss: issuer,
      aud: "some-other-client",
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 300,
    },
  });

  await assert.rejects(
    () => verifyIdToken(token, { issuer, clientId: "coopeditor-web", jwks: [jwk] }),
    /audience mismatch/i,
  );
});

test("verifyIdToken rejects invalid signature", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { publicKey: wrongPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = wrongPublicKey.export({ format: "jwk" });
  jwk.kid = "kid-1";
  const issuer = "https://issuer.example.com";
  const clientId = "coopeditor-web";
  const token = createJwt({
    privateKey,
    claims: {
      iss: issuer,
      aud: clientId,
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 300,
    },
  });

  await assert.rejects(
    () => verifyIdToken(token, { issuer, clientId, jwks: [jwk] }),
    /signature/i,
  );
});
