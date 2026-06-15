-- Frame Editor schema v1
-- Run via: pnpm --filter @frame-editor/api migrate

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  initial    TEXT NOT NULL,
  color      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('editor','client')),
  dsm_uid    INTEGER UNIQUE,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('progress','done','published')),
  client     TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT 'vừa xong',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_team (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','reviewer','client')),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id, project_id);

CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  nas_path       TEXT NOT NULL,
  codec          TEXT NOT NULL DEFAULT 'ProRes 422',
  size_label     TEXT NOT NULL DEFAULT '—',
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  frame_rate     INTEGER NOT NULL DEFAULT 24,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('ready','processing','pending','failed')),
  progress       INTEGER NOT NULL DEFAULT 0,
  palette_a      TEXT NOT NULL DEFAULT '#15171c',
  palette_b      TEXT NOT NULL DEFAULT '#3a4453',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_project_position_idx ON assets(project_id, position);

CREATE TABLE IF NOT EXISTS asset_versions (
  id             TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label          TEXT NOT NULL,
  note           TEXT,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version_number)
);

CREATE TABLE IF NOT EXISTS renditions (
  id                TEXT PRIMARY KEY,
  asset_version_id  TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  height            INTEGER NOT NULL CHECK (height IN (540,720,1080)),
  label             TEXT NOT NULL,
  bitrate_kbps      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('ready','processing','pending','failed')),
  progress          INTEGER NOT NULL DEFAULT 0,
  hls_master_url    TEXT,
  UNIQUE (asset_version_id, height)
);

CREATE TABLE IF NOT EXISTS comments (
  id                TEXT PRIMARY KEY,
  asset_version_id  TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  author_user_id    TEXT NOT NULL REFERENCES users(id),
  content           TEXT NOT NULL,
  timestamp_ms      INTEGER NOT NULL DEFAULT 0,
  frame_number      INTEGER,
  resolved          BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id         TEXT REFERENCES comments(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_version_idx ON comments(asset_version_id, timestamp_ms);
