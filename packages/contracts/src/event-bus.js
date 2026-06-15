import { randomUUID } from "node:crypto";

export const PG_EVENT_CHANNEL = "frame_editor_events";
export const REDIS_STREAM_KEY_DEFAULT = "frame_editor_events";

export function resolveEventBusDriver(env = process.env) {
  const configured = (env.EVENT_BUS_DRIVER || "").trim().toLowerCase();
  if (configured === "redis" || configured === "redis-streams") return "redis-streams";
  if (configured === "pg" || configured === "postgres" || configured === "postgres-listen") return "pg";
  if (configured === "none" || configured === "memory" || configured === "off") return "none";
  if (env.REDIS_URL) return "redis-streams";
  if (env.DATABASE_URL) return "pg";
  return "none";
}

export function makeEventBusNodeId(prefix = "api") {
  return `${prefix}-${randomUUID()}`;
}

export function createClusterEnvelope(event, sourceNodeId) {
  return {
    sourceNodeId,
    emittedAt: Date.now(),
    event,
  };
}

export function parseClusterEnvelope(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || !parsed.event) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseRedisStreamRows(response) {
  if (!Array.isArray(response)) return [];
  const out = [];
  for (const stream of response) {
    if (!Array.isArray(stream) || stream.length < 2 || !Array.isArray(stream[1])) continue;
    for (const message of stream[1]) {
      if (!Array.isArray(message) || message.length < 2 || !Array.isArray(message[1])) continue;
      const id = message[0];
      const fields = {};
      for (let i = 0; i < message[1].length; i += 2) {
        fields[message[1][i]] = message[1][i + 1];
      }
      out.push({ id, fields });
    }
  }
  return out;
}
