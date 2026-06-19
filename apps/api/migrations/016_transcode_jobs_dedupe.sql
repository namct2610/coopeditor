-- Prevent multiple active jobs for the same rendition. Older duplicates are
-- marked failed so the worker/runtime UI reflects why they were skipped.

WITH ranked AS (
  SELECT id,
         rendition_id,
         ROW_NUMBER() OVER (
           PARTITION BY rendition_id
           ORDER BY
             CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
             COALESCE(started_at, enqueued_at, finished_at) DESC NULLS LAST,
             id DESC
         ) AS rn
    FROM transcode_jobs
   WHERE status IN ('queued', 'running')
)
UPDATE transcode_jobs job
   SET status = 'failed',
       error = COALESCE(NULLIF(job.error, ''), 'Duplicate active transcode job was superseded by a newer claim.'),
       finished_at = COALESCE(job.finished_at, now())
  FROM ranked
 WHERE ranked.id = job.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS transcode_jobs_active_rendition_idx
  ON transcode_jobs (rendition_id)
  WHERE status IN ('queued', 'running');
