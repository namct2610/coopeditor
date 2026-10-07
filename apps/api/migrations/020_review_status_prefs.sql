-- Coopeditor v2: per-video review workflow + per-user UI preferences.
--
-- review_status is the editorial state of a video (separate from `status`,
-- which tracks proxy transcode): edit = Đang dựng, wait = Chờ review,
-- fix = Cần sửa, ok = Đã duyệt, air = Đã lên sóng. review_status_by/at record
-- who moved it last so the "Chờ bạn review" queue can say "gửi bởi … · 8 phút".
ALTER TABLE assets ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'edit';
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_review_status_check;
ALTER TABLE assets ADD CONSTRAINT assets_review_status_check CHECK (review_status IN ('edit','wait','fix','ok','air'));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS review_status_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS review_status_at TEXT;
CREATE INDEX IF NOT EXISTS assets_review_status_idx ON assets(review_status);

-- Theme / accent / default list view, as a JSON object string. Follows the
-- account across devices (Cài đặt → Giao diện).
ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs TEXT NOT NULL DEFAULT '{}';
