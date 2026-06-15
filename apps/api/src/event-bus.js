import {
  PG_EVENT_CHANNEL,
  REDIS_STREAM_KEY_DEFAULT,
  createClusterEnvelope,
  makeEventBusNodeId,
  parseClusterEnvelope,
  parseRedisStreamRows,
  resolveEventBusDriver,
} from "../../../packages/contracts/src/event-bus.js";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { publish as publishLocal } from "./events.js";

const driver = resolveEventBusDriver(process.env);
const nodeId = process.env.EVENT_BUS_NODE_ID || makeEventBusNodeId("api");
const streamKey = process.env.EVENT_BUS_STREAM_KEY || REDIS_STREAM_KEY_DEFAULT;
const streamMaxLen = String(Math.max(1000, Number.parseInt(process.env.EVENT_BUS_STREAM_MAXLEN || "10000", 10) || 10000));

let pgClient = null;
let redisPublisher = null;
let redisConsumer = null;
let redisLoopPromise = null;
let redisStop = false;

function handleClusterEnvelope(envelope) {
  if (!envelope || envelope.sourceNodeId === nodeId) return;
  publishLocal(envelope.event);
}

async function publishPg(event) {
  if (!process.env.DATABASE_URL) return;
  await db().query(`SELECT pg_notify($1, $2)`, [PG_EVENT_CHANNEL, JSON.stringify(createClusterEnvelope(event, nodeId))]);
}

async function startPgBus() {
  if (!process.env.DATABASE_URL) return;
  const mod = await import("pg");
  const pg = mod.default || mod;
  pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();
  pgClient.on("notification", (msg) => {
    if (msg.channel !== PG_EVENT_CHANNEL) return;
    handleClusterEnvelope(parseClusterEnvelope(msg.payload || ""));
  });
  pgClient.on("error", (err) => logger.error({ err: err.message }, "pg event bus client error"));
  await pgClient.query(`LISTEN ${PG_EVENT_CHANNEL}`);
  logger.info({ driver, channel: PG_EVENT_CHANNEL, node_id: nodeId }, "event bus ready");
}

async function startRedisBus() {
  if (!process.env.REDIS_URL) {
    logger.warn({ driver }, "redis event bus selected without REDIS_URL; cluster fanout disabled");
    return;
  }
  const { createClient } = await import("redis");
  redisPublisher = createClient({ url: process.env.REDIS_URL });
  redisConsumer = createClient({ url: process.env.REDIS_URL });
  redisPublisher.on("error", (err) => logger.error({ err: err.message }, "redis publisher error"));
  redisConsumer.on("error", (err) => logger.error({ err: err.message }, "redis consumer error"));
  await redisPublisher.connect();
  await redisConsumer.connect();
  redisStop = false;
  redisLoopPromise = runRedisLoop().catch((err) => logger.error({ err: err.message }, "redis event loop stopped"));
  logger.info({ driver, stream_key: streamKey, node_id: nodeId }, "event bus ready");
}

async function runRedisLoop() {
  let lastId = "$";
  while (!redisStop) {
    const response = await redisConsumer.sendCommand([
      "XREAD",
      "BLOCK",
      "5000",
      "COUNT",
      "50",
      "STREAMS",
      streamKey,
      lastId,
    ]).catch((err) => {
      logger.error({ err: err.message }, "redis xread failed");
      return null;
    });
    for (const row of parseRedisStreamRows(response)) {
      lastId = row.id;
      handleClusterEnvelope(parseClusterEnvelope(row.fields.payload));
    }
  }
}

async function publishRedis(event) {
  if (!redisPublisher) return;
  await redisPublisher.sendCommand([
    "XADD",
    streamKey,
    "MAXLEN",
    "~",
    streamMaxLen,
    "*",
    "payload",
    JSON.stringify(createClusterEnvelope(event, nodeId)),
  ]);
}

export async function startEventBus() {
  if (driver === "pg") return startPgBus();
  if (driver === "redis-streams") return startRedisBus();
  logger.info({ driver, node_id: nodeId }, "event bus disabled");
}

export async function stopEventBus() {
  redisStop = true;
  if (pgClient) { try { await pgClient.end(); } catch (_) {} pgClient = null; }
  if (redisConsumer) { try { await redisConsumer.destroy(); } catch (_) {} redisConsumer = null; }
  if (redisPublisher) { try { await redisPublisher.quit(); } catch (_) { try { redisPublisher.destroy(); } catch (_) {} } redisPublisher = null; }
  if (redisLoopPromise) { try { await redisLoopPromise; } catch (_) {} redisLoopPromise = null; }
}

export function publishEvent(event) {
  publishLocal(event);
  if (driver === "pg") publishPg(event).catch((err) => logger.error({ err: err.message }, "failed to publish pg cluster event"));
  if (driver === "redis-streams") publishRedis(event).catch((err) => logger.error({ err: err.message }, "failed to publish redis cluster event"));
}

export function eventBusMode() {
  return driver;
}
