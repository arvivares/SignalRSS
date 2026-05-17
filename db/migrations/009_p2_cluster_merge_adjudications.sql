CREATE TABLE IF NOT EXISTS p2_cluster_merge_adjudications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input_hash TEXT NOT NULL UNIQUE,
  pair_type TEXT NOT NULL,
  category_slug TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_p2_cluster_merge_adjudications_decision
  ON p2_cluster_merge_adjudications (pair_type, decision, confidence DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_p2_cluster_merge_adjudications_clusters
  ON p2_cluster_merge_adjudications (left_cluster_id, right_cluster_id, created_at DESC);
