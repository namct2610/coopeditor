CREATE TABLE IF NOT EXISTS project_templates (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  source_project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  default_client     TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_templates_source_idx ON project_templates(source_project_id);
