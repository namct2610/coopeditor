-- See ../migrations/021_final_video.sql. Allowed kind values are enforced in
-- server.js (SQLite can't add a CHECK via ALTER).
ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'source';
ALTER TABLE projects ADD COLUMN air_confirmed_at TEXT;
ALTER TABLE projects ADD COLUMN air_confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
