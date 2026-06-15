-- Retry/backoff fields on transcode_jobs.
ALTER TABLE transcode_jobs
  ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 'queued' jobs are eligible when next_run_at <= now()
CREATE INDEX IF NOT EXISTS transcode_jobs_ready_idx ON transcode_jobs(status, next_run_at);
