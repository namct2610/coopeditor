ALTER TABLE projects ADD COLUMN air_date TEXT;
CREATE INDEX IF NOT EXISTS projects_air_date_idx ON projects(air_date);
