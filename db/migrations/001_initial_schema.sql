CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  timezone_gmt TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  etag TEXT,
  last_modified TEXT,
  last_fetch_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_status TEXT NOT NULL DEFAULT 'pending',
  last_http_status INTEGER,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guid TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  author TEXT,
  published_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash TEXT NOT NULL,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS feed_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_guid TEXT,
  source_url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (feed_id, article_id)
);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  http_status INTEGER,
  error TEXT,
  items_found INTEGER NOT NULL DEFAULT 0,
  items_inserted INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_guid_unique
  ON articles (guid)
  WHERE guid IS NOT NULL AND guid <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_canonical_url_unique
  ON articles (canonical_url)
  WHERE canonical_url IS NOT NULL AND canonical_url <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_content_hash_unique
  ON articles (content_hash);

CREATE INDEX IF NOT EXISTS idx_articles_published_at_desc
  ON articles (published_at DESC NULLS LAST, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_feeds_enabled
  ON feeds (enabled)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_fetch_runs_feed_started
  ON fetch_runs (feed_id, started_at DESC);
