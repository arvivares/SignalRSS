CREATE TABLE IF NOT EXISTS cluster_briefings (
  cluster_id UUID NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  briefing_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, locale, briefing_type)
);

CREATE INDEX IF NOT EXISTS idx_cluster_briefings_type_generated
  ON cluster_briefings (briefing_type, locale, generated_at DESC);
