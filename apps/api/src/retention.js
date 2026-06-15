// Periodic cleanup. Three sweeps:
//   1. Hard-delete audit_log rows older than AUDIT_RETENTION_DAYS (default 365).
//   2. Hard-delete projects archived more than PROJECT_PURGE_DAYS ago (default 90).
//   3. Hard-delete comments soft-deleted more than COMMENT_PURGE_DAYS ago (default 30).
//
// Default cadence is once per hour. Memory mode: only step 3 against the in-memory
// comments map (so dev mode still feels right).

import { db } from "./db.js";
import { logger } from "./logger.js";
import { comments as memComments, projects as memProjects } from "./store.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const AUDIT_DAYS = clampInt(process.env.AUDIT_RETENTION_DAYS, 365, 1, 36500);
const PROJECT_DAYS = clampInt(process.env.PROJECT_PURGE_DAYS, 90, 1, 3650);
const COMMENT_DAYS = clampInt(process.env.COMMENT_PURGE_DAYS, 30, 1, 3650);
const SWEEP_INTERVAL_MS = clampInt(process.env.RETENTION_SWEEP_MINUTES, 60, 5, 1440) * 60_000;

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let timer = null;

export async function sweepOnce() {
  if (process.env.DATABASE_URL) return sweepPg();
  return sweepMemory();
}

async function sweepPg() {
  const pool = db();
  if (!pool) return { audit: 0, projects: 0, comments: 0 };
  let audit = 0, projects = 0, comments = 0;
  try {
    audit = (await pool.query(
      `DELETE FROM audit_log WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(AUDIT_DAYS)],
    )).rowCount || 0;
  } catch (err) { logger.error({ err: err.message }, "audit retention sweep failed"); }
  try {
    projects = (await pool.query(
      `DELETE FROM projects WHERE archived_at IS NOT NULL AND archived_at < now() - ($1 || ' days')::interval`,
      [String(PROJECT_DAYS)],
    )).rowCount || 0;
  } catch (err) { logger.error({ err: err.message }, "project purge sweep failed"); }
  try {
    comments = (await pool.query(
      `DELETE FROM comments WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1 || ' days')::interval`,
      [String(COMMENT_DAYS)],
    )).rowCount || 0;
  } catch (err) { logger.error({ err: err.message }, "comment purge sweep failed"); }
  if (audit || projects || comments) {
    logger.info({ audit, projects, comments, audit_days: AUDIT_DAYS, project_days: PROJECT_DAYS, comment_days: COMMENT_DAYS }, "retention sweep done");
  }
  return { audit, projects, comments };
}

function sweepMemory() {
  const projectThreshold = Date.now() - PROJECT_DAYS * DAY_MS;
  const commentThreshold = Date.now() - COMMENT_DAYS * DAY_MS;
  let projects = 0, comments = 0;
  for (const [id, c] of memComments) {
    if (c.deletedAt && new Date(c.deletedAt).getTime() < commentThreshold) {
      memComments.delete(id);
      comments++;
    }
  }
  for (const [id, p] of memProjects) {
    if (p.archivedAt && new Date(p.archivedAt).getTime() < projectThreshold) {
      memProjects.delete(id);
      projects++;
    }
  }
  if (projects || comments) logger.info({ projects, comments }, "memory retention sweep");
  return { audit: 0, projects, comments };
}

export function startRetention() {
  if (timer) return;
  const tick = () => sweepOnce().catch((err) => logger.error({ err: err.message }, "retention sweep crashed"));
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
  // Defer first run a few seconds so server boot doesn't compete with migrations.
  setTimeout(tick, 5_000).unref?.();
  logger.info({
    audit_days: AUDIT_DAYS, project_days: PROJECT_DAYS, comment_days: COMMENT_DAYS,
    sweep_minutes: SWEEP_INTERVAL_MS / 60_000,
  }, "retention scheduler started");
}

export function stopRetention() { if (timer) clearInterval(timer); timer = null; }

export const config = {
  auditRetentionDays: AUDIT_DAYS,
  projectPurgeDays: PROJECT_DAYS,
  commentPurgeDays: COMMENT_DAYS,
  sweepIntervalMs: SWEEP_INTERVAL_MS,
};
