-- Kịch bản (scripts): workspace-level rich-text documents, optionally linked to
-- a project. `version` is bumped on every save and drives optimistic
-- concurrency (PATCH with a stale version → 409, so two editors can't silently
-- overwrite each other). Timestamps are ISO strings written by the app so pg
-- and SQLite return the same shape.
CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','approved')),
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT REFERENCES users(id),
  updated_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scripts_updated_idx ON scripts(updated_at);
CREATE INDEX IF NOT EXISTS scripts_project_idx ON scripts(project_id);

-- Comments work like Google Docs: a thread root may be anchored to a span of
-- the body (the editor wraps it in <span data-comment-id="…">, `quote` keeps
-- the text it was made on so the thread still reads when that text is
-- deleted). Replies point at their root via parent_id; resolve is per thread.
CREATE TABLE IF NOT EXISTS script_comments (
  id              TEXT PRIMARY KEY,
  script_id       TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES script_comments(id) ON DELETE CASCADE,
  author_user_id  TEXT NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  quote           TEXT,
  resolved        INTEGER NOT NULL DEFAULT 0,
  resolved_by     TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS script_comments_script_idx ON script_comments(script_id, created_at);
