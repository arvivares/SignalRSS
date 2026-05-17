CREATE TABLE IF NOT EXISTS cluster_impact_scores (
  cluster_id UUID PRIMARY KEY REFERENCES story_clusters(id) ON DELETE CASCADE,
  impact_level TEXT NOT NULL CHECK (impact_level IN ('P0', 'P1', 'P2', 'P3')),
  impact_score INTEGER NOT NULL CHECK (impact_score BETWEEN 0 AND 100),
  impact_category TEXT NOT NULL CHECK (
    impact_category IN (
      'breakthrough',
      'business',
      'infrastructure',
      'product',
      'policy',
      'security-risk',
      'developer-impact',
      'societal-impact',
      'research',
      'market',
      'noise'
    )
  ),
  summary TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  impact_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cluster_impact_scores_level_score
  ON cluster_impact_scores (impact_level, impact_score DESC, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_impact_scores_score
  ON cluster_impact_scores (impact_score DESC, scored_at DESC);

CREATE TABLE IF NOT EXISTS impact_scoring_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  category_slug TEXT,
  clusters_considered INTEGER NOT NULL DEFAULT 0,
  clusters_scored INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
