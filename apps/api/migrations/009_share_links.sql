-- Time-bound, scoped public review links.
-- token is the URL fragment; access_level defines what the link allows.

CREATE TABLE IF NOT EXISTS share_links (
  token         TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id      TEXT REFERENCES assets(id) ON DELETE CASCADE,
  access_level  TEXT NOT NULL DEFAULT 'review' CHECK (access_level IN ('review','comment')),
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  password_hash TEXT,
  guest_label   TEXT
);
CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id);
CREATE INDEX IF NOT EXISTS share_links_expiry_idx ON share_links(expires_at) WHERE revoked_at IS NULL;
