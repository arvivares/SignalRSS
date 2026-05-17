ALTER TABLE cluster_impact_scores
  ADD COLUMN IF NOT EXISTS evidence_confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (evidence_confidence IN ('low', 'medium', 'high')),
  ADD COLUMN IF NOT EXISTS evidence_quality_score INTEGER NOT NULL DEFAULT 50
    CHECK (evidence_quality_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS evidence_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_cluster_impact_scores_evidence_confidence
  ON cluster_impact_scores (evidence_confidence, impact_level, impact_score DESC);
