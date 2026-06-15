import test from "node:test";
import assert from "node:assert/strict";

async function loadProxyModule(envPatch) {
  const previous = {};
  for (const [key, value] of Object.entries(envPatch)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import(`../src/hls-proxy.js?test=${Date.now()}-${Math.random()}`);
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return mod;
}

test("rewritePlaylistBody swaps relative segments for signed CDN URLs", async () => {
  const mod = await loadProxyModule({
    HLS_CDN_PUBLIC_URL: "https://cdn.example.com/api/hls",
    HLS_CDN_SIGNING_SECRET: "test-secret-123",
    HLS_CDN_TOKEN_TTL_SECONDS: "300",
  });
  const body = "#EXTM3U\n#EXTINF:4,\nseg_0001.ts\n#EXT-X-ENDLIST\n";
  const rewritten = mod.rewritePlaylistBody(body, "rid_720p");
  assert.match(rewritten, /^#EXTM3U/m);
  assert.match(rewritten, /https:\/\/cdn\.example\.com\/api\/hls\/rid_720p\/seg_0001\.ts\?exp=\d+&sig=[a-f0-9]+/);
});

test("hasValidSignedPlaybackToken accepts the token minted for a segment", async () => {
  const mod = await loadProxyModule({
    HLS_CDN_PUBLIC_URL: "https://cdn.example.com/api/hls",
    HLS_CDN_SIGNING_SECRET: "test-secret-456",
    HLS_CDN_TOKEN_TTL_SECONDS: "300",
  });
  const exp = String(Math.floor(Date.now() / 1000) + 120);
  const sig = mod.createSignedPlaybackToken("rid_720p", "seg_0001.ts", "test-secret-456", exp);
  const params = new URLSearchParams({ exp, sig });
  assert.equal(mod.hasValidSignedPlaybackToken("rid_720p", "seg_0001.ts", params), true);
  assert.equal(mod.hasValidSignedPlaybackToken("rid_720p", "seg_0002.ts", params), false);
});
