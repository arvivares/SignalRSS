CREATE TABLE IF NOT EXISTS mattermost_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id UUID NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  briefing_type TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  destination_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  error TEXT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cluster_id, locale, briefing_type, input_hash, destination_hash)
);

CREATE INDEX IF NOT EXISTS idx_mattermost_notifications_status
  ON mattermost_notifications (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mattermost_notifications_cluster
  ON mattermost_notifications (cluster_id, briefing_type, locale);
