-- Up Migration
ALTER TABLE collections ADD COLUMN featured_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE collections DROP COLUMN featured_at;
