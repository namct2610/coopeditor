-- Air date (scheduled publish/broadcast date) for a source video. Stored as a
-- plain ISO "YYYY-MM-DD" TEXT (not DATE) so it round-trips as a string without
-- node-pg's Date-object + timezone conversions, and range/order still work
-- lexicographically on ISO dates. Nullable = unscheduled.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS air_date TEXT;
CREATE INDEX IF NOT EXISTS assets_air_date_idx ON assets(air_date);
