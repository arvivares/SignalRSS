CREATE TABLE IF NOT EXISTS news_swipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id UUID REFERENCES story_clusters(id) ON DELETE SET NULL,
  story_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('interested', 'dismissed')),
  locale TEXT NOT NULL DEFAULT 'es',
  briefing_type TEXT NOT NULL,
  category_slug TEXT,
  impact_level TEXT,
  impact_score INTEGER,
  impact_category TEXT,
  title TEXT,
  summary TEXT,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_published_at TIMESTAMPTZ,
  swiped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (story_hash, locale)
);

CREATE INDEX IF NOT EXISTS idx_news_swipes_action_swiped
  ON news_swipes (action, swiped_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_swipes_cluster
  ON news_swipes (cluster_id);
