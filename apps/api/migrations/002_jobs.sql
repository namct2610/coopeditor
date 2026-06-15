-- Transcode job queue. The API enqueues here; the worker claims rows with
-- SELECT ... FOR UPDATE SKIP LOCKED so multiple workers can run in parallel.

CREATE TABLE IF NOT EXISTS transcode_jobs (
  id           BIGSERIAL PRIMARY KEY,
  rendition_id TEXT NOT NULL REFERENCES renditions(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS transcode_jobs_status_idx ON transcode_jobs(status, enqueued_at);
