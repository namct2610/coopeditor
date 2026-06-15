// Per-user "what are you looking at right now" so the team can see who's where.
// State is still in-process, but presence fanout now goes through the cluster event bus.

import { publishEvent } from "./event-bus.js";

// userId -> { name, initial, color, focus: {kind, id}, lastSeen }
const live = new Map();

const STALE_MS = 90_000;

export function touch(user, focus) {
  if (!user) return;
  live.set(user.id, {
    id: user.id, name: user.name, initial: user.initial, color: user.color,
    focus, lastSeen: Date.now(),
  });
  fanout();
}

export function leave(userId) {
  if (!live.delete(userId)) return;
  fanout();
}

function fanout() {
  // drop stale
  const now = Date.now();
  for (const [id, p] of live) if (now - p.lastSeen > STALE_MS) live.delete(id);
  publishEvent({ type: "presence", users: [...live.values()] });
}

export function snapshot() {
  const now = Date.now();
  return [...live.values()].filter((p) => now - p.lastSeen <= STALE_MS);
}

// periodic sweep so silent disconnects fall off
setInterval(() => fanout(), 30_000).unref?.();
