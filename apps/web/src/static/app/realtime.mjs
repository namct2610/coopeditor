// Live updates: WebSocket first (presence heartbeat rides the same socket),
// SSE as fallback. Events only invalidate what's on screen; the store
// debounces refetches so a transcode burst doesn't hammer the API.

import { API_BASE, post } from "./api.mjs";
import {
  S, set, loadSources, loadComments, loadRenditions, patchRenditionLocal, refreshProjects, refreshQueue,
} from "./store.mjs";

let ws = null, sse = null, beat = null, reconnect = null, stopped = true;

export function currentFocus() {
  const r = S.route;
  if (r.name === "review") return { kind: "source", id: r.aid, projectId: r.pid };
  if (r.name === "project") return { kind: "project", id: r.pid };
  if (r.name === "script" || r.name === "prompter") return { kind: "script", id: r.sid };
  return { kind: "workspace" };
}

export function sendPresence() {
  if (!S.me) return;
  const focus = currentFocus();
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: "presence", focus })); return; } catch (_) {} }
  post("/presence", { focus }).catch(() => {});
}

function handle(ev) {
  if (!ev || !ev.type) return;
  const r = S.route;
  switch (ev.type) {
    case "presence":
      set({ presence: ev.users || [] });
      break;
    case "rendition": {
      if (ev.assetVersionId && S.renditions[ev.assetVersionId]) {
        patchRenditionLocal(ev.assetVersionId, ev.id, { status: ev.status, progress: ev.progress });
        if (ev.status === "ready" || ev.status === "failed") loadRenditions(ev.assetVersionId);
      }
      if (ev.projectId && S.sources[ev.projectId]) loadSources(ev.projectId, ev.status === "ready" || ev.status === "failed" ? 150 : 1200);
      break;
    }
    case "asset":
      if (ev.projectId && S.sources[ev.projectId]) loadSources(ev.projectId, 150);
      refreshProjects(600);
      refreshQueue();
      break;
    case "comment": {
      const c = ev.comment || {};
      if (c.assetVersionId && S.comments[c.assetVersionId]) loadComments(c.assetVersionId, 120);
      const viewing = (r.name === "project" || r.name === "review") && r.pid === ev.projectId;
      if (ev.projectId && !viewing && ev.action === "created" && c.authorUserId !== (S.me && S.me.id)) {
        set({ notif: { ...S.notif, [ev.projectId]: (S.notif[ev.projectId] || 0) + 1 } });
      }
      if (ev.projectId && S.sources[ev.projectId]) loadSources(ev.projectId, 400);
      refreshProjects(800);
      break;
    }
    default:
  }
}

function openSse() {
  if (sse) return;
  try {
    sse = new EventSource(API_BASE + "/events", { withCredentials: true });
    sse.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (_) {} };
  } catch (_) {}
}

function openWs() {
  const base = API_BASE.startsWith("http") ? API_BASE.replace(/^http/, "ws") : location.origin.replace(/^http/, "ws") + API_BASE;
  let opened = false;
  try { ws = new WebSocket(base.replace(/\/+$/, "") + "/ws"); }
  catch (_) { openSse(); return; }
  ws.onopen = () => { opened = true; sendPresence(); };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (_) {} };
  ws.onclose = () => {
    ws = null;
    if (stopped) return;
    if (!opened) { openSse(); return; }
    clearTimeout(reconnect);
    reconnect = setTimeout(() => { if (!stopped) openWs(); }, 3000);
  };
}

export function startRealtime() {
  if (!stopped) return;
  stopped = false;
  openWs();
  clearInterval(beat);
  beat = setInterval(sendPresence, 25_000);
}

export function stopRealtime() {
  stopped = true;
  clearInterval(beat); clearTimeout(reconnect);
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  if (sse) { sse.close(); sse = null; }
  if (S.me) fetch(API_BASE + "/presence", { method: "DELETE", credentials: "include" }).catch(() => {});
}

window.addEventListener("pagehide", () => { if (S.me && navigator.sendBeacon) navigator.sendBeacon(API_BASE + "/presence?leave=1"); });
