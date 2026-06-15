-- Soft-delete for comments. DELETE in the API stamps deleted_at instead of dropping
-- the row; admins can restore via POST /comments/:id/restore.

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS comments_deleted_idx ON comments(deleted_at) WHERE deleted_at IS NOT NULL;
