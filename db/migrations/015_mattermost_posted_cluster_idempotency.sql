CREATE UNIQUE INDEX IF NOT EXISTS idx_mattermost_notifications_posted_cluster_destination
  ON mattermost_notifications (cluster_id, locale, briefing_type, destination_hash)
  WHERE status = 'posted';
