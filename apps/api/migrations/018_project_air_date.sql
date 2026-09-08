-- Air date (scheduled broadcast date) at the PROJECT level: one date per project
-- drives when all of its videos air. ISO "YYYY-MM-DD" TEXT, nullable.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS air_date TEXT;
CREATE INDEX IF NOT EXISTS projects_air_date_idx ON projects(air_date);
