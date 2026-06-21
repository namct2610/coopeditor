// WebSocket fanout layer running alongside SSE.
// Same payload shape as events.js — frontend code chooses one transport.
//
// Client → server: { type: "presence", focus: {...} } | { type: "ping" }
// Server → client: same shape as SSE: { type: "rendition", ... } | { type: "comment", ... }
//
// Auth is enforced at upgrade time: only requests with a valid session cookie pass.

import { COOKIE_NAME, getSession, parseCookies } from "./sessions.js";
import { logger } from "./logger.js";
import * as presence from "./presence.js";
import * as store from "./store-index.js";
import { isOriginAllowed, requestOriginMatchesHost } from "./security.js";

let wssPromise = null;
const subscribers = new Set(); // { ws, userId }

async function getWss() {
  if (wssPromise) return wssPromise;
  wssPromise = (async () => {
    const mod = await import("ws");
    const { WebSocketServer } = mod;
    return new WebSocketServer({ noServer: true });
  })();
  return wssPromise;
}

export async function attachWebSocket(server) {
  const wss = await getWss();
  server.on("upgrade", async (req, socket, head) => {
    if (req.url !== "/ws") return; // let other upgrade handlers handle non-WS
    const origin = String(req.headers.origin || "").trim();
    if (origin && !isOriginAllowed(origin, requestOriginMatchesHost(req, origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const cookies = parseCookies(req.headers.cookie || "");
    const sess = await getSession(cookies[COOKIE_NAME]);
    if (!sess) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sub = { ws, userId: sess.userId };
      subscribers.add(sub);
      ws.send(JSON.stringify({ type: "hello", at: Date.now() }));
      ws.on("message", (data) => handleClientMessage(sub, data));
      ws.on("close", () => { subscribers.delete(sub); presence.leave(sess.userId); });
      ws.on("error", (err) => logger.warn({ err: err.message }, "ws error"));
    });
  });
  logger.info({}, "ws ready at /ws");
}

async function handleClientMessage(sub, data) {
  let msg;
  try { msg = JSON.parse(String(data)); }
  catch { return; }
  if (!msg || !msg.type) return;
  if (msg.type === "ping") { try { sub.ws.send(JSON.stringify({ type: "pong", at: Date.now() })); } catch (_) {} return; }
  if (msg.type === "presence") {
    const user = await store.getUser(sub.userId);
    if (user) presence.touch(user, msg.focus || null);
    return;
  }
}

function canReceive(sub, event) {
  if (event.userId && event.userId !== sub.userId) return false;
  if (Array.isArray(event.userIds) && !event.userIds.includes(sub.userId)) return false;
  return true;
}

export function publish(event) {
  const payload = JSON.stringify(event);
  for (const s of subscribers) {
    if (!canReceive(s, event)) continue;
    try { s.ws.send(payload); } catch (_) {}
  }
}

export function subscriberCount() { return subscribers.size; }
