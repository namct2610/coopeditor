-- See ../migrations/020_review_status_prefs.sql. SQLite can't add a CHECK via
-- ALTER, so the allowed review_status values are enforced in server.js.
ALTER TABLE assets ADD COLUMN review_status TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE assets ADD COLUMN review_status_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN review_status_at TEXT;
CREATE INDEX IF NOT EXISTS assets_review_status_idx ON assets(review_status);
ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
