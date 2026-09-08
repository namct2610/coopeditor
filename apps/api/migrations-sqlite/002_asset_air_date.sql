ALTER TABLE assets ADD COLUMN air_date TEXT;
CREATE INDEX IF NOT EXISTS assets_air_date_idx ON assets(air_date);
