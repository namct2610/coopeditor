-- SQLite consolidated schema. Mirrors the cumulative state of the 16 Postgres
-- migrations under ../migrations as of commit 7ec8a9d.
--
-- Dialect notes (Postgres → SQLite):
--   * TIMESTAMPTZ → TEXT (ISO 8601 strings). DEFAULT now() → DEFAULT (datetime('now')).
--   * BOOLEAN → INTEGER (0/1). FALSE → 0, TRUE → 1.
--   * JSONB → TEXT. Code parses with JSON.parse on read.
--   * text[] / int[] → not used in this schema, so no mapping needed here.
--   * BIGSERIAL → INTEGER PRIMARY KEY (rowid alias, auto-increments).
--   * gen_random_uuid() is never called in SQL — IDs come from crypto.randomUUID() in JS.
--   * Partial indexes (WHERE clause) → SQLite supports these natively.
--   * Foreign keys require `PRAGMA foreign_keys = ON` — set in db-sqlite.js init.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  initial     TEXT NOT NULL,
  color       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('editor','client')),
  dsm_uid     INTEGER,
  email       TEXT,
  oidc_sub    TEXT,
  oidc_issuer TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_dsm_uid_idx
  ON users(dsm_uid) WHERE dsm_uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_sub_idx
  ON users(oidc_issuer, oidc_sub) WHERE oidc_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('progress','done','published')),
  client      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT 'vừa xong',
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS projects_archived_idx
  ON projects(archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_team (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','editor','reviewer','client')),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user_idx
  ON project_members(user_id, project_id);

CREATE TABLE IF NOT EXISTS assets (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  nas_path         TEXT NOT NULL,
  codec            TEXT NOT NULL DEFAULT 'ProRes 422',
  size_label       TEXT NOT NULL DEFAULT '—',
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  frame_rate       INTEGER NOT NULL DEFAULT 24,
  width_px         INTEGER NOT NULL DEFAULT 0,
  height_px        INTEGER NOT NULL DEFAULT 0,
  resolution_label TEXT NOT NULL DEFAULT '',
  mime_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('ready','processing','pending','failed')),
  progress         INTEGER NOT NULL DEFAULT 0,
  palette_a        TEXT NOT NULL DEFAULT '#15171c',
  palette_b        TEXT NOT NULL DEFAULT '#3a4453',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS assets_project_position_idx
  ON assets(project_id, position);

CREATE TABLE IF NOT EXISTS asset_versions (
  id             TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label          TEXT NOT NULL,
  note           TEXT,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asset_id, version_number)
);

CREATE TABLE IF NOT EXISTS renditions (
  id               TEXT PRIMARY KEY,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  height           INTEGER NOT NULL CHECK (height IN (540,720,1080)),
  label            TEXT NOT NULL,
  bitrate_kbps     INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('ready','processing','pending','failed')),
  progress         INTEGER NOT NULL DEFAULT 0,
  hls_master_url   TEXT,
  UNIQUE (asset_version_id, height)
);

CREATE TABLE IF NOT EXISTS comments (
  id               TEXT PRIMARY KEY,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  author_user_id   TEXT NOT NULL REFERENCES users(id),
  content          TEXT NOT NULL,
  timestamp_ms     INTEGER NOT NULL DEFAULT 0,
  frame_number     INTEGER,
  resolved         INTEGER NOT NULL DEFAULT 0,
  parent_id        TEXT REFERENCES comments(id) ON DELETE CASCADE,
  deleted_at       TEXT,
  annotation       TEXT,
  guest_label      TEXT,
  guest_initial    TEXT,
  guest_color      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS comments_version_idx
  ON comments(asset_version_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS comments_deleted_idx
  ON comments(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS transcode_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  enqueued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at  TEXT NOT NULL DEFAULT (datetime('now')),
  error        TEXT
);
CREATE INDEX IF NOT EXISTS transcode_jobs_status_idx
  ON transcode_jobs(status, enqueued_at);
CREATE INDEX IF NOT EXISTS transcode_jobs_ready_idx
  ON transcode_jobs(status, next_run_at);
CREATE UNIQUE INDEX IF NOT EXISTS transcode_jobs_active_rendition_idx
  ON transcode_jobs(rendition_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dsm_sid    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  payload       TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_log_project_idx
  ON audit_log(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx
  ON audit_log(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS share_links (
  token         TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id      TEXT REFERENCES assets(id) ON DELETE CASCADE,
  access_level  TEXT NOT NULL DEFAULT 'review' CHECK (access_level IN ('review','comment')),
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  password_hash TEXT,
  guest_label   TEXT
);
CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id);
CREATE INDEX IF NOT EXISTS share_links_expiry_idx
  ON share_links(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS project_templates (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  source_project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  default_client     TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS project_templates_source_idx
  ON project_templates(source_project_id);

CREATE TABLE IF NOT EXISTS worker_runtime_status (
  worker_id      TEXT PRIMARY KEY,
  hostname       TEXT NOT NULL DEFAULT '',
  pid            INTEGER NOT NULL DEFAULT 0,
  mode           TEXT NOT NULL DEFAULT '',
  hwaccel        TEXT NOT NULL DEFAULT '',
  codec_ladder   TEXT NOT NULL DEFAULT '',
  dsm_mount_root TEXT NOT NULL DEFAULT '',
  mount_ready    INTEGER NOT NULL DEFAULT 0,
  mount_error    TEXT,
  app_data_dir   TEXT NOT NULL DEFAULT '',
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS worker_runtime_status_updated_idx
  ON worker_runtime_status(updated_at DESC);
