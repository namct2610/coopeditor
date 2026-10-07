-- Final video: the cut assembled from a project's sources, delivered for
-- approval before it airs. Each delivery is its own asset (kind = 'final'),
-- so earlier rounds keep their notes and proxies.
--
-- Air date: projects.air_date is the planned date; air_confirmed_at/by are
-- set when the project owner approves the final and confirms the date, and
-- cleared again when a new final is delivered.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'source';
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_kind_check;
ALTER TABLE assets ADD CONSTRAINT assets_kind_check CHECK (kind IN ('source','final'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS air_confirmed_at TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS air_confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
