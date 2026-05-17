CREATE TABLE IF NOT EXISTS cluster_impact_jobs (
  cluster_id UUID PRIMARY KEY REFERENCES story_clusters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cluster_impact_jobs_status_updated
  ON cluster_impact_jobs (status, updated_at ASC);

CREATE INDEX IF NOT EXISTS idx_cluster_impact_jobs_locked
  ON cluster_impact_jobs (status, locked_at ASC)
  WHERE status = 'running';
