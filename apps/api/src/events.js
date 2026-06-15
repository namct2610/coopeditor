// Server-Sent Events fanout. Subscribers are registered per HTTP request;
// publishers (worker, comment writes) call publish(event) and every open
// subscriber gets a `data: <json>\n\n` frame.

const subscribers = new Set();
let heartbeatTimer = null;

export function subscribe(req, res, userId) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no"); // disable nginx buffering if proxied
  res.write("retry: 3000\n\n");

  const sub = { res, userId };
  subscribers.add(sub);

  // greet so client knows connection is live
  publishOne(sub, { type: "hello", at: Date.now() });

  req.on("close", () => { subscribers.delete(sub); try { res.end(); } catch (_) {} });

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const s of subscribers) { try { s.res.write(": ping\n\n"); } catch (_) {} }
    }, 25_000);
    heartbeatTimer.unref && heartbeatTimer.unref();
  }
}

function publishOne(sub, event) { try { sub.res.write("data: " + JSON.stringify(event) + "\n\n"); } catch (_) {} }

function canReceive(sub, event) {
  if (event.userId && event.userId !== sub.userId) return false;
  if (Array.isArray(event.userIds) && !event.userIds.includes(sub.userId)) return false;
  return true;
}

let wsPublish = null;
export function bindWsPublish(fn) { wsPublish = fn; }

export function publish(event) {
  for (const s of subscribers) {
    if (!canReceive(s, event)) continue;
    publishOne(s, event);
  }
  if (wsPublish) {
    try { wsPublish(event); } catch (_) {}
  }
}

export function subscriberCount() { return subscribers.size; }
