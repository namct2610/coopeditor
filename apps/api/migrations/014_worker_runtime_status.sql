CREATE TABLE IF NOT EXISTS worker_runtime_status (
  worker_id       TEXT PRIMARY KEY,
  hostname        TEXT NOT NULL DEFAULT '',
  pid             INTEGER NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT '',
  hwaccel         TEXT NOT NULL DEFAULT '',
  codec_ladder    TEXT NOT NULL DEFAULT '',
  dsm_mount_root  TEXT NOT NULL DEFAULT '',
  mount_ready     BOOLEAN NOT NULL DEFAULT FALSE,
  mount_error     TEXT,
  app_data_dir    TEXT NOT NULL DEFAULT '',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_runtime_status_updated_idx
  ON worker_runtime_status(updated_at DESC);
