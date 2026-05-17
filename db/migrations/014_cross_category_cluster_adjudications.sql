CREATE TABLE IF NOT EXISTS cross_category_cluster_adjudications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input_hash TEXT NOT NULL UNIQUE,
  pair_type TEXT NOT NULL,
  left_category_slug TEXT NOT NULL,
  right_category_slug TEXT NOT NULL,
  left_cluster_id UUID,
  right_cluster_id UUID,
  target_cluster_id UUID,
  source_cluster_id UUID,
  left_impact_level TEXT NOT NULL,
  right_impact_level TEXT NOT NULL,
  left_title TEXT NOT NULL,
  right_title TEXT NOT NULL,
  centroid_similarity NUMERIC(8, 6) NOT NULL,
  max_article_similarity NUMERIC(8, 6) NOT NULL,
  decision TEXT NOT NULL,
  confidence NUMERIC(4, 3) NOT NULL,
  rationale TEXT NOT NULL,
  matched_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  merged BOOLEAN NOT NULL DEFAULT FALSE,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cross_category_cluster_adjudications_categories
  ON cross_category_cluster_adjudications (left_category_slug, right_category_slug, decision, confidence DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cross_category_cluster_adjudications_clusters
  ON cross_category_cluster_adjudications (left_cluster_id, right_cluster_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cross_category_cluster_adjudications_decision
  ON cross_category_cluster_adjudications (decision, confidence DESC, created_at DESC);
