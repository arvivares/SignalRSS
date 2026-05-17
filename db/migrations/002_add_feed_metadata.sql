ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS validation_status TEXT,
  ADD COLUMN IF NOT EXISTS frequency_status TEXT;

CREATE INDEX IF NOT EXISTS idx_feeds_country
  ON feeds (country);
