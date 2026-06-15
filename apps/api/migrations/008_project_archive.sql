-- Soft-archive for projects: archived projects are hidden from the default
-- workspace listing but recoverable via POST /projects/:id/restore.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS projects_archived_idx ON projects(archived_at) WHERE archived_at IS NOT NULL;
