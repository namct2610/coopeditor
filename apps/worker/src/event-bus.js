import {
  PG_EVENT_CHANNEL,
  REDIS_STREAM_KEY_DEFAULT,
  createClusterEnvelope,
  makeEventBusNodeId,
  resolveEventBusDriver,
} from "../../../packages/contracts/src/event-bus.js";

const driver = resolveEventBusDriver(process.env);
const nodeId = process.env.EVENT_BUS_NODE_ID || makeEventBusNodeId("worker");
const streamKey = process.env.EVENT_BUS_STREAM_KEY || REDIS_STREAM_KEY_DEFAULT;
const streamMaxLen = String(Math.max(1000, Number.parseInt(process.env.EVENT_BUS_STREAM_MAXLEN || "10000", 10) || 10000));

let redisPublisher = null;

export async function startWorkerEventBus() {
  if (driver !== "redis-streams") return;
  if (!process.env.REDIS_URL) {
    console.warn("[worker] redis event bus selected without REDIS_URL; falling back to local-only publish");
    return;
  }
  const { createClient } = await import("redis");
  redisPublisher = createClient({ url: process.env.REDIS_URL });
  redisPublisher.on("error", (err) => console.error("[worker] redis publisher error:", err.message));
  await redisPublisher.connect();
  console.log("[worker] event bus driver=" + driver + " stream_key=" + streamKey + " node_id=" + nodeId);
}

export async function stopWorkerEventBus() {
  if (!redisPublisher) return;
  try { await redisPublisher.quit(); } catch (_) { try { redisPublisher.destroy(); } catch (_) {} }
  redisPublisher = null;
}

export async function publishWorkerEvent(pool, event) {
  const payload = JSON.stringify(createClusterEnvelope(event, nodeId));
  if (driver === "redis-streams" && redisPublisher) {
    await redisPublisher.sendCommand([
      "XADD",
      streamKey,
      "MAXLEN",
      "~",
      streamMaxLen,
      "*",
      "payload",
      payload,
    ]);
    return;
  }
  if (driver !== "pg") return;
  await pool.query(`SELECT pg_notify($1, $2)`, [PG_EVENT_CHANNEL, payload]);
}

export function workerEventBusMode() {
  return driver;
}
